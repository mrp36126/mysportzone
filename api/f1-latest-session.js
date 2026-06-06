const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CALENDAR_FILE = path.join(DATA_DIR, 'f1_calendar.csv');

const SESSION_DEFS = [
  { key: 'fp1', label: 'Free Practice 1', shortLabel: 'FP1', dateCol: 'FP1Date', timeCol: 'FP1Time', path: 'fp1', resultKey: 'fp1Results', durationMinutes: 75 },
  { key: 'fp2', label: 'Free Practice 2', shortLabel: 'FP2', dateCol: 'FP2Date', timeCol: 'FP2Time', path: 'fp2', resultKey: 'fp2Results', durationMinutes: 75 },
  { key: 'sprintQualy', label: 'Sprint Qualifying', shortLabel: 'Sprint Qualifying', dateCol: 'SprintQualiDate', timeCol: 'SprintQualiTime', path: 'sprint/qualy', resultKey: 'sprintQualyResults', durationMinutes: 75 },
  { key: 'sprint', label: 'Sprint Result', shortLabel: 'Sprint', dateCol: 'SprintDate', timeCol: 'SprintTime', path: 'sprint/race', resultKey: 'sprintRaceResults', durationMinutes: 90 },
  { key: 'fp3', label: 'Free Practice 3', shortLabel: 'FP3', dateCol: 'FP3Date', timeCol: 'FP3Time', path: 'fp3', resultKey: 'fp3Results', durationMinutes: 75 },
  { key: 'qualy', label: 'Qualifying Result', shortLabel: 'Qualifying', dateCol: 'QualiDate', timeCol: 'QualiTime', path: 'qualy', resultKey: 'qualyResults', durationMinutes: 90 },
  { key: 'race', label: 'Race Result', shortLabel: 'Race', dateCol: 'RaceDate', timeCol: 'RaceTime', path: 'race', resultKey: 'raceResults', durationMinutes: 210 }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: true, message: 'Method not allowed' });
  }

  try {
    const calendar = parseCsv(await fs.readFile(CALENDAR_FILE, 'utf8'));
    const now = currentDate();
    const weekend = findRelevantWeekend(calendar, now);

    if (!weekend) {
      return res.status(200).json({ status: 'no-current-session', session: null, rows: [] });
    }

    const providerRound = await findProviderRound(weekend).catch(() => weekend.Round);
    const completedSessions = buildSessions(weekend)
      .filter(session => session.completedAt <= now)
      .sort((a, b) => b.completedAt - a.completedAt);

    for (const session of completedSessions) {
      const rows = await fetchOpenF1TimingRows(weekend, session).catch(() => []);
      const payload = rows.length > 0 ? null : await fetchSession(weekend, session, providerRound).catch(() => null);
      const mappedRows = rows.length > 0 ? rows : mapSessionRows(payload, weekend, session);
      if (mappedRows.length > 0 && sessionMatchesWeekend(mappedRows[0], weekend)) {
        return res.status(200).json({
          status: 'ok',
          source: rows.length > 0 ? 'openf1.org' : 'f1api.dev',
          label: session.label,
          shortLabel: session.shortLabel,
          sessionKey: session.key,
          season: mappedRows[0].Season,
          round: mappedRows[0].Round,
          raceName: mappedRows[0].RaceName,
          country: mappedRows[0].Country,
          date: mappedRows[0].Date,
          rows: mappedRows
        });
      }
    }

    return res.status(200).json({ status: 'no-session-results', session: null, rows: [] });
  } catch (error) {
    console.error('Latest F1 session API error:', error);
    return res.status(500).json({ error: true, message: 'Latest F1 session unavailable' });
  }
};

function findRelevantWeekend(calendar, now) {
  const weekends = calendar
    .map(row => ({
      ...row,
      sessions: buildSessions(row)
    }))
    .filter(row => row.sessions.length > 0)
    .map(row => {
      const firstSession = row.sessions[0].dt;
      const raceSession = row.sessions.find(session => session.key === 'race') || row.sessions[row.sessions.length - 1];
      const end = new Date(raceSession.completedAt.getTime() + (18 * 60 * 60 * 1000));
      return { ...row, firstSession, end };
    });

  return weekends.find(row => row.firstSession <= now && row.end >= now)
    || weekends.filter(row => row.firstSession <= now).sort((a, b) => b.firstSession - a.firstSession)[0]
    || null;
}

function sessionMatchesWeekend(row, weekend) {
  const apiCountry = normalize(row.Country);
  const apiRaceName = normalize(row.RaceName);
  const apiCircuit = normalize(row.Circuit);
  const localCountry = normalize(weekend.Country);
  const localRaceName = normalize(weekend.RaceName);
  const localCircuit = normalize(weekend.Circuit);

  return (apiCountry && apiCountry === localCountry)
    || (apiRaceName && localRaceName && (apiRaceName.includes(localRaceName) || localRaceName.includes(apiRaceName)))
    || (apiCircuit && localCircuit && (apiCircuit.includes(localCircuit) || localCircuit.includes(apiCircuit)));
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(grand prix|formula 1|gp|2026|2025|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildSessions(row) {
  return SESSION_DEFS
    .map(def => {
      const date = row[def.dateCol];
      const time = row[def.timeCol];
      const dt = parseSastDateTime(date, time);
      if (!dt) return null;
      return {
        ...def,
        dt,
        completedAt: new Date(dt.getTime() + (def.durationMinutes * 60 * 1000))
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.dt - b.dt);
}

async function findProviderRound(weekend) {
  const season = encodeURIComponent(getSeason(weekend));
  const response = await fetch(`https://f1api.dev/api/${season}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'mysportzone-f1-session-results/1.0'
    }
  });

  if (!response.ok) throw new Error(`F1 API schedule returned ${response.status}`);
  const payload = await response.json();
  const races = Array.isArray(payload.races) ? payload.races : [];
  const matchIndex = races.findIndex(race => providerRaceMatchesWeekend(race, weekend));

  return matchIndex >= 0 ? String(matchIndex + 1) : String(weekend.Round);
}

function providerRaceMatchesWeekend(race, weekend) {
  const providerName = normalize(race.raceName);
  const providerId = normalize(race.raceId);
  const providerDate = race.schedule?.race?.date || '';
  const localName = normalize(weekend.RaceName);
  const localCountry = normalize(weekend.Country);
  const localDate = weekend.RaceDate || '';

  return (providerDate && localDate && providerDate === localDate)
    || (providerName && localName && (providerName.includes(localName) || localName.includes(providerName)))
    || (providerName && localCountry && providerName.includes(localCountry))
    || (providerId && localCountry && providerId.includes(localCountry));
}

async function fetchSession(weekend, session, providerRound) {
  const season = encodeURIComponent(getSeason(weekend));
  const round = encodeURIComponent(providerRound || weekend.Round);
  const url = `https://f1api.dev/api/${season}/${round}/${session.path}?limit=30`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'mysportzone-f1-session-results/1.0'
    }
  });

  if (!response.ok) throw new Error(`F1 API returned ${response.status}`);
  return response.json();
}

async function fetchOpenF1TimingRows(weekend, session) {
  const openF1SessionName = {
    fp1: 'Practice 1',
    fp2: 'Practice 2',
    fp3: 'Practice 3',
    sprintQualy: 'Sprint Qualifying',
    qualy: 'Qualifying'
  }[session.key];

  if (!openF1SessionName) return [];

  const year = encodeURIComponent(getSeason(weekend));
  const country = encodeURIComponent(weekend.Country || '');
  const sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${year}&country_name=${country}`);
  const openF1Session = sessions.find(row => {
    const localDate = weekend[session.dateCol] || '';
    return row.session_name === openF1SessionName
      && (!localDate || String(row.date_start || '').slice(0, 10) === localDate);
  });

  if (!openF1Session?.session_key) return [];

  const sessionKey = encodeURIComponent(openF1Session.session_key);
  const [drivers, laps] = await Promise.all([
    fetchJson(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`),
    fetchJson(`https://api.openf1.org/v1/laps?session_key=${sessionKey}`)
  ]);

  const driversByNumber = new Map(drivers.map(driver => [Number(driver.driver_number), driver]));
  const bestLaps = new Map();

  laps.forEach(lap => {
    const driverNumber = Number(lap.driver_number);
    const lapDuration = Number(lap.lap_duration);
    if (!Number.isFinite(driverNumber) || !Number.isFinite(lapDuration) || lapDuration <= 0) return;

    const existing = bestLaps.get(driverNumber);
    if (!existing || lapDuration < existing.lapDuration) {
      bestLaps.set(driverNumber, {
        lapDuration,
        lapNumber: lap.lap_number || ''
      });
    }
  });

  return [...bestLaps.entries()]
    .map(([driverNumber, best]) => {
      const driver = driversByNumber.get(driverNumber) || {};
      return {
        driver,
        best
      };
    })
    .sort((a, b) => a.best.lapDuration - b.best.lapDuration)
    .map((entry, index) => ({
      Season: String(openF1Session.year || getSeason(weekend)),
      Round: String(weekend.Round || ''),
      RaceName: weekend.RaceName || '',
      Circuit: openF1Session.circuit_short_name || weekend.Circuit || '',
      Country: openF1Session.country_name || weekend.Country || '',
      Date: String(openF1Session.date_start || weekend[session.dateCol] || '').slice(0, 10),
      Position: String(index + 1),
      Driver: formatOpenF1DriverName(entry.driver),
      Team: entry.driver.team_name || '',
      Grid: '',
      Laps: entry.best.lapNumber,
      Time: formatLapTime(entry.best.lapDuration),
      Status: '',
      Points: '',
      FastestLapRank: index === 0 ? '1' : '',
      FastestLapTime: index === 0 ? formatLapTime(entry.best.lapDuration) : '',
      FastestLapLap: index === 0 ? entry.best.lapNumber : ''
    }))
    .filter(row => row.Driver);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'mysportzone-f1-session-results/1.0'
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function formatOpenF1DriverName(driver) {
  if (driver.first_name || driver.last_name) {
    return [driver.first_name, titleCase(driver.last_name)].filter(Boolean).join(' ');
  }

  return titleCase(driver.full_name || '');
}

function titleCase(value) {
  return String(value || '').toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function formatLapTime(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total)) return '';

  const minutes = Math.floor(total / 60);
  const remainder = (total - (minutes * 60)).toFixed(3).padStart(6, '0');
  return `${minutes}:${remainder}`;
}

function mapSessionRows(payload, weekend, session) {
  const race = payload?.races || {};
  const results = findResultsArray(race, session);
  const season = String(payload?.season || getSeason(weekend));

  return results.map((result, index) => {
    const driver = result.driver || {};
    const team = result.team || {};
    const position = result.position || result.gridPosition || result[`${session.key}Position`] || index + 1;

    return {
      Season: season,
      Round: String(race.round || weekend.Round || ''),
      RaceName: race.raceName || weekend.EventName || weekend.RaceName || '',
      Circuit: race.circuit?.circuitName || weekend.Circuit || '',
      Country: race.circuit?.country || weekend.Country || '',
      Date: race[`${session.key}Date`] || weekend[session.dateCol] || '',
      Position: String(position),
      Driver: [driver.name, driver.surname].filter(Boolean).join(' ') || result.driverName || '',
      Team: team.teamName || result.teamName || '',
      Grid: result.grid || result.gridPosition || '',
      Laps: result.laps || '',
      Time: result.time || result.q1 || result.q2 || result.q3 || '',
      Status: result.status || '',
      Points: result.points || '',
      FastestLapRank: '',
      FastestLapTime: '',
      FastestLapLap: ''
    };
  }).filter(row => row.Driver);
}

function findResultsArray(race, session) {
  const candidates = [
    session.resultKey,
    `${session.key}Results`,
    'results',
    'raceResults',
    'sprintRaceResults',
    'sprintQualyResults',
    'qualyResults',
    'fp1Results',
    'fp2Results',
    'fp3Results'
  ];

  for (const key of candidates) {
    if (Array.isArray(race[key])) return race[key];
  }

  return [];
}

function getSeason(row) {
  return String(row.RaceDate || '').slice(0, 4) || 'current';
}

function parseSastDateTime(date, time) {
  if (!date || !time) return null;
  const safeTime = /^\d{1,2}:\d{2}$/.test(time) ? time : '00:00';
  const parsed = new Date(`${date}T${safeTime}:00+02:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function currentDate() {
  const override = process.env.F1_SESSION_NOW;
  if (!override) return new Date();
  const parsed = new Date(override);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

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
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += ch;
    }
  }

  row.push(value);
  if (row.some(cell => cell.trim() !== '')) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map(header => header.trim());
  return rows.slice(1).map(values => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || '';
    });
    return obj;
  });
}
