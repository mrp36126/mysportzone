const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CALENDAR_FILE = path.join(DATA_DIR, 'f1_calendar.csv');

const SESSION_DEFS = [
  { key: 'fp1', label: 'Free Practice 1', shortLabel: 'FP1', dateCol: 'FP1Date', timeCol: 'FP1Time', path: 'fp1', resultKey: 'fp1Results', durationMinutes: 75 },
  { key: 'fp2', label: 'Free Practice 2', shortLabel: 'FP2', dateCol: 'FP2Date', timeCol: 'FP2Time', path: 'fp2', resultKey: 'fp2Results', durationMinutes: 75 },
  { key: 'sprintQualy', label: 'Sprint Qualifying', shortLabel: 'Sprint Qualifying', dateCol: 'SprintQualiDate', timeCol: 'SprintQualiTime', path: 'sprint/qualy', resultKey: 'sprintQualyResults', durationMinutes: 75 },
  { key: 'sprint', label: 'Sprint Result', shortLabel: 'Sprint', dateCol: 'SprintDate', timeCol: 'SprintTime', path: 'sprint/race', resultKey: 'sprintRaceResults', jolpicaPath: 'sprint', durationMinutes: 90 },
  { key: 'fp3', label: 'Free Practice 3', shortLabel: 'FP3', dateCol: 'FP3Date', timeCol: 'FP3Time', path: 'fp3', resultKey: 'fp3Results', durationMinutes: 75 },
  { key: 'qualy', label: 'Qualifying Result', shortLabel: 'Qualifying', dateCol: 'QualiDate', timeCol: 'QualiTime', path: 'qualy', resultKey: 'qualyResults', jolpicaPath: 'qualifying', durationMinutes: 90 },
  { key: 'race', label: 'Race Result', shortLabel: 'Race', dateCol: 'RaceDate', timeCol: 'RaceTime', path: 'race', resultKey: 'raceResults', jolpicaPath: 'results', durationMinutes: 150 }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const shouldBypassCache = Boolean(req.query?.refresh);
  res.setHeader('Cache-Control', shouldBypassCache ? 'no-store' : 's-maxage=180, stale-while-revalidate=600');
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

    const completedSessions = buildSessions(weekend)
      .filter(session => session.completedAt <= now)
      .sort((a, b) => b.completedAt - a.completedAt);
    const latestCompletedSession = completedSessions[0];

    if (!latestCompletedSession) {
      return res.status(200).json({ status: 'no-completed-session', session: null, rows: [] });
    }

    const jolpicaRows = await fetchJolpicaSessionRows(weekend, latestCompletedSession).catch(() => []);
    const useJolpica = jolpicaRows.length > 0 && sessionMatchesWeekend(jolpicaRows[0], weekend);
    const openF1Rows = useJolpica ? [] : await fetchOpenF1TimingRows(weekend, latestCompletedSession).catch(() => []);
    const mappedRows = useJolpica ? jolpicaRows : openF1Rows;

    if (mappedRows.length > 0 && sessionMatchesWeekend(mappedRows[0], weekend)) {
      return res.status(200).json({
        status: 'ok',
        source: useJolpica ? 'jolpica' : 'openf1.org',
        label: latestCompletedSession.label,
        shortLabel: latestCompletedSession.shortLabel,
        sessionKey: latestCompletedSession.key,
        season: mappedRows[0].Season,
        round: mappedRows[0].Round,
        raceName: mappedRows[0].RaceName,
        country: mappedRows[0].Country,
        date: mappedRows[0].Date,
        rows: mappedRows
      });
    }

    return res.status(200).json({
      status: 'pending-session-results',
      source: null,
      label: latestCompletedSession.label,
      shortLabel: latestCompletedSession.shortLabel,
      sessionKey: latestCompletedSession.key,
      season: getSeason(weekend),
      round: String(weekend.Round || ''),
      raceName: weekend.RaceName || '',
      country: weekend.Country || '',
      date: weekend[latestCompletedSession.dateCol] || '',
      rows: []
    });
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

async function fetchJolpicaSessionRows(weekend, session) {
  if (!session.jolpicaPath) return [];

  const season = encodeURIComponent(getSeason(weekend));
  const round = encodeURIComponent(weekend.Round || '');
  if (!round) return [];

  const payload = await fetchJson(`https://api.jolpi.ca/ergast/f1/${season}/${round}/${session.jolpicaPath}.json`);
  const race = payload?.MRData?.RaceTable?.Races?.[0];
  if (!race) return [];

  if (session.key === 'qualy') return mapJolpicaQualifyingRows(race, weekend, session);
  if (session.key === 'sprint') return mapJolpicaClassificationRows(race, weekend, session, 'SprintResults');
  if (session.key === 'race') return mapJolpicaClassificationRows(race, weekend, session, 'Results');
  return [];
}

function mapJolpicaClassificationRows(race, weekend, session, resultKey) {
  const results = Array.isArray(race[resultKey]) ? race[resultKey] : [];
  return results.map(result => {
    const driver = result.Driver || {};
    const constructor = result.Constructor || {};
    const circuit = race.Circuit || {};
    const location = circuit.Location || {};

    return {
      Season: race.season || getSeason(weekend),
      Round: race.round || String(weekend.Round || ''),
      RaceName: race.raceName || weekend.RaceName || '',
      Circuit: circuit.circuitName || weekend.Circuit || '',
      Country: location.country || weekend.Country || '',
      Date: session.key === 'sprint' ? race.Sprint?.date || race.date || weekend[session.dateCol] || '' : race.date || weekend[session.dateCol] || '',
      Position: result.positionText || result.position || '',
      Driver: formatJolpicaDriverName(driver),
      Team: constructor.name || '',
      Grid: result.grid || '',
      Laps: result.laps || '',
      Time: result.Time?.time || '',
      Status: result.status || '',
      Points: result.points || '',
      FastestLapRank: result.FastestLap?.rank || '',
      FastestLapTime: result.FastestLap?.Time?.time || '',
      FastestLapLap: result.FastestLap?.lap || ''
    };
  }).filter(row => row.Driver);
}

function mapJolpicaQualifyingRows(race, weekend, session) {
  const results = Array.isArray(race.QualifyingResults) ? race.QualifyingResults : [];
  return results.map(result => {
    const driver = result.Driver || {};
    const constructor = result.Constructor || {};
    const circuit = race.Circuit || {};
    const location = circuit.Location || {};

    return {
      Season: race.season || getSeason(weekend),
      Round: race.round || String(weekend.Round || ''),
      RaceName: race.raceName || weekend.RaceName || '',
      Circuit: circuit.circuitName || weekend.Circuit || '',
      Country: location.country || weekend.Country || '',
      Date: race.date || weekend[session.dateCol] || '',
      Position: result.position || '',
      Driver: formatJolpicaDriverName(driver),
      Team: constructor.name || '',
      Grid: '',
      Laps: '',
      Time: result.Q3 || result.Q2 || result.Q1 || '',
      Status: '',
      Points: '',
      FastestLapRank: '',
      FastestLapTime: '',
      FastestLapLap: ''
    };
  }).filter(row => row.Driver);
}

async function fetchOpenF1TimingRows(weekend, session) {
  const openF1SessionName = {
    fp1: 'Practice 1',
    fp2: 'Practice 2',
    fp3: 'Practice 3',
    sprintQualy: 'Sprint Qualifying',
    sprint: 'Sprint',
    qualy: 'Qualifying',
    race: 'Race'
  }[session.key];

  if (!openF1SessionName) return [];

  const year = encodeURIComponent(getSeason(weekend));
  const country = encodeURIComponent(weekend.Country || '');
  let sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${year}&country_name=${country}`);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${year}`);
  }
  const openF1Session = sessions.find(row => {
    const localDate = weekend[session.dateCol] || '';
    return row.session_name === openF1SessionName
      && (!localDate || String(row.date_start || '').slice(0, 10) === localDate);
  });

  if (!openF1Session?.session_key) return [];

  const sessionKey = encodeURIComponent(openF1Session.session_key);
  const drivers = await fetchJson(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`);
  const driversByNumber = new Map(drivers.map(driver => [Number(driver.driver_number), driver]));

  if (session.key === 'race' || session.key === 'sprint') {
    const positions = await fetchJson(`https://api.openf1.org/v1/position?session_key=${sessionKey}`).catch(() => []);
    const latestPositions = new Map();

    positions.forEach(positionRow => {
      const driverNumber = Number(positionRow.driver_number);
      const position = Number(positionRow.position);
      const date = new Date(positionRow.date || '');
      if (!Number.isFinite(driverNumber) || !Number.isFinite(position) || Number.isNaN(date.getTime())) return;

      const existing = latestPositions.get(driverNumber);
      if (!existing || date > existing.date) {
        latestPositions.set(driverNumber, { position, date });
      }
    });

    if (latestPositions.size > 0) {
      return [...latestPositions.entries()]
        .map(([driverNumber, latest]) => ({
          driver: driversByNumber.get(driverNumber) || {},
          latest
        }))
        .filter(entry => entry.driver.driver_number)
        .sort((a, b) => a.latest.position - b.latest.position)
        .map(entry => ({
          Season: String(openF1Session.year || getSeason(weekend)),
          Round: String(weekend.Round || ''),
          RaceName: weekend.RaceName || '',
          Circuit: openF1Session.circuit_short_name || weekend.Circuit || '',
          Country: openF1Session.country_name || weekend.Country || '',
          Date: String(openF1Session.date_start || weekend[session.dateCol] || '').slice(0, 10),
          Position: String(entry.latest.position),
          Driver: formatOpenF1DriverName(entry.driver),
          Team: entry.driver.team_name || '',
          Grid: '',
          Laps: '',
          Time: '',
          Status: 'OpenF1 provisional classification',
          Points: '',
          FastestLapRank: '',
          FastestLapTime: '',
          FastestLapLap: ''
        }))
        .filter(row => row.Driver);
    }
  }

  const laps = await fetchJson(`https://api.openf1.org/v1/laps?session_key=${sessionKey}`);
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

function formatJolpicaDriverName(driver) {
  return [driver.givenName, driver.familyName].filter(Boolean).join(' ').trim() || driver.driverId || '';
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
