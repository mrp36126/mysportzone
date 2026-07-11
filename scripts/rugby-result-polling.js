const { normalizeWhitespace, parseKickoff } = require("./helpers.js");

const RESULT_CHECK_INTERVAL_MINUTES = 15;
const RESULT_CHECK_WINDOW_HOURS = 3;
const RESULT_CHECK_WINDOW_MS = RESULT_CHECK_WINDOW_HOURS * 60 * 60 * 1000;
const RESULT_CHECK_INTERVAL_MS = RESULT_CHECK_INTERVAL_MINUTES * 60 * 1000;

const FINAL_RESULT_STATUSES = new Set([
  "ft",
  "full time",
  "full-time",
  "final",
  "ended",
  "match finished",
  "finished",
  "after extra time",
  "after penalties"
]);

const NON_FINAL_STATUS_PATTERNS = [
  /scheduled/i,
  /kick\s*off/i,
  /not started/i,
  /postponed/i,
  /delayed/i,
  /abandoned/i,
  /cancelled/i,
  /to be confirmed/i,
  /^tbc$/i,
  /^\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?(\s*sast)?$/i
];

const LIVE_STATUS_PATTERNS = [
  /live/i,
  /in progress/i,
  /half[- ]?time/i,
  /^ht$/i,
  /1st half/i,
  /2nd half/i,
  /second half/i,
  /extra time/i
];

function fixtureKickoffDate(fixture) {
  const date = normalizeWhitespace(fixture?.Date);
  if (!date) return null;

  const kickoff = parseKickoff(fixture?.KickOffTime || fixture?.KickoffTime || "");
  if (!kickoff) return null;

  return new Date(`${date}T${kickoff}:00+02:00`);
}

function hasKickoffStarted(fixture, currentTime = new Date()) {
  const kickoffAt = fixtureKickoffDate(fixture);
  if (!kickoffAt) return false;
  return currentTime.getTime() >= kickoffAt.getTime();
}

function isWithinPollingWindow(fixture, currentTime = new Date()) {
  const kickoffAt = fixtureKickoffDate(fixture);
  if (!kickoffAt) return false;

  const nowMs = currentTime.getTime();
  return nowMs >= kickoffAt.getTime() && nowMs <= (kickoffAt.getTime() + RESULT_CHECK_WINDOW_MS);
}

function hasFinalResult(resultLike) {
  const homeScore = parseNumericScore(resultLike?.HomeScore ?? resultLike?.homeScore);
  const awayScore = parseNumericScore(resultLike?.AwayScore ?? resultLike?.awayScore);
  const status = normalizeStatus(resultLike?.MatchStatus ?? resultLike?.status);

  return isFinalStatus(status) && homeScore !== null && awayScore !== null;
}

function hasLiveResult(resultLike) {
  const homeScore = parseNumericScore(resultLike?.HomeScore ?? resultLike?.homeScore);
  const awayScore = parseNumericScore(resultLike?.AwayScore ?? resultLike?.awayScore);
  const status = normalizeStatus(resultLike?.MatchStatus ?? resultLike?.status);

  if (isFinalStatus(status) || isScheduledStatus(status)) return false;
  if (isLiveStatus(status)) return true;
  return homeScore !== null && awayScore !== null && Boolean(status);
}

function hasDisplayableResult(resultLike) {
  return hasFinalResult(resultLike) || hasLiveResult(resultLike);
}

function shouldMoveToRecentResults({ fixture, currentTime = new Date(), resultLike }) {
  return hasKickoffStarted(fixture, currentTime) && hasFinalResult(resultLike);
}

function updateFixtureResult(baseRecord, match) {
  return {
    ...baseRecord,
    HomeScore: normalizeWhitespace(match?.homeScore ?? baseRecord?.HomeScore),
    AwayScore: normalizeWhitespace(match?.awayScore ?? baseRecord?.AwayScore),
    MatchStatus: normalizeWhitespace(match?.status ?? baseRecord?.MatchStatus),
    KickOffTime: parseKickoff(match?.kickoff) || baseRecord?.KickOffTime,
    Venue: normalizeWhitespace(match?.venue) || baseRecord?.Venue,
    MatchDate: baseRecord?.MatchDate
  };
}

function nextPollingCheckAt(fixture, currentTime = new Date()) {
  const kickoffAt = fixtureKickoffDate(fixture);
  if (!kickoffAt) return null;

  const nextMs = Math.ceil(currentTime.getTime() / RESULT_CHECK_INTERVAL_MS) * RESULT_CHECK_INTERVAL_MS;
  const windowEndMs = kickoffAt.getTime() + RESULT_CHECK_WINDOW_MS;
  if (nextMs > windowEndMs) return null;
  return new Date(nextMs);
}

function formatSastDateTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "unknown";

  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(value);

  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}`;
}

function normalizeStatus(status) {
  return normalizeWhitespace(status)
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFinalStatus(status) {
  if (!status) return false;
  if (FINAL_RESULT_STATUSES.has(status)) return true;
  if (/^ft\s*\(.*\)$/.test(status)) return true;
  return false;
}

function isNonFinalStatus(status) {
  if (!status) return false;
  return NON_FINAL_STATUS_PATTERNS.some(pattern => pattern.test(status));
}

function isScheduledStatus(status) {
  return isNonFinalStatus(status);
}

function isLiveStatus(status) {
  if (!status) return false;
  return LIVE_STATUS_PATTERNS.some(pattern => pattern.test(status));
}

function parseNumericScore(value) {
  const text = normalizeWhitespace(value);
  if (!text) return null;

  const asNumber = Number(text);
  return Number.isFinite(asNumber) ? asNumber : null;
}

module.exports = {
  RESULT_CHECK_INTERVAL_MINUTES,
  RESULT_CHECK_WINDOW_HOURS,
  fixtureKickoffDate,
  hasKickoffStarted,
  isWithinPollingWindow,
  hasFinalResult,
  hasLiveResult,
  hasDisplayableResult,
  shouldMoveToRecentResults,
  updateFixtureResult,
  nextPollingCheckAt,
  formatSastDateTime
};
