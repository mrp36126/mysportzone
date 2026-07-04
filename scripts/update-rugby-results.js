#!/usr/bin/env node

/*
 * Automatic Rugby Results Updater for MYSPORTZONE.
 *
 * Fetches international rugby results from Highlightly API and updates:
 * - data/rugby_results.csv
 *
 * API source:
 * - Highlightly Rugby API: https://rugby.highlightly.net
 *
 * Run locally with:
 *   HIGHLIGHTLY_API_KEY=your_highlightly_key SPORTDB_API_KEY=your_sportdb_key npm run update:rugby
 *
 * GitHub Actions runs this script on a schedule (every 2 hours during match seasons).
 */

const fs = require('fs/promises');
const path = require('path');
const https = require('https');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const FILES = {
  rugbyResults: path.join(DATA_DIR, 'rugby_results.csv'),
  rugbyFixtures: path.join(DATA_DIR, 'rugby_fixtures.csv')
};

const HEADERS = ['Date', 'HomeTeam', 'HomeScore', 'AwayScore', 'AwayTeam', 'Competition', 'KickOffTimeSAST'];
const API_KEY = process.env.HIGHLIGHTLY_API_KEY;
const HIGHLIGHTLY_BASE_URL = process.env.HIGHLIGHTLY_BASE_URL || 'https://rugby.highlightly.net';
const HIGHLIGHTLY_RAPIDAPI_HOST = process.env.HIGHLIGHTLY_RAPIDAPI_HOST || 'rugby-highlights-api.p.rapidapi.com';
const SPORTDB_API_KEY = process.env.SPORTDB_API_KEY;
const SPORTDB_BASE_URL = process.env.SPORTDB_BASE_URL || 'https://api.sportdb.dev';
const SPORTDB_RUGBY_ROOT = '/api/flashscore/rugby-union';
const SPORTDB_WORLD_PATH = '/api/flashscore/rugby-union/world:8';
const COMPLETED_STATUSES = new Set([
  'completed',
  'finished',
  'match finished',
  'finished after extra time',
  'after extra time',
  'after penalties',
  'full-time',
  'full_time',
  'full time',
  'ft',
  'ended',
  'final'
]);
const SPORTDB_COMPLETED_STATUSES = new Set(['match finished', 'finished', 'full time', 'full-time', 'ft', 'after et', 'after penalties']);
const TEAM_ALIASES = {
  'south africa xv': 'south africa',
  springboks: 'south africa',
  'barbarian fc': 'barbarians',
  barbarians: 'barbarians',
  'england xv': 'england',
  'new zealand xv': 'new zealand',
  bulls: 'south africa',
  stormers: 'south africa',
  sharks: 'south africa',
  lions: 'south africa'
};

main().catch(error => {
  console.error(`Rugby update failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  await assertDataDir();

  console.log(`[Rugby] Workflow started at ${new Date().toISOString()}`);

  if (!API_KEY && !SPORTDB_API_KEY) {
    throw new Error('No rugby data provider configured. Set HIGHLIGHTLY_API_KEY and/or SPORTDB_API_KEY.');
  }

  console.log(`[Rugby] Providers configured: Highlightly=${API_KEY ? 'yes' : 'no'}, SportDB=${SPORTDB_API_KEY ? 'yes' : 'no'}`);

  console.log('Reading expected rugby fixtures...');
  const fixtures = await readCsvIfExists(FILES.rugbyFixtures, ['Date', 'HomeTeam', 'AwayTeam', 'Venue', 'Competition', 'KickOffTime']);
  
  if (fixtures.length === 0) {
    console.log('No fixtures found in rugby_fixtures.csv. Skipping update.');
    console.log(`[Rugby] Workflow completed at ${new Date().toISOString()}`);
    return;
  }

  console.log(`Found ${fixtures.length} fixtures. Fetching results from configured providers...`);

  const completedFixtures = fixtures.filter(isFixtureCompleted);
  console.log(`[Rugby] Completed fixtures eligible for score updates: ${completedFixtures.length}`);

  const highlightlyRaw = API_KEY
    ? await fetchHighlightlyResults(completedFixtures)
    : (console.warn('HIGHLIGHTLY_API_KEY is not set. Skipping Highlightly and using SportDB fallback only.'), []);
  const highlightlyResults = filterResultsToFixtures(highlightlyRaw, completedFixtures);

  console.log(`Matched ${highlightlyResults.length} completed fixtures from Highlightly.`);

  const missingCompletedFixtures = findMissingFixtures(completedFixtures, highlightlyResults);

  let fallbackResults = [];
  if (missingCompletedFixtures.length > 0) {
    if (!SPORTDB_API_KEY) {
      console.warn(`SportDB fallback skipped because SPORTDB_API_KEY is not set. ${missingCompletedFixtures.length} completed fixture(s) are still missing scores.`);
    } else {
      console.log(`Highlightly missing ${missingCompletedFixtures.length} completed fixture(s). Querying SportDB fallback...`);
      const sportDbRaw = await fetchSportDbResultsForFixtures(missingCompletedFixtures);
      fallbackResults = filterResultsToFixtures(sportDbRaw, missingCompletedFixtures);
      console.log(`Matched ${fallbackResults.length} completed fixtures from SportDB fallback.`);
    }
  }

  const results = mergeResults([], [...highlightlyResults, ...fallbackResults]);

  if (results.length === 0) {
    console.log('No completed matches found from Highlightly or SportDB fallback for scheduled fixtures. Existing rugby_results.csv was left unchanged.');
    console.log(`[Rugby] Workflow completed at ${new Date().toISOString()}`);
    return;
  }

  const existingRows = await readCsvIfExists(FILES.rugbyResults, HEADERS);
  const { inserted, updated } = countResultChanges(existingRows, results);
  const merged = mergeResults(existingRows, results);

  const changed = await writeCsvIfChanged(FILES.rugbyResults, HEADERS, merged);
  console.log(`[Rugby] Database write plan: inserted=${inserted}, updated=${updated}, total_after_merge=${merged.length}`);
  console.log(changed ? 'Rugby CSV update complete. Changes were written.' : 'Rugby CSV update complete. No changes needed.');
  console.log(`[Rugby] Workflow completed at ${new Date().toISOString()}`);
}

function buildResultKey(date, homeTeam, awayTeam) {
  return `${date}:${canonicalTeamName(homeTeam)}:${canonicalTeamName(awayTeam)}`;
}

function findMissingFixtures(fixtures, matchedResults) {
  const matchedKeys = new Set(matchedResults.map(row => buildResultKey(row.Date, row.HomeTeam, row.AwayTeam)));
  return fixtures.filter(fixture => !matchedKeys.has(buildResultKey(fixture.Date, fixture.HomeTeam, fixture.AwayTeam)));
}

function isFixtureCompleted(fixture) {
  const kickoffDate = fixtureKickoffDateSAST(fixture);
  if (!kickoffDate) return false;
  return kickoffDate <= new Date();
}

function fixtureKickoffDateSAST(fixture) {
  if (!fixture?.Date) return null;
  const kickoffRaw = fixture.KickOffTime || fixture.KickoffTime || '';
  const kickoffSAST = kickoffRaw && String(kickoffRaw).toLowerCase() !== 'tbc'
    ? convertToSAST(fixture.Date, kickoffRaw, fixture.Venue || '')
    : '15:00';

  if (!kickoffSAST || kickoffSAST === 'TBC') return new Date(`${fixture.Date}T15:00:00+02:00`);
  return new Date(`${fixture.Date}T${kickoffSAST}:00+02:00`);
}

async function fetchSportDbResultsForFixtures(fixtures) {
  if (!SPORTDB_API_KEY || fixtures.length === 0) return [];

  const merged = [];

  const directWorldRows = await fetchSportDbWorldCompetitionResults(fixtures);
  if (directWorldRows.length > 0) {
    merged.push(...directWorldRows);
  }

  const stillMissingFixtures = findMissingFixtures(fixtures, merged);
  if (stillMissingFixtures.length === 0) {
    console.log(`Fetched ${merged.length} completed rugby matches from SportDB.`);
    return merged;
  }

  const countriesPayload = await requestSportDbJson(SPORTDB_RUGBY_ROOT);
  const countries = Array.isArray(countriesPayload?.value) ? countriesPayload.value : [];
  const selectedCountryPaths = findRelevantSportDbCountryPaths(stillMissingFixtures, countries);

  for (const countryPath of selectedCountryPaths) {
    const rows = await crawlSportDbCountry(countryPath);
    if (rows.length > 0) merged.push(...rows);
  }

  console.log(`Fetched ${merged.length} completed rugby matches from SportDB.`);
  return merged;
}

async function fetchSportDbWorldCompetitionResults(fixtures) {
  const worldPayload = await requestSportDbJson(SPORTDB_WORLD_PATH);
  const competitions = Array.isArray(worldPayload) ? worldPayload : Array.isArray(worldPayload?.value) ? worldPayload.value : [];
  if (competitions.length === 0) return [];

  const targetCompetitionLinks = new Set();
  for (const fixture of fixtures) {
    const competition = matchSportDbCompetitionForFixture(fixture, competitions);
    if (competition?.link) targetCompetitionLinks.add(competition.link);
  }

  const rows = [];
  for (const competitionLink of targetCompetitionLinks) {
    const competitionPayload = await requestSportDbJson(competitionLink);
    const seasons = Array.isArray(competitionPayload?.seasons) ? competitionPayload.seasons : [];
    for (const season of seasons) {
      if (!season?.season || !fixtures.some(fixture => String(fixture.Date || '').startsWith(String(season.season)))) {
        continue;
      }

      if (season.results) {
        const resultsPayload = await requestSportDbJson(season.results);
        rows.push(...extractSportDbRows(resultsPayload));
      }
    }
  }

  return rows;
}

function matchSportDbCompetitionForFixture(fixture, competitions) {
  const fixtureCompetition = normalizeCompetitionName(fixture.Competition || '');
  const candidates = competitions.map(competition => ({
    competition,
    normalized: normalizeCompetitionName(competition.name || competition.slug || '')
  }));

  const aliases = competitionAliasesForFixture(fixtureCompetition);
  for (const alias of aliases) {
    const exact = candidates.find(candidate => candidate.normalized === alias);
    if (exact) return exact.competition;
  }

  for (const alias of aliases) {
    const partial = candidates.find(candidate => candidate.normalized.includes(alias) || alias.includes(candidate.normalized));
    if (partial) return partial.competition;
  }

  return null;
}

function competitionAliasesForFixture(normalizedCompetition) {
  if (!normalizedCompetition) return [];
  const aliases = [normalizedCompetition];

  if (normalizedCompetition.includes('friendly')) aliases.push('friendly international');
  if (normalizedCompetition.includes('nations championship')) aliases.push('nations championship');
  if (normalizedCompetition.includes('rivalry tour')) aliases.push('friendly international');

  return [...new Set(aliases.map(normalizeCompetitionName).filter(Boolean))];
}

function normalizeCompetitionName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRelevantSportDbCountryPaths(fixtures, countries) {
  const desiredCountries = new Set(
    fixtures
      .flatMap(fixture => inferFixtureCountryHints(fixture))
      .map(hint => slugifySportDbValue(hint))
      .filter(Boolean)
  );

  const matchedPaths = countries
    .filter(country => {
      const nameSlug = slugifySportDbValue(country.name);
      const countrySlug = slugifySportDbValue(country.slug);
      return desiredCountries.has(nameSlug) || desiredCountries.has(countrySlug);
    })
    .map(country => country.competitions)
    .filter(Boolean);

  const withWorld = values => [...new Set([SPORTDB_WORLD_PATH, ...values])];

  if (matchedPaths.length > 0) return withWorld(matchedPaths);

  return withWorld(countries
    .map(country => country.competitions)
    .filter(Boolean)
    .slice(0, 12));
}

function inferFixtureCountryHints(fixture) {
  const hints = [
    fixture.HomeTeam,
    fixture.AwayTeam,
    extractVenueCountryHint(fixture.Venue)
  ].filter(Boolean);

  return hints.map(hint => canonicalTeamName(hint));
}

function extractVenueCountryHint(venue) {
  if (!venue) return '';
  const parts = String(venue).split(':');
  if (parts.length > 1) return parts[parts.length - 1].trim();
  return venue;
}

function slugifySportDbValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function crawlSportDbCountry(countryPath) {
  const queue = [countryPath];
  const visited = new Set();
  const rows = [];
  const rowKeys = new Set();
  let requestCount = 0;

  while (queue.length > 0 && requestCount < 120) {
    queue.sort((a, b) => sportDbPathPriority(a) - sportDbPathPriority(b));
    const nextPath = queue.shift();
    if (!nextPath || visited.has(nextPath)) continue;
    visited.add(nextPath);

    const payload = await requestSportDbJson(nextPath);
    requestCount += 1;
    if (!payload) continue;

    for (const row of extractSportDbRows(payload)) {
      const key = buildResultKey(row.Date, row.HomeTeam, row.AwayTeam);
      if (!rowKeys.has(key)) {
        rowKeys.add(key);
        rows.push(row);
      }
    }

    const childPaths = extractSportDbPaths(payload)
      .filter(pathValue => !visited.has(pathValue))
      .sort((a, b) => sportDbPathPriority(a) - sportDbPathPriority(b));

    queue.push(...childPaths);
  }

  return rows.sort((a, b) => new Date(b.Date) - new Date(a.Date));
}

function sportDbPathPriority(pathValue) {
  if (/\/results(\?|$)/i.test(pathValue)) return 0;
  if (/\/fixtures(\?|$)/i.test(pathValue)) return 1;
  if (/\/live(\?|$)/i.test(pathValue)) return 2;
  if (/\/stages(\?|$)|\/standings(\?|$)/i.test(pathValue)) return 3;
  if (/\/\d{4}(\/|$)/i.test(pathValue)) return 4;
  return 5;
}

function extractSportDbPaths(payload) {
  const paths = new Set();

  walkObject(payload, value => {
    if (typeof value !== 'string') return;
    if (value.startsWith(SPORTDB_RUGBY_ROOT)) {
      paths.add(value);
      return;
    }

    if (value.startsWith(SPORTDB_BASE_URL + SPORTDB_RUGBY_ROOT)) {
      const url = new URL(value);
      paths.add(`${url.pathname}${url.search}`);
    }
  });

  return [...paths];
}

function extractSportDbRows(payload) {
  const rows = [];
  walkObject(payload, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const row = mapSportDbEvent(value);
    if (row) rows.push(row);
  });
  return rows;
}

function mapSportDbEvent(event) {
  const homeTeam = extractTeamName(
    event.strHomeTeam || event.homeName || event.homeTeam || event.home || event.teamHome ||
    event.homeParticipant || event.homeCompetitor || event.participants?.home ||
    event.homeTeamData || event.homeCompetitorData
  );
  const awayTeam = extractTeamName(
    event.strAwayTeam || event.awayName || event.awayTeam || event.away || event.teamAway ||
    event.awayParticipant || event.awayCompetitor || event.participants?.away ||
    event.awayTeamData || event.awayCompetitorData
  );

  const score = extractMatchScore({
    homeScore: event.intHomeScore ?? event.homeScore ?? event.homeResult ?? event.home_points,
    awayScore: event.intAwayScore ?? event.awayScore ?? event.awayResult ?? event.away_points,
    score: event.score || event.result || event.scores || {
      home: event.intHomeScore ?? event.homeScore ?? event.homeResult,
      away: event.intAwayScore ?? event.awayScore ?? event.awayResult,
      fullTime: event.fullTime || event.ft
    }
  });

  const statusValue = event.strStatus || event.status?.type || event.status || event.state || event.matchStatus || '';
  const status = String(statusValue).toLowerCase().trim();
  const isCompleted = (score && Number.isFinite(score.home) && Number.isFinite(score.away)) || SPORTDB_COMPLETED_STATUSES.has(status);

  if (!homeTeam || !awayTeam || !isCompleted || !score) return null;

  const dateSource = event.dateEvent || event.date || event.startDateTimeUtc || event.startTime || event.timestamp || event.strTimestamp || event.startDate;
  const formattedDate = formatDate(dateSource);
  if (!formattedDate) return null;

  return {
    Date: formattedDate,
    HomeTeam: homeTeam,
    HomeScore: String(score.home),
    AwayScore: String(score.away),
    AwayTeam: awayTeam,
    Competition: event.strLeague || event.strLeagueAlternate || event.competition?.name || event.tournament?.name || event.tournamentName || event.league?.name || event.stage?.name || 'International',
    KickOffTime: formatTimeFromMatch({ startTime: event.strTime || event.strTimestamp || event.startDateTimeUtc || event.startTime || event.startDate })
  };
}

function walkObject(value, visit) {
  visit(value);
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach(item => walkObject(item, visit));
    return;
  }

  Object.values(value).forEach(item => walkObject(item, visit));
}

function requestSportDbJson(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${SPORTDB_BASE_URL}${pathOrUrl}`;
  return requestJson(url, {
    'X-API-Key': SPORTDB_API_KEY
  }, `[SportDB] GET ${pathOrUrl}`);
}

function requestJson(rawUrl, extraHeaders = {}, label = 'Request') {
  return new Promise(resolve => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      resolve(null);
      return;
    }

    const options = {
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'MySportZone/1.0',
        ...extraHeaders
      }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const preview = body ? body.slice(0, 240).replace(/\s+/g, ' ') : '(empty body)';
          console.warn(`${label} failed with status ${res.statusCode}. Body preview: ${preview}`);
          resolve(null);
          return;
        }

        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch {
          console.warn(`${label} returned non-JSON payload.`);
          resolve(null);
        }
      });
    });

    req.on('error', error => {
      console.warn(`${label} network error: ${error.message}`);
      resolve(null);
    });
    req.end();
  });
}

async function assertDataDir() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function fetchHighlightlyResults(fixtures) {
  if (!API_KEY || fixtures.length === 0) return [];

  const dates = [...new Set(fixtures.map(fixture => fixture.Date).filter(Boolean))].sort();
  const allMatches = [];
  const seen = new Set();

  console.log(`[Highlightly] Starting requests against ${HIGHLIGHTLY_BASE_URL} for ${dates.length} fixture date(s).`);

  for (const date of dates) {
    const query = new URLSearchParams({
      date,
      limit: '100',
      offset: '0'
    });

    const endpoint = `${HIGHLIGHTLY_BASE_URL}/matches?${query}`;
    const payload = await requestJson(endpoint, {
      'x-rapidapi-key': API_KEY,
      'x-rapidapi-host': HIGHLIGHTLY_RAPIDAPI_HOST
    }, `[Highlightly] GET /matches?date=${date}`);

    if (!payload) {
      console.warn(`[Highlightly] ${date}: request failed or returned no JSON payload.`);
      continue;
    }

    const matches = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.matches) ? payload.matches : []);

    console.log(`[Highlightly] ${date}: HTTP OK, received ${matches.length} match(es).`);

    for (const match of matches) {
      const key = highlightlyMatchUniqueKey(match);
      if (seen.has(key)) continue;
      seen.add(key);
      allMatches.push(match);
    }
  }

  const mapped = allMatches
    .filter(isCompletedMatch)
    .map(mapHighlightlyMatch)
    .filter(Boolean)
    .sort((a, b) => new Date(b.Date) - new Date(a.Date));

  console.log(`[Highlightly] Parsed ${mapped.length} completed rugby match(es) from ${allMatches.length} fetched match(es).`);
  return mapped;
}

function highlightlyMatchUniqueKey(match) {
  if (match?.id !== undefined && match?.id !== null) return `id:${match.id}`;
  const date = formatDate(match?.date || match?.startDate || match?.startTime || match?.start_date || match?.kickoff || '');
  const home = extractTeamName(match?.homeTeam || match?.teamHome || match?.teams?.home || match?.home || '');
  const away = extractTeamName(match?.awayTeam || match?.teamAway || match?.teams?.away || match?.away || '');
  return `fallback:${date}:${canonicalTeamName(home)}:${canonicalTeamName(away)}`;
}

function mapHighlightlyMatch(match) {
  const homeTeamName = extractTeamName(match.homeTeam || match.teamHome || match.teams?.home || match.home);
  const awayTeamName = extractTeamName(match.awayTeam || match.teamAway || match.teams?.away || match.away);
  const score = extractMatchScore(match);
  const matchDate = match.date || match.startTime || match.start_date || match.kickoff || match.startDate;
  const formattedDate = formatDate(matchDate);

  if (!homeTeamName || !awayTeamName || !score || !formattedDate) return null;

  return {
    Date: formattedDate,
    HomeTeam: homeTeamName,
    HomeScore: String(score.home),
    AwayScore: String(score.away),
    AwayTeam: awayTeamName,
    Venue: match.venue?.name || match.venue?.displayName || match.stadium || '',
    Competition: match.competition?.name || match.league?.name || match.competitionType || 'International',
    KickOffTime: formatTimeFromMatch(match)
  };
}

function filterResultsToFixtures(results, fixtures) {
  const fixtureCandidates = fixtures
    .map(fixture => {
      const home = canonicalTeamName(fixture.HomeTeam);
      const away = canonicalTeamName(fixture.AwayTeam);
      const fixtureDate = parseDateOnly(fixture.Date);
      if (!home || !away || !fixtureDate) return null;
      return {
        fixture,
        home,
        away,
        fixtureDate,
        kickoffTime: fixture.KickOffTime || ''
      };
    })
    .filter(Boolean);

  return results
    .map(result => {
      const matched = findMatchingFixture(result, fixtureCandidates);
      if (!matched) return null;

      const { fixtureData, swappedTeams } = matched;
      const kickoffTime = fixtureData.kickoffTime
        ? convertToSAST(fixtureData.fixture.Date, fixtureData.kickoffTime, fixtureData.fixture.Venue || '')
        : '';

      const homeScore = swappedTeams ? result.AwayScore : result.HomeScore;
      const awayScore = swappedTeams ? result.HomeScore : result.AwayScore;

      return {
        Date: fixtureData.fixture.Date,
        HomeTeam: fixtureData.fixture.HomeTeam,
        HomeScore: homeScore,
        AwayScore: awayScore,
        AwayTeam: fixtureData.fixture.AwayTeam,
        Competition: result.Competition || fixtureData.fixture.Competition || 'International',
        KickOffTimeSAST: kickoffTime
      };
    })
    .filter(Boolean);
}

function findMatchingFixture(result, fixtureCandidates) {
  const resultHome = canonicalTeamName(result.HomeTeam);
  const resultAway = canonicalTeamName(result.AwayTeam);
  const resultDate = parseDateOnly(result.Date);

  if (!resultHome || !resultAway || !resultDate) return null;

  let bestMatch = null;

  for (const fixtureData of fixtureCandidates) {
    const dayDelta = Math.abs((fixtureData.fixtureDate.getTime() - resultDate.getTime()) / (24 * 60 * 60 * 1000));
    if (dayDelta > 1) continue;

    const directMatch = fixtureData.home === resultHome && fixtureData.away === resultAway;
    const swappedMatch = fixtureData.home === resultAway && fixtureData.away === resultHome;
    if (!directMatch && !swappedMatch) continue;

    if (!bestMatch || dayDelta < bestMatch.dayDelta || (dayDelta === 0 && bestMatch.dayDelta !== 0)) {
      bestMatch = { fixtureData, swappedTeams: swappedMatch, dayDelta };
      if (dayDelta === 0 && directMatch) break;
    }
  }

  return bestMatch;
}

function convertToSAST(dateStr, timeStr, venueStr) {
  if (!timeStr || timeStr.toLowerCase() === 'tbc') return 'TBC';
  
  try {
    // Parse the time
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 'TBC';
    
    // Create a UTC date at that time
    const dt = new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`);
    if (Number.isNaN(dt.getTime())) return 'TBC';
    
    // Determine the timezone offset from the venue
    const venueNorm = venueStr.toLowerCase();
    let offsetHours = 0;
    
    // South Africa (UTC+2)
    if (venueNorm.includes('south africa') || venueNorm.includes('johannesburg') || venueNorm.includes('pretoria') || 
        venueNorm.includes('durban') || venueNorm.includes('cape town')) {
      offsetHours = 2;
    }
    // Australia (UTC+8 to UTC+10 depending on location)
    else if (venueNorm.includes('australia') || venueNorm.includes('sydney') || venueNorm.includes('perth')) {
      offsetHours = 8;
    }
    // New Zealand (UTC+12)
    else if (venueNorm.includes('new zealand') || venueNorm.includes('auckland') || venueNorm.includes('wellington')) {
      offsetHours = 12;
    }
    // Japan (UTC+9)
    else if (venueNorm.includes('japan') || venueNorm.includes('tokyo')) {
      offsetHours = 9;
    }
    // UK/Ireland (UTC+0, or UTC+1 in summer)
    else if (venueNorm.includes('england') || venueNorm.includes('scotland') || venueNorm.includes('wales') || 
             venueNorm.includes('ireland') || venueNorm.includes('cardiff') || venueNorm.includes('edinburgh') ||
             venueNorm.includes('liverpool')) {
      offsetHours = 0; // Assume winter UTC, may need adjustment for summer
    }
    // Argentina (UTC-3)
    else if (venueNorm.includes('argentina') || venueNorm.includes('cordoba') || venueNorm.includes('santiago')) {
      offsetHours = -3;
    }
    // USA (UTC-5 for East Coast)
    else if (venueNorm.includes('baltimore') || venueNorm.includes('united states')) {
      offsetHours = -5;
    }
    // Fiji (UTC+12)
    else if (venueNorm.includes('fiji')) {
      offsetHours = 12;
    }
    
    // Convert UTC to the venue's local time, then to SAST
    const venueTime = new Date(dt.getTime() + offsetHours * 60 * 60 * 1000);
    const sastTime = new Date(dt.getTime() + 2 * 60 * 60 * 1000); // SAST = UTC+2
    
    // Calculate the time difference
    const diff = sastTime.getTime() - venueTime.getTime();
    const fastTime = new Date(dt.getTime() + diff);
    
    const sastHours = String(fastTime.getUTCHours()).padStart(2, '0');
    const sastMinutes = String(fastTime.getUTCMinutes()).padStart(2, '0');
    return `${sastHours}:${sastMinutes}`;
  } catch (error) {
    return 'TBC';
  }
}

function normalizeTeamName(name) {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function canonicalTeamName(name) {
  const normalized = normalizeTeamName(name)
    .replace(/[().,-]/g, ' ')
    .replace(/\b(union|rugby|team)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return TEAM_ALIASES[normalized] || normalized;
}

function parseDateOnly(dateStr) {
  if (!dateStr) return null;
  const isoMatch = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }

  const dt = new Date(dateStr);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const dt = new Date(dateStr);
    if (Number.isNaN(dt.getTime())) return '';
    const year = dt.getUTCFullYear();
    const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return '';
  }
}

function formatTimeFromMatch(match) {
  const source = match.date || match.startTime || match.start_date || match.kickoff || match.startDate || match.matchDate || match.dateTime;
  if (!source) return '';
  try {
    const dt = new Date(source);
    if (Number.isNaN(dt.getTime())) return '';
    const hours = String(dt.getUTCHours()).padStart(2, '0');
    const minutes = String(dt.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '';
  }
}

function extractMatchScore(match) {
  const score = match.score || match.scores || {};
  const homeCandidates = [
    match.homeScore,
    match.home_points,
    match.homePoints,
    match.homeResult,
    match.intHomeScore,
    match.homeTeam?.score,
    match.homeTeam?.score?.current,
    match.homeTeam?.score?.total,
    match.homeTeam?.score?.fullTime,
    match.homeTeam?.statistics?.score,
    score.home,
    score.homeScore,
    score.home_points,
    score.homePoints,
    score.homeTotal,
    score.fullTime?.home,
    score.ft?.home
  ];
  const awayCandidates = [
    match.awayScore,
    match.away_points,
    match.awayPoints,
    match.awayResult,
    match.intAwayScore,
    match.awayTeam?.score,
    match.awayTeam?.score?.current,
    match.awayTeam?.score?.total,
    match.awayTeam?.score?.fullTime,
    match.awayTeam?.statistics?.score,
    score.away,
    score.awayScore,
    score.away_points,
    score.awayPoints,
    score.awayTotal,
    score.fullTime?.away,
    score.ft?.away
  ];

  const home = homeCandidates.map(Number).find(Number.isFinite);
  const away = awayCandidates.map(Number).find(Number.isFinite);
  if (Number.isFinite(home) && Number.isFinite(away)) {
    return { home, away };
  }

  return null;
}

function extractTeamName(team) {
  if (!team) return '';
  if (typeof team === 'string') return team;
  return team.name || team.shortName || team.fullName || team.displayName || team.teamName || '';
}

function isCompletedMatch(match) {
  const rawState =
    match.status ||
    match.state?.state ||
    match.state?.name ||
    match.state?.type ||
    match.state;

  const status = String(rawState || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .trim();

  if (COMPLETED_STATUSES.has(status)) return true;
  return status.includes('finished') || status.includes('final');
}

function countResultChanges(existingRows, incomingRows) {
  const existingMap = new Map(
    existingRows.map(row => [buildResultKey(row.Date, row.HomeTeam, row.AwayTeam), row])
  );

  let inserted = 0;
  let updated = 0;

  for (const row of incomingRows) {
    const key = buildResultKey(row.Date, row.HomeTeam, row.AwayTeam);
    const existing = existingMap.get(key);
    if (!existing) {
      inserted += 1;
      continue;
    }

    const changed = (
      String(existing.HomeScore || '') !== String(row.HomeScore || '') ||
      String(existing.AwayScore || '') !== String(row.AwayScore || '') ||
      String(existing.Competition || '') !== String(row.Competition || '') ||
      String(existing.KickOffTimeSAST || '') !== String(row.KickOffTimeSAST || '')
    );

    if (changed) updated += 1;
  }

  return { inserted, updated };
}

function mergeResults(existing, newResults) {
  const existing_map = new Map(existing.map(r => [`${r.Date}:${canonicalTeamName(r.HomeTeam)}:${canonicalTeamName(r.AwayTeam)}`, r]));
  
  newResults.forEach(result => {
    const key = `${result.Date}:${canonicalTeamName(result.HomeTeam)}:${canonicalTeamName(result.AwayTeam)}`;
    existing_map.set(key, result);
  });

  return [...existing_map.values()].sort((a, b) => new Date(b.Date) - new Date(a.Date));
}

async function readCsvIfExists(filePath, headers) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return parseCsv(content, headers);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function parseCsv(content, fallbackHeaders) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(value);
      value = '';
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      value += ch;
    }
  }

  row.push(value);
  if (row.some(cell => cell.trim() !== '')) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows[0].length ? rows[0] : fallbackHeaders;
  return rows.slice(1).map(values => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || '';
    });
    return obj;
  });
}

function toCsv(headers, rows) {
  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(header => escapeCsv(row[header] ?? '')).join(','))
  ];
  return `${lines.join('\n')}\n`;
}

function escapeCsv(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeNewlines(content) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function writeCsvIfChanged(filePath, headers, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(`Skipped ${path.relative(ROOT_DIR, filePath)} because no rows were produced.`);
    return false;
  }

  const nextContent = toCsv(headers, rows);
  let currentContent = '';

  try {
    currentContent = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Could not read ${filePath}: ${error.message}`);
    }
  }

  if (normalizeNewlines(currentContent) === normalizeNewlines(nextContent)) {
    console.log(`No change: ${path.relative(ROOT_DIR, filePath)}`);
    return false;
  }

  try {
    await fs.writeFile(filePath, nextContent, 'utf8');
  } catch (error) {
    throw new Error(`Could not write ${filePath}: ${error.message}`);
  }

  console.log(`Updated: ${path.relative(ROOT_DIR, filePath)}`);
  return true;
}
