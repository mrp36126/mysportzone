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

const HEADERS = ['Date', 'HomeTeam', 'HomeScore', 'AwayScore', 'AwayTeam', 'Competition'];
const API_KEY = process.env.HIGHLIGHTLY_API_KEY;
const API_BASE = 'https://api.highlightly.io';

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
      competitionTypes: 'international',
      status: 'completed',
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
          const matches = payload.data || payload.matches || [];
          const mapped = matches
            .filter(match => match.status === 'completed' && match.homeTeam && match.awayTeam && Number.isFinite(match.homeScore) && Number.isFinite(match.awayScore))
            .map(match => {
              const homeTeamName = typeof match.homeTeam === 'string' ? match.homeTeam : (match.homeTeam.name || '');
              const awayTeamName = typeof match.awayTeam === 'string' ? match.awayTeam : (match.awayTeam.name || '');
              return {
                Date: formatDate(match.date || match.startTime),
                HomeTeam: homeTeamName,
                HomeScore: String(match.homeScore),
                AwayScore: String(match.awayScore),
                AwayTeam: awayTeamName,
                Competition: match.competition?.name || match.competitionType || 'International'
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
  const fixtureSet = new Set(fixtures.map(f => `${normalizeTeamName(f.HomeTeam)}:${normalizeTeamName(f.AwayTeam)}:${f.Date}`));
  
  return results.filter(result => {
    const key = `${normalizeTeamName(result.HomeTeam)}:${normalizeTeamName(result.AwayTeam)}:${result.Date}`;
    return fixtureSet.has(key);
  });
}

function normalizeTeamName(name) {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
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

function mergeResults(existing, newResults) {
  const existing_map = new Map(existing.map(r => [`${r.Date}:${r.HomeTeam}:${r.AwayTeam}`, r]));
  
  newResults.forEach(result => {
    const key = `${result.Date}:${result.HomeTeam}:${result.AwayTeam}`;
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
