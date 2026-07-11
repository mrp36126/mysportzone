#!/usr/bin/env node

const path = require("node:path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
const {
  DATA_DIR,
  LOG_DIR,
  normalizeWhitespace,
  parseHumanDate,
  retryWithBackoff,
  formatNowIso
} = require("./helpers.js");
const { Logger } = require("./logger.js");
const {
  extractInitialDateToken,
  parseMatchesFromGameDayHtml,
  parseMatchesFromFullPageHtml
} = require("./parser.js");
const { matchAndUpdateFixtures } = require("./matcher.js");
const {
  RESULT_CHECK_INTERVAL_MINUTES,
  RESULT_CHECK_WINDOW_HOURS,
  hasKickoffStarted,
  isWithinPollingWindow,
  hasFinalResult
} = require("./rugby-result-polling.js");

const SOURCE_URL = "https://rugby365.com/results/";
const FIXTURES_CSV = path.join(DATA_DIR, "rugby_fixtures.csv");
const OUTPUT_JSON = path.join(DATA_DIR, "rugby-results.json");
const OUTPUT_CSV = path.join(DATA_DIR, "rugby_results.csv");
const DEBUG_HTML = path.join(LOG_DIR, "rugby365-debug-page.html");
const DEBUG_SCREENSHOT = path.join(LOG_DIR, "rugby365-error.png");
const RESULTS_CSV_HEADERS = ["Date", "HomeTeam", "HomeScore", "AwayScore", "AwayTeam", "Competition", "KickOffTimeSAST"];

main().catch(async error => {
  console.error(`[${formatNowIso()}] [FATAL] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const started = Date.now();
  const logger = new Logger(path.join(LOG_DIR, "scraper.log"));
  await logger.init();

  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(LOG_DIR);

  const fixtures = await loadFixtures(FIXTURES_CSV);
  if (fixtures.length === 0) {
    throw new Error("No fixtures found in data/rugby_fixtures.csv.");
  }

  await logger.info(`Loaded fixtures: ${fixtures.length}`);

  const existingRecords = await loadExistingRecords(OUTPUT_JSON);
  const currentTime = new Date();
  const fixturesToPoll = getFixturesToPoll({ fixtures, existingRecords, currentTime });

  await logger.info(
    `Polling plan: interval=${RESULT_CHECK_INTERVAL_MINUTES}m, window=${RESULT_CHECK_WINDOW_HOURS}h, eligible_fixtures=${fixturesToPoll.length}`
  );

  let matches = [];
  let snapshotHtml = "";

  if (fixturesToPoll.length > 0) {
    const scraped = await scrapeRugby365(logger);
    matches = scraped.matches;
    snapshotHtml = scraped.snapshotHtml;
    await logger.info(`Scraped Rugby365 fixtures: ${matches.length}`);
  } else {
    await logger.info("No fixtures within kickoff polling window. Skipping Rugby365 network requests for this run.");
  }

  const { updatedRecords, stats } = matchAndUpdateFixtures({
    fixtures,
    scrapedMatches: matches,
    existingRecords,
    logger,
    currentTime
  });

  if (updatedRecords.length !== fixtures.length) {
    throw new Error(`Invariant violated: output rows (${updatedRecords.length}) differ from fixture rows (${fixtures.length}).`);
  }

  const jsonChanged = await writeIfChanged(OUTPUT_JSON, updatedRecords);
  const csvSyncStats = await syncResultsCsvFromJson(updatedRecords, OUTPUT_CSV);
  await logger.info(`JSON updated: ${jsonChanged ? "yes" : "no"}`);
  await logger.info(
    `CSV sync: changed=${csvSyncStats.changed ? "yes" : "no"}, inserted=${csvSyncStats.inserted}, score_updates=${csvSyncStats.scoreUpdates}, rows=${csvSyncStats.totalRows}`
  );

  const tookMs = Date.now() - started;
  await logger.info(`Successful updates: ${stats.successfulUpdates}`);
  await logger.info(`Pre-kickoff skipped: ${stats.preKickoffSkipped}`);
  await logger.info(`Outside polling window skipped: ${stats.outsideWindowSkipped}`);
  await logger.info(`Fixtures checked in polling window: ${stats.pendingResultChecks}`);
  await logger.info(`Unmatched fixtures: ${stats.unmatchedFixtures}`);
  await logger.info(`Ambiguous matches: ${stats.ambiguousMatches}`);
  await logger.info(`Skipped fixtures: ${stats.skippedFixtures}`);
  await logger.info(`Execution time: ${tookMs}ms`);

  // Keep latest page payload for troubleshooting if parser logic ever regresses.
  await fs.writeFile(DEBUG_HTML, snapshotHtml || "", "utf8");
}

function getFixturesToPoll({ fixtures, existingRecords, currentTime }) {
  const existingByKey = new Map(
    existingRecords.map(record => [fixtureKey(record), record])
  );

  return fixtures.filter(fixture => {
    const existing = existingByKey.get(fixtureKey(fixture));
    if (existing && hasFinalResult(existing)) return false;
    if (!hasKickoffStarted(fixture, currentTime)) return false;
    if (!isWithinPollingWindow(fixture, currentTime)) return false;
    return true;
  });
}

async function scrapeRugby365(logger) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: "Africa/Johannesburg" });
  const page = await context.newPage();

  try {
    await retryWithBackoff(async attempt => {
      await logger.info(`Opening Rugby365 results page (attempt ${attempt}/3)`);
      await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 });
    }, { retries: 3, initialDelayMs: 1000 });

    const pageHtml = await page.content();
    const token = extractInitialDateToken(pageHtml);

    const endpoint = await detectResultsEndpoint(page, pageHtml);
    await logger.info(`Detected Rugby365 endpoint: ${endpoint}`);

    let matches = [];
    if (endpoint && token) {
      matches = await scrapeViaEndpoint(page, endpoint, token, logger);
    }

    if (matches.length === 0) {
      await logger.warn("Endpoint scrape returned no matches; falling back to full-page parser.");
      matches = parseMatchesFromFullPageHtml(pageHtml);
    }

    return { matches, snapshotHtml: pageHtml };
  } catch (error) {
    await logger.error(`Scraping failed: ${error.message}`);
    await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true });
    await fs.writeFile(DEBUG_HTML, await page.content(), "utf8");
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function detectResultsEndpoint(page, pageHtml) {
  const bundleUrlMatch = pageHtml.match(/<script[^>]+src="([^"]*load-js\?bundle=fixtures-results[^"]*)"/i);
  if (bundleUrlMatch?.[1]) {
    const bundleUrl = new URL(bundleUrlMatch[1], page.url()).toString();
    const response = await page.request.get(bundleUrl, { timeout: 20000 });
    if (response.ok()) {
      const js = await response.text();
      const usesResultActions = /action:\s*'load-today'/.test(js) && /action:\s*'load-more'/.test(js);
      if (usesResultActions) {
        return new URL("/results", page.url()).toString();
      }
    }
  }

  return new URL("/results", page.url()).toString();
}

async function scrapeViaEndpoint(page, endpoint, dateToken, logger) {
  const gameDayBlocks = [];

  const loadToday = await postJson(page, endpoint, {
    action: "load-today",
    index: "0",
    date: dateToken,
    isContent: "1",
    json: "1"
  });

  if (loadToday?.content?.gameDays) {
    if (Array.isArray(loadToday.content.gameDays)) {
      gameDayBlocks.push(...loadToday.content.gameDays);
    } else {
      gameDayBlocks.push(loadToday.content.gameDays);
    }
  }

  for (let index = 1; index <= 12; index += 1) {
    const payload = await postJson(page, endpoint, {
      action: "load-more",
      index: String(index),
      date: dateToken,
      isContent: "1",
      json: "1"
    });

    const hasGames = payload?.content?.hasGames;
    const chunks = Array.isArray(payload?.content?.gameDays)
      ? payload.content.gameDays
      : [];

    if (chunks.length === 0 && !hasGames) {
      break;
    }

    gameDayBlocks.push(...chunks);
  }

  await logger.info(`Collected game-day blocks: ${gameDayBlocks.length}`);

  const matches = gameDayBlocks.flatMap(html => parseMatchesFromGameDayHtml(html, "endpoint"));
  return dedupe(matches);
}

async function postJson(page, url, form) {
  const response = await retryWithBackoff(async () => {
    const res = await page.request.post(url, {
      form,
      timeout: 25000,
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });

    if (!res.ok()) {
      throw new Error(`HTTP ${res.status()} for ${url}`);
    }

    return res;
  }, { retries: 3, initialDelayMs: 600 });

  return response.json();
}

function dedupe(matches) {
  const byKey = new Map();
  for (const match of matches) {
    const key = [
      normalizeWhitespace(match.competition),
      normalizeWhitespace(match.homeTeam),
      normalizeWhitespace(match.awayTeam),
      normalizeWhitespace(parseHumanDate(match.matchDate) || match.matchDate),
      normalizeWhitespace(match.externalId)
    ].join("|");

    if (!byKey.has(key)) {
      byKey.set(key, match);
    }
  }

  return [...byKey.values()];
}

async function loadFixtures(filePath) {
  const csv = await fs.readFile(filePath, "utf8");
  const rows = parseCsv(csv);

  return rows.map(row => ({
    Date: normalizeWhitespace(row.Date),
    HomeTeam: normalizeWhitespace(row.HomeTeam),
    AwayTeam: normalizeWhitespace(row.AwayTeam),
    Venue: normalizeWhitespace(row.Venue),
    Competition: normalizeWhitespace(row.Competition),
    KickOffTime: normalizeWhitespace(row.KickOffTime)
  }));
}

async function loadExistingRecords(filePath) {
  if (!(await fs.pathExists(filePath))) return [];

  const raw = await fs.readFile(filePath, "utf8");
  if (!normalizeWhitespace(raw)) return [];

  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeIfChanged(filePath, rows) {
  const next = `${JSON.stringify(rows, null, 2)}\n`;
  const current = (await fs.pathExists(filePath)) ? await fs.readFile(filePath, "utf8") : "";

  if (current === next) return false;
  await fs.writeFile(filePath, next, "utf8");
  return true;
}

async function syncResultsCsvFromJson(updatedRecords, csvPath) {
  const existingRows = await loadExistingResultsCsv(csvPath);
  const finalResultKeys = new Set(
    updatedRecords
      .filter(record => hasFinalResult(record))
      .map(record => resultKey(record.MatchDate, record.HomeTeam, record.AwayTeam))
  );
  const filteredExistingRows = existingRows.filter(row => finalResultKeys.has(resultKey(row.Date, row.HomeTeam, row.AwayTeam)));
  const rowByKey = new Map(filteredExistingRows.map(row => [resultKey(row.Date, row.HomeTeam, row.AwayTeam), row]));

  let inserted = 0;
  let scoreUpdates = 0;

  for (const record of updatedRecords) {
    if (!hasFinalResult(record)) continue;

    const homeScore = normalizeWhitespace(record.HomeScore);
    const awayScore = normalizeWhitespace(record.AwayScore);

    const row = {
      Date: normalizeWhitespace(record.MatchDate),
      HomeTeam: normalizeWhitespace(record.HomeTeam),
      HomeScore: homeScore,
      AwayScore: awayScore,
      AwayTeam: normalizeWhitespace(record.AwayTeam),
      Competition: normalizeWhitespace(record.Competition),
      KickOffTimeSAST: normalizeWhitespace(record.KickOffTime)
    };

    const key = resultKey(row.Date, row.HomeTeam, row.AwayTeam);
    const existing = rowByKey.get(key);

    if (existing) {
      if (existing.HomeScore !== row.HomeScore || existing.AwayScore !== row.AwayScore) {
        existing.HomeScore = row.HomeScore;
        existing.AwayScore = row.AwayScore;
        scoreUpdates += 1;
      }
    } else {
      filteredExistingRows.push(row);
      rowByKey.set(key, row);
      inserted += 1;
    }
  }

  filteredExistingRows.sort((a, b) => {
    const dateTimeA = `${normalizeWhitespace(a.Date)} ${normalizeSortTime(a.KickOffTimeSAST)}`;
    const dateTimeB = `${normalizeWhitespace(b.Date)} ${normalizeSortTime(b.KickOffTimeSAST)}`;
    return dateTimeB.localeCompare(dateTimeA);
  });

  const hasRowCountDelta = existingRows.length !== filteredExistingRows.length;
  const hasScoreDelta = inserted > 0 || scoreUpdates > 0 || hasRowCountDelta;
  const changed = hasScoreDelta
    ? await writeCsvIfChanged(csvPath, RESULTS_CSV_HEADERS, filteredExistingRows)
    : false;
  return { changed, inserted, scoreUpdates, totalRows: filteredExistingRows.length };
}

async function loadExistingResultsCsv(filePath) {
  if (!(await fs.pathExists(filePath))) return [];
  const csv = await fs.readFile(filePath, "utf8");
  const rows = parseCsv(csv);

  return rows.map(row => ({
    Date: normalizeWhitespace(row.Date),
    HomeTeam: normalizeWhitespace(row.HomeTeam),
    HomeScore: normalizeWhitespace(row.HomeScore),
    AwayScore: normalizeWhitespace(row.AwayScore),
    AwayTeam: normalizeWhitespace(row.AwayTeam),
    Competition: normalizeWhitespace(row.Competition),
    KickOffTimeSAST: normalizeWhitespace(row.KickOffTimeSAST)
  }));
}

function resultKey(date, homeTeam, awayTeam) {
  return [normalizeWhitespace(date), normalizeWhitespace(homeTeam).toLowerCase(), normalizeWhitespace(awayTeam).toLowerCase()].join("|");
}

function fixtureKey(row) {
  return [
    normalizeWhitespace(row.Date || row.MatchDate),
    normalizeWhitespace(row.HomeTeam).toLowerCase(),
    normalizeWhitespace(row.AwayTeam).toLowerCase()
  ].join("|");
}

function normalizeSortTime(value) {
  const time = normalizeWhitespace(value);
  return /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, "0") : "00:00";
}

async function writeCsvIfChanged(filePath, headers, rows) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map(header => escapeCsvField(row[header] ?? "")).join(","));
  }

  const next = `${lines.join("\n")}\n`;
  const current = (await fs.pathExists(filePath)) ? await fs.readFile(filePath, "utf8") : "";
  if (current === next) return false;

  await fs.writeFile(filePath, next, "utf8");
  return true;
}

function escapeCsvField(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(input) {
  const lines = input.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = splitCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = fields[idx] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}
