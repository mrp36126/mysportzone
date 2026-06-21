#!/usr/bin/env node

/*
 * Automatic Rugby Results Updater for MYSPORTZONE.
 *
 * Fetches international rugby results from Highlightly API and updates:
 * - data/rugby_results.csv
 *
 * API source:
 * - Highlightly API: https://api.highlightly.io/v1/rugby/results
 *
 * Run locally with:
 *   HIGHLIGHTLY_API_KEY=your_key npm run update:rugby
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
const API_BASE = 'https://api.highlightly.io';
const COMPLETED_STATUSES = new Set(['completed', 'finished', 'full-time', 'full_time', 'ft', 'ended', 'final']);
const TEAM_ALIASES = {
  'south africa xv': 'south africa',
  springboks: 'south africa',
  'barbarian fc': 'barbarians',
  barbarians: 'barbarians',
  'england xv': 'england',
  'new zealand xv': 'new zealand'
};

if (!API_KEY) {
  console.error('Error: HIGHLIGHTLY_API_KEY environment variable not set');
  process.exitCode = 1;
  process.exit(1);
}

main().catch(error => {
  console.error(`Rugby update failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  await assertDataDir();

  console.log('Reading expected rugby fixtures...');
  const fixtures = await readCsvIfExists(FILES.rugbyFixtures, ['Date', 'HomeTeam', 'AwayTeam', 'Venue', 'Competition', 'KickOffTime']);
  
  if (fixtures.length === 0) {
    console.log('No fixtures found in rugby_fixtures.csv. Skipping update.');
    return;
  }

  console.log(`Found ${fixtures.length} fixtures. Fetching results for scheduled matches from Highlightly...`);

  // Fetch recent completed matches from Highlightly
  const allResults = await fetchHighlightlyResults();

  if (allResults.length === 0) {
    console.log('No completed rugby matches available from Highlightly. Existing rugby_results.csv was left unchanged.');
    return;
  }

  // Filter results to only include matches in the fixtures list
  const results = filterResultsToFixtures(allResults, fixtures);

  if (results.length === 0) {
    console.log('No completed matches found for the scheduled fixtures. Existing rugby_results.csv was left unchanged.');
    return;
  }

  const existingRows = await readCsvIfExists(FILES.rugbyResults, HEADERS);
  const merged = mergeResults(existingRows, results);

  const changed = await writeCsvIfChanged(FILES.rugbyResults, HEADERS, merged);
  console.log(changed ? 'Rugby CSV update complete. Changes were written.' : 'Rugby CSV update complete. No changes needed.');
}

async function assertDataDir() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function fetchHighlightlyResults() {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      sport: 'rugby',
      status: 'all',
      limit: '100'
    });

    const options = {
      hostname: 'api.highlightly.io',
      path: `/v1/matches?${query}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'User-Agent': 'MySportZone/1.0'
      }
    };

    const req = https.request(options, res => {
      let body = '';

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.warn(`Highlightly API returned status ${res.statusCode}`);
            resolve([]);
            return;
          }

          const payload = JSON.parse(body);
          const matches = Array.isArray(payload)
            ? payload
            : (payload.data || payload.matches || payload.results || []);
          const mapped = matches
            .filter(match => {
              if (!isCompletedMatch(match)) return false;
              const homeTeam = extractTeamName(match.homeTeam || match.teamHome || match.teams?.home);
              const awayTeam = extractTeamName(match.awayTeam || match.teamAway || match.teams?.away);
              const score = extractMatchScore(match);
              return Boolean(homeTeam && awayTeam && score);
            })
            .map(match => {
              const homeTeamName = extractTeamName(match.homeTeam || match.teamHome || match.teams?.home);
              const awayTeamName = extractTeamName(match.awayTeam || match.teamAway || match.teams?.away);
              const score = extractMatchScore(match);
              const matchDate = match.date || match.startTime || match.start_date || match.kickoff || match.startDate;
              return {
                Date: formatDate(matchDate),
                HomeTeam: homeTeamName,
                HomeScore: String(score.home),
                AwayScore: String(score.away),
                AwayTeam: awayTeamName,
                Venue: match.venue?.name || match.stadium || '',
                Competition: match.competition?.name || match.competitionType || 'International',
                KickOffTime: formatTimeFromMatch(match)
              };
            })
            .sort((a, b) => new Date(b.Date) - new Date(a.Date));

          console.log(`Fetched ${mapped.length} completed rugby matches from Highlightly.`);
          resolve(mapped);
        } catch (error) {
          reject(new Error(`Could not parse Highlightly response: ${error.message}`));
        }
      });
    });

    req.on('error', error => {
      console.warn(`Highlightly API error: ${error.message}`);
      resolve([]);
    });

    req.end();
  });
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
  const source = match.date || match.startTime || match.start_date || match.kickoff || match.startDate;
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
  const directHome = Number(match.homeScore);
  const directAway = Number(match.awayScore);
  if (Number.isFinite(directHome) && Number.isFinite(directAway)) {
    return { home: directHome, away: directAway };
  }

  const score = match.score || match.scores || {};
  const homeCandidates = [
    score.home,
    score.homeScore,
    score.home_points,
    score.homePoints,
    score.homeTotal,
    score.fullTime?.home,
    score.ft?.home
  ];
  const awayCandidates = [
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
  return team.name || team.shortName || team.fullName || team.teamName || '';
}

function isCompletedMatch(match) {
  const status = String(match.status || match.state || '').toLowerCase().trim();
  return COMPLETED_STATUSES.has(status);
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
