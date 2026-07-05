const path = require("node:path");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const utc = require("dayjs/plugin/utc");

dayjs.extend(customParseFormat);
dayjs.extend(utc);

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const LOG_DIR = path.join(ROOT_DIR, "logs");

const TEAM_ALIASES = new Map([
  ["springboks", "south africa"],
  ["all blacks", "new zealand"],
  ["barbarian fc", "barbarians"],
  ["england xv", "england"],
  ["new zealand xv", "new zealand"],
  ["south africa xv", "south africa"],
  ["hong kong", "hong kong china"],
  ["los pumas", "argentina"]
]);

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(rugby|union)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return TEAM_ALIASES.get(normalized) ?? normalized;
}

function normalizeCompetition(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHumanDate(value) {
  const clean = normalizeWhitespace(value).replace(/\.$/, "");
  if (!clean) return null;

  const formats = ["ddd MMM D, YYYY", "ddd MMM DD, YYYY", "YYYY-MM-DD", "YYYY|M|D", "YYYY|MM|DD"];

  for (const format of formats) {
    const parsed = dayjs.utc(clean, format, true);
    if (parsed.isValid()) {
      return parsed.format("YYYY-MM-DD");
    }
  }

  const fallback = dayjs.utc(clean);
  return fallback.isValid() ? fallback.format("YYYY-MM-DD") : null;
}

function parseKickoff(value) {
  const clean = normalizeWhitespace(value).toLowerCase();
  if (!clean || clean === "tbc") return "";

  const parsed = dayjs(clean, ["h:mma", "h:mm a", "HH:mm", "H:mm"], true);
  if (!parsed.isValid()) return "";
  return parsed.format("HH:mm");
}

function toNumberOrEmpty(value) {
  if (value === null || value === undefined || value === "") return "";
  const num = Number(String(value).trim());
  return Number.isFinite(num) ? String(num) : "";
}

function buildFixtureKey({ competition, homeTeam, awayTeam, date }) {
  return [
    normalizeCompetition(competition),
    normalizeName(homeTeam),
    normalizeName(awayTeam),
    normalizeWhitespace(date)
  ].join("|");
}

async function retryWithBackoff(action, { retries = 3, initialDelayMs = 600 } = {}) {
  let attempt = 0;
  let lastError;

  while (attempt < retries) {
    try {
      return await action(attempt + 1);
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= retries) break;
      const delay = initialDelayMs * (2 ** (attempt - 1));
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNowIso() {
  return new Date().toISOString();
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  LOG_DIR,
  normalizeWhitespace,
  normalizeName,
  normalizeCompetition,
  parseHumanDate,
  parseKickoff,
  toNumberOrEmpty,
  buildFixtureKey,
  retryWithBackoff,
  sleep,
  formatNowIso
};
