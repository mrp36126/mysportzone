#!/usr/bin/env node

/*
 * Automatic F1 CSV updater for MYSPORTZONE.
 *
 * API source:
 * - Latest race result:
 *   https://api.jolpi.ca/ergast/f1/current/last/results.json
 * - Latest sprint result:
 *   https://api.jolpi.ca/ergast/f1/current/last/sprint.json
 *   Sprint weekends are first checked by round from data/f1_calendar.csv,
 *   for example https://api.jolpi.ca/ergast/f1/current/5/sprint.json
 * - Current driver standings:
 *   https://api.jolpi.ca/ergast/f1/current/driverStandings.json
 * - Current constructor standings:
 *   https://api.jolpi.ca/ergast/f1/current/constructorStandings.json
 *
 * CSV files updated:
 * - data/f1_results.csv
 * - data/f1_sprint_results.csv
 * - data/f1_drivers.csv
 * - data/f1_constructors.csv
 *
 * Run locally with:
 *   npm run update:f1
 *
 * To seed driver position changes against a specific completed round:
 *   F1_CHANGE_BASE_ROUND=4 npm run update:f1
 *
 * GitHub Actions runs this script on a schedule and commits changed CSV files.
 * Vercel then redeploys from the GitHub commit. The frontend only reads CSVs.
 */

const fs = require('fs/promises');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const FILES = {
  calendar: path.join(DATA_DIR, 'f1_calendar.csv'),
  results: path.join(DATA_DIR, 'f1_results.csv'),
  sprintResults: path.join(DATA_DIR, 'f1_sprint_results.csv'),
  drivers: path.join(DATA_DIR, 'f1_drivers.csv'),
  constructors: path.join(DATA_DIR, 'f1_constructors.csv')
};

const ENDPOINTS = {
  latestResults: 'https://api.jolpi.ca/ergast/f1/current/last/results.json',
  latestSprintResults: 'https://api.jolpi.ca/ergast/f1/current/last/sprint.json',
  driverStandings: 'https://api.jolpi.ca/ergast/f1/current/driverStandings.json',
  constructorStandings: 'https://api.jolpi.ca/ergast/f1/current/constructorStandings.json'
};

const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_DELAY_MS = 15000;

const RESULT_HEADERS = [
  'Season',
  'Round',
  'RaceName',
  'Circuit',
  'Country',
  'Date',
  'Position',
  'Driver',
  'Team',
  'Grid',
  'Laps',
  'Time',
  'Status',
  'Points'
];

const DRIVER_HEADERS = ['Position', 'Change', 'Driver', 'Team', 'CarNumber', 'Points', 'PointsChange'];
const CONSTRUCTOR_HEADERS = ['Position', 'Change', 'Constructor', 'Driver1', 'Driver1Points', 'Driver2', 'Driver2Points', 'Points'];

const DRIVER_NAME_ALIASES = {
  'Andrea Kimi Antonelli': 'Kimi Antonelli',
  'Nico Hülkenberg': 'Nico Hulkenberg',
  'Sergio Pérez': 'Sergio Perez'
};

const TEAM_NAME_ALIASES = {
  'Alpine F1 Team': 'Alpine',
  'Cadillac F1 Team': 'Cadillac',
  'RB F1 Team': 'Racing Bulls',
  'Red Bull': 'Red Bull Racing'
};

main().catch(error => {
  console.error(`F1 update failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  await assertDataDir();

  console.log('Fetching latest F1 data from Jolpica...');
  const calendarRows = await readCsvIfExists(FILES.calendar, []);
  const sprintRound = findLatestSprintRound(calendarRows);
  const sprintUrl = sprintRound
    ? `https://api.jolpi.ca/ergast/f1/current/${encodeURIComponent(sprintRound)}/sprint.json`
    : ENDPOINTS.latestSprintResults;

  if (sprintRound) {
    console.log(`Checking sprint results for calendar round ${sprintRound}...`);
  }

  const [latestResultsData, latestSprintData, driverStandingsData, constructorStandingsData] = await Promise.all([
    fetchJson(ENDPOINTS.latestResults),
    fetchOptionalJson(sprintUrl),
    fetchJson(ENDPOINTS.driverStandings),
    fetchJson(ENDPOINTS.constructorStandings)
  ]);

  const latestRaceRows = mapLatestRaceResults(latestResultsData);
  const latestSprintRows = mapLatestSprintResults(latestSprintData);
  const previousDriverRows = await loadDriverChangeBaseline();
  const driverRows = mapDriverStandings(driverStandingsData, previousDriverRows);
  const previousConstructorRows = await loadConstructorChangeBaseline();
  const constructorRows = mapConstructorStandings(constructorStandingsData, driverRows, previousConstructorRows);

  let changed = false;

  if (latestRaceRows.length > 0) {
    changed = (await upsertResultRows(FILES.results, latestRaceRows, RESULT_HEADERS, 'race')) || changed;
  } else {
    console.log('No latest race result available yet. Existing f1_results.csv was left unchanged.');
  }

  if (latestSprintRows.length > 0) {
    changed = (await upsertResultRows(FILES.sprintResults, latestSprintRows, RESULT_HEADERS, 'sprint')) || changed;
  } else {
    console.log('No latest sprint result available. Existing f1_sprint_results.csv was left unchanged.');
  }

  if (driverRows.length > 0) {
    changed = (await writeCsvIfChanged(FILES.drivers, DRIVER_HEADERS, driverRows)) || changed;
  } else {
    console.log('No driver standings available. Existing f1_drivers.csv was left unchanged.');
  }

  if (constructorRows.length > 0) {
    changed = (await writeCsvIfChanged(FILES.constructors, CONSTRUCTOR_HEADERS, constructorRows)) || changed;
  } else {
    console.log('No constructor standings available. Existing f1_constructors.csv was left unchanged.');
  }

  console.log(changed ? 'F1 CSV update complete. Changes were written.' : 'F1 CSV update complete. No CSV changes needed.');
}

async function loadDriverChangeBaseline() {
  const baseRound = process.env.F1_CHANGE_BASE_ROUND;
  if (!baseRound) return readCsvIfExists(FILES.drivers, DRIVER_HEADERS);

  console.log(`Comparing driver standing changes against round ${baseRound}...`);
  const baselinePayload = await fetchJson(`https://api.jolpi.ca/ergast/f1/current/${encodeURIComponent(baseRound)}/driverStandings.json`);
  const baselineRows = mapDriverStandings(baselinePayload, []);
  if (baselineRows.length === 0) {
    console.log(`No baseline driver standings found for round ${baseRound}; falling back to existing CSV.`);
    return readCsvIfExists(FILES.drivers, DRIVER_HEADERS);
  }
  return baselineRows;
}

async function loadConstructorChangeBaseline() {
  const baseRound = process.env.F1_CHANGE_BASE_ROUND;
  if (!baseRound) return readCsvIfExists(FILES.constructors, CONSTRUCTOR_HEADERS);

  console.log(`Comparing constructor standing changes against round ${baseRound}...`);
  const baselinePayload = await fetchJson(`https://api.jolpi.ca/ergast/f1/current/${encodeURIComponent(baseRound)}/constructorStandings.json`);
  const baselineRows = mapConstructorStandings(baselinePayload, [], []);
  if (baselineRows.length === 0) {
    console.log(`No baseline constructor standings found for round ${baseRound}; falling back to existing CSV.`);
    return readCsvIfExists(FILES.constructors, CONSTRUCTOR_HEADERS);
  }
  return baselineRows;
}

function findLatestSprintRound(calendarRows) {
  const now = getUpdateNow();

  const sprintRounds = calendarRows
    .filter(row => row.Round && row.SprintDate && row.SprintTime)
    .map(row => ({
      round: row.Round,
      dt: parseSastDateTime(row.SprintDate, row.SprintTime)
    }))
    .filter(row => row.dt && row.dt <= now)
    .sort((a, b) => b.dt - a.dt);

  return sprintRounds[0]?.round || '';
}

function parseSastDateTime(date, time) {
  const dt = new Date(`${date}T${time}:00+02:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getUpdateNow() {
  const override = process.env.F1_UPDATE_NOW;
  if (!override) return new Date();

  const dt = new Date(override);
  if (Number.isNaN(dt.getTime())) {
    console.log(`Ignoring invalid F1_UPDATE_NOW value: ${override}`);
    return new Date();
  }

  return dt;
}

async function assertDataDir() {
  try {
    const stat = await fs.stat(DATA_DIR);
    if (!stat.isDirectory()) throw new Error();
  } catch {
    throw new Error(`Missing data directory: ${DATA_DIR}`);
  }
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchJsonOnce(url);
    } catch (error) {
      lastError = error;

      if (attempt === FETCH_ATTEMPTS) break;

      console.log(
        `Fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed for ${url}: ${error.message}. Retrying in ${FETCH_RETRY_DELAY_MS / 1000}s...`
      );
      await sleep(FETCH_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function fetchJsonOnce(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'mysportzone-f1-updater/1.0'
      }
    });
  } catch (error) {
    throw new Error(`Network error while fetching ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Jolpica returned HTTP ${response.status} for ${url}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOptionalJson(url) {
  try {
    return await fetchJson(url);
  } catch (error) {
    console.log(`Optional Jolpica data unavailable: ${error.message}`);
    return null;
  }
}

function mapLatestRaceResults(payload) {
  const races = payload?.MRData?.RaceTable?.Races;
  if (!Array.isArray(races) || races.length === 0) return [];

  const race = races[0];
  const results = Array.isArray(race.Results) ? race.Results : [];
  if (!results.length) return [];

  return results.map(result => {
    const driver = result.Driver || {};
    const constructor = result.Constructor || {};
    const circuit = race.Circuit || {};
    const location = circuit.Location || {};

    return {
      Season: race.season || '',
      Round: race.round || '',
      RaceName: race.raceName || '',
      Circuit: circuit.circuitName || '',
      Country: location.country || '',
      Date: race.date || '',
      Position: result.positionText || result.position || '',
      Driver: formatDriverName(driver),
      Team: normalizeTeamName(constructor.name || ''),
      Grid: result.grid || '',
      Laps: result.laps || '',
      Time: result.Time?.time || '',
      Status: result.status || '',
      Points: result.points || '0'
    };
  });
}

function mapLatestSprintResults(payload) {
  const races = payload?.MRData?.RaceTable?.Races;
  if (!Array.isArray(races) || races.length === 0) return [];

  const race = races[0];
  const results = Array.isArray(race.SprintResults) ? race.SprintResults : [];
  if (!results.length) return [];

  return results.map(result => {
    const driver = result.Driver || {};
    const constructor = result.Constructor || {};
    const circuit = race.Circuit || {};
    const location = circuit.Location || {};

    return {
      Season: race.season || '',
      Round: race.round || '',
      RaceName: race.raceName || '',
      Circuit: circuit.circuitName || '',
      Country: location.country || '',
      Date: race.Sprint?.date || race.date || '',
      Position: result.positionText || result.position || '',
      Driver: formatDriverName(driver),
      Team: normalizeTeamName(constructor.name || ''),
      Grid: result.grid || '',
      Laps: result.laps || '',
      Time: result.Time?.time || '',
      Status: result.status || '',
      Points: result.points || '0'
    };
  });
}

function mapDriverStandings(payload, previousRows = []) {
  const standingsLists = payload?.MRData?.StandingsTable?.StandingsLists;
  const driverStandings = standingsLists?.[0]?.DriverStandings;
  if (!Array.isArray(driverStandings) || driverStandings.length === 0) return [];

  const previousPositionByDriver = new Map(
    previousRows
      .filter(row => row.Driver && row.Position)
      .map(row => [row.Driver, Number(row.Position)])
  );
  const previousPointsByDriver = new Map(
    previousRows
      .filter(row => row.Driver && row.Points !== '')
      .map(row => [row.Driver, Number(row.Points)])
  );
  const previousRowByDriver = new Map(
    previousRows
      .filter(row => row.Driver)
      .map(row => [row.Driver, row])
  );

  return driverStandings.map(item => {
    const driverName = formatDriverName(item.Driver || {});
    const previousRow = previousRowByDriver.get(driverName);

    return {
      Position: item.positionText || item.position || '',
      Change: positionChange(item.position, previousPositionByDriver.get(driverName), previousRow?.Change),
      Driver: driverName,
      Team: normalizeTeamName(item.Constructors?.[0]?.name || ''),
      CarNumber: item.Driver?.permanentNumber || '',
      Points: item.points || '0',
      PointsChange: pointsChange(item.points, previousPointsByDriver.get(driverName), previousRow?.PointsChange)
    };
  });
}

function positionChange(currentPosition, previousPosition, previousChange = '') {
  const current = Number(currentPosition);
  const previous = Number(previousPosition);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return '0';
  const change = previous - current;
  return change === 0 && previousChange !== '' ? String(previousChange) : String(change);
}

function pointsChange(currentPoints, previousPoints, previousChange = '') {
  const current = Number(currentPoints);
  const previous = Number(previousPoints);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return '0';
  const change = current - previous;
  return change === 0 && previousChange !== '' ? String(previousChange) : formatNumber(change);
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function mapConstructorStandings(payload, driverRows, previousRows = []) {
  const standingsLists = payload?.MRData?.StandingsTable?.StandingsLists;
  const constructorStandings = standingsLists?.[0]?.ConstructorStandings;
  if (!Array.isArray(constructorStandings) || constructorStandings.length === 0) return [];

  const driversByTeam = groupDriversByTeam(driverRows);
  const previousPositionByConstructor = new Map(
    previousRows
      .filter(row => row.Constructor && row.Position)
      .map(row => [row.Constructor, Number(row.Position)])
  );
  const previousRowByConstructor = new Map(
    previousRows
      .filter(row => row.Constructor)
      .map(row => [row.Constructor, row])
  );

  return constructorStandings.map(item => {
    const constructorName = normalizeTeamName(item.Constructor?.name || '');
    const drivers = driversByTeam.get(constructorName) || [];
    const previousRow = previousRowByConstructor.get(constructorName);

    return {
      Position: item.positionText || item.position || '',
      Change: positionChange(item.position, previousPositionByConstructor.get(constructorName), previousRow?.Change),
      Constructor: constructorName,
      Driver1: drivers[0]?.Driver || '',
      Driver1Points: drivers[0]?.Points || '0',
      Driver2: drivers[1]?.Driver || '',
      Driver2Points: drivers[1]?.Points || '0',
      Points: item.points || '0'
    };
  });
}

function groupDriversByTeam(driverRows) {
  const grouped = new Map();

  for (const row of driverRows) {
    if (!row.Team) continue;
    const current = grouped.get(row.Team) || [];
    current.push(row);
    grouped.set(row.Team, current);
  }

  for (const drivers of grouped.values()) {
    drivers.sort((a, b) => Number(b.Points || 0) - Number(a.Points || 0));
  }

  return grouped;
}

async function upsertResultRows(filePath, latestRows, headers, label) {
  const latestSeason = latestRows[0]?.Season;
  const latestRound = latestRows[0]?.Round;

  if (!latestSeason || !latestRound) {
    console.log(`Latest ${label} result is missing season or round. Existing ${path.basename(filePath)} was left unchanged.`);
    return false;
  }

  const existingRows = await readCsvIfExists(filePath, headers);
  const retainedRows = existingRows.filter(row => row.Season !== latestSeason || row.Round !== latestRound);
  const nextRows = [...retainedRows, ...latestRows].sort(compareResultRows);

  return writeCsvIfChanged(filePath, headers, nextRows);
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

function formatDriverName(driver) {
  const name = [driver.givenName, driver.familyName].filter(Boolean).join(' ').trim() || driver.driverId || '';
  return DRIVER_NAME_ALIASES[name] || name;
}

function normalizeTeamName(name) {
  return TEAM_NAME_ALIASES[name] || name;
}

function compareResultRows(a, b) {
  const seasonDiff = Number(a.Season || 0) - Number(b.Season || 0);
  if (seasonDiff !== 0) return seasonDiff;

  const roundDiff = Number(a.Round || 0) - Number(b.Round || 0);
  if (roundDiff !== 0) return roundDiff;

  return Number(a.Position || 999) - Number(b.Position || 999);
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}
