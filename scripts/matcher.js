const dayjs = require("dayjs");
const {
  normalizeCompetition,
  normalizeName,
  normalizeWhitespace,
  parseHumanDate
} = require("./helpers.js");
const {
  RESULT_CHECK_WINDOW_HOURS,
  hasKickoffStarted,
  isWithinPollingWindow,
  hasFinalResult,
  shouldMoveToRecentResults,
  updateFixtureResult,
  nextPollingCheckAt,
  formatSastDateTime,
  fixtureKickoffDate
} = require("./rugby-result-polling.js");

function matchAndUpdateFixtures({ fixtures, scrapedMatches, existingRecords, logger, currentTime = new Date() }) {
  const existingByKey = new Map(
    existingRecords.map(row => [fixtureIdentity(row), row])
  );

  const updatedRecords = [];
  const stats = {
    loadedFixtures: fixtures.length,
    scrapedFixtures: scrapedMatches.length,
    successfulUpdates: 0,
    preKickoffSkipped: 0,
    outsideWindowSkipped: 0,
    pendingResultChecks: 0,
    unmatchedFixtures: 0,
    ambiguousMatches: 0,
    skippedFixtures: 0
  };

  for (const fixture of fixtures) {
    const id = fixtureIdentity(fixture);
    const base = {
      ...(existingByKey.get(id) ?? {}),
      Competition: fixture.Competition,
      HomeTeam: fixture.HomeTeam,
      AwayTeam: fixture.AwayTeam,
      MatchDate: fixture.Date,
      Venue: fixture.Venue,
      KickOffTime: fixture.KickOffTime,
      HomeScore: existingByKey.get(id)?.HomeScore ?? "",
      AwayScore: existingByKey.get(id)?.AwayScore ?? "",
      MatchStatus: existingByKey.get(id)?.MatchStatus ?? ""
    };

    const kickoffAt = fixtureKickoffDate(fixture);
    const kickoffLabel = formatSastDateTime(kickoffAt);
    const currentLabel = formatSastDateTime(currentTime);
    const fixtureLabel = `${fixture.HomeTeam} vs ${fixture.AwayTeam}`;

    if (hasFinalResult(base)) {
      updatedRecords.push(base);
      continue;
    }

    if (!hasKickoffStarted(fixture, currentTime)) {
      stats.preKickoffSkipped += 1;
      stats.skippedFixtures += 1;
      logInfo(logger, [
        `Fixture: ${fixtureLabel}`,
        `Kickoff: ${kickoffLabel}`,
        `Current: ${currentLabel}`,
        "Status: Before kick-off. Skipping Rugby365 check.",
        "No final score yet."
      ].join("\n"));
      updatedRecords.push(base);
      continue;
    }

    if (!isWithinPollingWindow(fixture, currentTime)) {
      stats.outsideWindowSkipped += 1;
      stats.skippedFixtures += 1;
      logInfo(logger, [
        `Fixture: ${fixtureLabel}`,
        `Kickoff: ${kickoffLabel}`,
        `Current: ${currentLabel}`,
        `Status: Outside polling window (${RESULT_CHECK_WINDOW_HOURS}h).`,
        "Polling complete for this run."
      ].join("\n"));
      updatedRecords.push(base);
      continue;
    }

    stats.pendingResultChecks += 1;
    const nextCheckAt = nextPollingCheckAt(fixture, currentTime);
    logInfo(logger, [
      `Fixture: ${fixtureLabel}`,
      `Kickoff: ${kickoffLabel}`,
      `Current: ${currentLabel}`,
      "Status: Checking Rugby365..."
    ].join("\n"));

    const candidates = scoredCandidates(fixture, scrapedMatches).filter(candidate => candidate.score >= 8);

    if (candidates.length === 0) {
      stats.unmatchedFixtures += 1;
      stats.skippedFixtures += 1;
      logWarn(logger, [
        `No final score yet for fixture: ${fixture.Date} ${fixtureLabel} (${fixture.Competition}).`,
        nextCheckAt ? `Next check: ${formatSastDateTime(nextCheckAt)}` : "Next check: waiting for next workflow cycle"
      ].join("\n"));
      updatedRecords.push(base);
      continue;
    }

    const bestScore = Math.max(...candidates.map(candidate => candidate.score));
    const best = candidates.filter(candidate => candidate.score === bestScore);

    if (best.length > 1) {
      stats.ambiguousMatches += 1;
      stats.skippedFixtures += 1;
      logWarn(logger, [
        `Ambiguous Rugby365 match for fixture ${fixture.Date} ${fixtureLabel}; skipped ${best.length} candidates.`,
        nextCheckAt ? `Next check: ${formatSastDateTime(nextCheckAt)}` : "Next check: waiting for next workflow cycle"
      ].join("\n"));
      updatedRecords.push(base);
      continue;
    }

    const selected = best[0].match;
    if (!shouldMoveToRecentResults({ fixture, currentTime, resultLike: selected })) {
      stats.skippedFixtures += 1;
      logInfo(logger, [
        `Fixture: ${fixtureLabel}`,
        "No final score yet.",
        nextCheckAt ? `Next check: ${formatSastDateTime(nextCheckAt)}` : "Next check: waiting for next workflow cycle"
      ].join("\n"));
      updatedRecords.push(base);
      continue;
    }

    const merged = updateFixtureResult(base, selected);

    logInfo(logger, [
      `Fixture: ${fixtureLabel}`,
      "Final score found.",
      "Updating JSON...",
      "Moving fixture to Recent Results.",
      "Polling complete."
    ].join("\n"));

    if (hasMeaningfulUpdate(base, merged)) {
      stats.successfulUpdates += 1;
    }

    updatedRecords.push(merged);
  }

  return { updatedRecords, stats };
}

function scoredCandidates(fixture, scrapedMatches) {
  const fixtureDate = parseHumanDate(fixture.Date);
  const fixtureComp = normalizeCompetition(fixture.Competition);
  const fixtureHome = normalizeName(fixture.HomeTeam);
  const fixtureAway = normalizeName(fixture.AwayTeam);

  return scrapedMatches.map(match => {
    const matchComp = normalizeCompetition(match.competition);
    const matchHome = normalizeName(match.homeTeam);
    const matchAway = normalizeName(match.awayTeam);
    const matchDate = parseHumanDate(match.matchDate);

    let score = 0;

    if (fixtureHome === matchHome) score += 4;
    if (fixtureAway === matchAway) score += 4;

    if (fixtureComp && matchComp) {
      if (fixtureComp === matchComp) {
        score += 3;
      } else if (fixtureComp.includes(matchComp) || matchComp.includes(fixtureComp)) {
        score += 1;
      }
    }

    if (fixtureDate && matchDate) {
      const delta = Math.abs(dayjs(fixtureDate).diff(dayjs(matchDate), "day"));
      if (delta === 0) score += 3;
      if (delta === 1) score += 1;
    }

    return { match, score };
  });
}

function fixtureIdentity(row) {
  return [
    normalizeCompetition(row.Competition),
    normalizeName(row.HomeTeam),
    normalizeName(row.AwayTeam),
    normalizeWhitespace(parseHumanDate(row.MatchDate || row.Date) || row.MatchDate || row.Date)
  ].join("|");
}

function hasMeaningfulUpdate(previous, current) {
  return (
    previous.HomeScore !== current.HomeScore ||
    previous.AwayScore !== current.AwayScore ||
    previous.MatchStatus !== current.MatchStatus ||
    previous.KickOffTime !== current.KickOffTime ||
    previous.Venue !== current.Venue ||
    previous.MatchDate !== current.MatchDate
  );
}

function logWarn(logger, message) {
  if (!logger) return;
  void logger.warn(message);
}

function logInfo(logger, message) {
  if (!logger) return;
  void logger.info(message);
}

module.exports = {
  matchAndUpdateFixtures
};
