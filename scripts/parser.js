const cheerio = require("cheerio");
const { normalizeWhitespace, parseHumanDate, parseKickoff, toNumberOrEmpty } = require("./helpers.js");

function extractInitialDateToken(pageHtml) {
  const byInlineConfig = pageHtml.match(/FixturesResultsView\.date\s*=\s*"([0-9|]+)"/i);
  if (byInlineConfig?.[1]) return byInlineConfig[1];

  const byCalendarData = pageHtml.match(/data-date="(\d{4}\|\d{2}\|\d{2})"[^>]*data-dir="same"/i);
  if (byCalendarData?.[1]) return byCalendarData[1];

  return null;
}

function parseMatchesFromGameDayHtml(gameDayHtml, source = "unknown") {
  const markup = Array.isArray(gameDayHtml)
    ? gameDayHtml.filter(Boolean).join("\n")
    : String(gameDayHtml ?? "");

  const $ = cheerio.load(markup);
  const matches = [];

  const dayRoots = discoverDayRoots($);
  for (const root of dayRoots) {
    const dayNode = $(root);
    const dayDate = parseHumanDate(dayNode.find("> .date").first().text());
    const competitionNodes = dayNode.find("> .comp").toArray();

    for (const compNode of competitionNodes) {
      const comp = $(compNode);
      const competition = normalizeWhitespace(comp.find("h2").first().text());
      const gameNodes = discoverGameNodes(comp);

      for (const gameNode of gameNodes) {
        const parsed = parseSingleGame($, gameNode, { competition, dayDate, source });
        if (parsed) {
          matches.push(parsed);
        }
      }
    }
  }

  return dedupeMatches(matches);
}

function parseMatchesFromFullPageHtml(pageHtml) {
  const $ = cheerio.load(pageHtml);
  const blocks = [];

  $(".games-list .games-list-item").each((_, el) => {
    blocks.push($.html(el));
  });

  if (blocks.length === 0) {
    return parseMatchesFromGameDayHtml(pageHtml, "fallback-page");
  }

  return dedupeMatches(blocks.flatMap(block => parseMatchesFromGameDayHtml(block, "page-block")));
}

function discoverDayRoots($) {
  const roots = $(".games-list-item").toArray();
  if (roots.length > 0) return roots;

  const byDateHeader = $("div")
    .filter((_, el) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4}$/.test(normalizeWhitespace($(el).text())))
    .closest(".games-list-item")
    .toArray();

  return byDateHeader.length > 0 ? byDateHeader : [$.root()];
}

function discoverGameNodes(comp) {
  const selectorCandidates = [
    ".games > .game",
    ".games .game",
    "div:has(> a[href*='/live/'])"
  ];

  for (const selector of selectorCandidates) {
    const found = comp.find(selector).toArray();
    if (found.length > 0) return found;
  }

  return [];
}

function parseSingleGame($, gameNode, { competition, dayDate, source }) {
  const game = $(gameNode);
  const link = game.find("a[href*='/live/']").first().attr("href") || "";
  if (!link) return null;

  const teams = extractTeams($, game);
  if (teams.length < 2) return null;

  const [homeTeam, awayTeam] = teams;
  const homeScore = toNumberOrEmpty(game.find(".score.home").first().text());
  const awayScore = toNumberOrEmpty(game.find(".score.away").first().text());
  const status = normalizeWhitespace(game.find(".state").first().text() || game.find(".live-note").first().text());
  const kickoff = parseKickoff(game.find(".game-time").first().text());
  const venue = normalizeWhitespace(game.find(".venue").first().text());

  const parsedUrl = new URL(link, "https://rugby365.com");
  const externalId = parsedUrl.searchParams.get("g") || "";

  return {
    source,
    externalId,
    competition,
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    status,
    kickoff,
    venue,
    matchDate: dayDate,
    link: parsedUrl.toString()
  };
}

function extractTeams($, game) {
  const explicitTeamNodes = game.find(".team").toArray();
  if (explicitTeamNodes.length >= 2) {
    return explicitTeamNodes
      .slice(0, 2)
      .map(node => normalizeWhitespace($(node).text()))
      .filter(Boolean);
  }

  const imageAlts = game.find("img[alt]")
    .map((_, el) => normalizeWhitespace($(el).attr("alt")))
    .get()
    .filter(Boolean);

  return [...new Set(imageAlts)].slice(0, 2);
}

function dedupeMatches(matches) {
  const byKey = new Map();

  for (const match of matches) {
    const key = [match.externalId, match.competition, match.homeTeam, match.awayTeam, match.matchDate].join("|");
    if (!byKey.has(key)) {
      byKey.set(key, match);
    }
  }

  return [...byKey.values()];
}

module.exports = {
  extractInitialDateToken,
  parseMatchesFromGameDayHtml,
  parseMatchesFromFullPageHtml
};
