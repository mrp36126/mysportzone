const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CALENDAR_FILE = path.join(DATA_DIR, 'f1_calendar.csv');
const CACHE_FILE = path.join(DATA_DIR, 'f1_latest_session.json');
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 1000;

const SESSION_DEFS = [
  { key: 'fp1', label: 'Free Practice 1', shortLabel: 'FP1', dateCol: 'FP1Date', timeCol: 'FP1Time', path: 'fp1', resultKey: 'fp1Results', durationMinutes: 75 },
  { key: 'fp2', label: 'Free Practice 2', shortLabel: 'FP2', dateCol: 'FP2Date', timeCol: 'FP2Time', path: 'fp2', resultKey: 'fp2Results', durationMinutes: 75 },
  { key: 'sprintQualy', label: 'Sprint Qualifying', shortLabel: 'Sprint Qualifying', dateCol: 'SprintQualiDate', timeCol: 'SprintQualiTime', path: 'sprint/qualy', jolpicaPaths: ['sprintqualifying', 'sprintshootout', 'sprintqualy'], resultKey: 'sprintQualyResults', durationMinutes: 75 },
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

  let weekend = null;

  try {
    const calendar = parseCsv(await fs.readFile(CALENDAR_FILE, 'utf8'));
    const now = currentDate();
    weekend = findRelevantWeekend(calendar, now);

    if (!weekend) {
      return res.status(200).json({ status: 'no-current-session', session: null, rows: [] });
    }

    const completedSessions = buildSessions(weekend)
      .filter(session => session.completedAt <= now)
      .sort((a, b) => b.completedAt - a.completedAt);
    if (!completedSessions.length) {
      return res.status(200).json({ status: 'no-completed-session', session: null, rows: [] });
    }

    const payload = await resolveLatestSessionPayload(weekend, completedSessions);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('Latest F1 session API error:', error);
    try {
      const cached = await readCachedLatestSession(weekend);
      if (cached) {
        console.warn('Latest F1 session API using cached payload after live lookup failure.');
        return res.status(200).json({ ...cached, cached: true });
      }
    } catch (cacheError) {
      console.error('Latest F1 session cache read failed:', cacheError);
    }

    return res.status(500).json({ error: true, message: 'Latest F1 session unavailable' });
  }
};

async function resolveLatestSessionPayload(weekend, completedSessions) {
  for (const session of completedSessions) {
    const payload = await fetchSessionRowsForSession(weekend, session);
    if (payload.rows.length > 0) {
      return payload;
    }
  }

  const cached = await readCachedLatestSession(weekend).catch(() => null);
  if (cached) {
    return { ...cached, cached: true };
  }

  const session = completedSessions[0];
  return {
    status: 'pending-session-results',
    source: null,
    label: session.label,
    shortLabel: session.shortLabel,
    sessionKey: session.key,
    season: getSeason(weekend),
    round: String(weekend.Round || ''),
    raceName: weekend.RaceName || '',
    country: weekend.Country || '',
    date: weekend[session.dateCol] || '',
    rows: []
  };
}

async function fetchSessionRowsForSession(weekend, session) {
  const jolpicaRows = await fetchJolpicaSessionRows(weekend, session).catch(() => []);
  const useJolpica = jolpicaRows.length > 0 && sessionMatchesWeekend(jolpicaRows[0], weekend);
  const openF1Rows = useJolpica ? [] : await fetchOpenF1TimingRows(weekend, session).catch(() => []);
  const mappedRows = useJolpica ? jolpicaRows : openF1Rows;

  if (mappedRows.length > 0 && sessionMatchesWeekend(mappedRows[0], weekend)) {
    return {
      status: 'ok',
      source: useJolpica ? 'jolpica' : 'openf1.org',
      label: session.label,
      shortLabel: session.shortLabel,
      sessionKey: session.key,
      season: mappedRows[0].Season,
      round: mappedRows[0].Round,
      raceName: mappedRows[0].RaceName,
      country: mappedRows[0].Country,
      date: mappedRows[0].Date,
      rows: mappedRows
    };
  }

  return {
    status: 'session-results-pending',
    source: null,
    label: session.label,
    shortLabel: session.shortLabel,
    sessionKey: session.key,
    season: getSeason(weekend),
    round: String(weekend.Round || ''),
    raceName: weekend.RaceName || '',
    country: weekend.Country || '',
    date: weekend[session.dateCol] || '',
    rows: []
  };
}

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

  return (apiCountry && countryMatches(apiCountry, localCountry))
    || (apiRaceName && localRaceName && (apiRaceName.includes(localRaceName) || localRaceName.includes(apiRaceName)))
    || (apiCircuit && localCircuit && (apiCircuit.includes(localCircuit) || localCircuit.includes(apiCircuit)));
}

function countryMatches(apiCountry, localCountry) {
  const apiCountries = expandCountryAliases(apiCountry);
  const localCountries = expandCountryAliases(localCountry);

  return apiCountries.some(country => localCountries.includes(country));
}

function expandCountryAliases(value) {
  const normalized = normalize(value);
  if (!normalized) return [];

  const aliases = {
    uk: ['united kingdom', 'great britain', 'britain'],
    usa: ['united states', 'united states of america', 'america'],
    uae: ['united arab emirates'],
    ksa: ['saudi arabia'],
    'south korea': ['korea'],
    'czech republic': ['czechia']
  };

  return [normalized, ...(aliases[normalized] || [])];
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
  const season = encodeURIComponent(getSeason(weekend));
  const round = encodeURIComponent(weekend.Round || '');
  if (!round) return [];

  for (const jolpicaPath of getJolpicaPathCandidates(session)) {
    const payload = await fetchJson(`https://api.jolpi.ca/ergast/f1/${season}/${round}/${jolpicaPath}.json`).catch(() => null);
    const race = payload?.MRData?.RaceTable?.Races?.[0];
    if (!race) continue;

    const resultKey = pickJolpicaResultKey(race, session);
    if (!resultKey) continue;

    if (session.key === 'qualy' || session.key === 'sprintQualy') {
      return mapJolpicaQualifyingRows(race, weekend, session, resultKey);
    }

    if (session.key === 'sprint') return mapJolpicaClassificationRows(race, weekend, session, resultKey);
    if (session.key === 'race') return mapJolpicaClassificationRows(race, weekend, session, resultKey);
  }

  return [];
}

function getJolpicaPathCandidates(session) {
  if (Array.isArray(session.jolpicaPaths) && session.jolpicaPaths.length > 0) {
    return session.jolpicaPaths;
  }

  if (session.jolpicaPath) return [session.jolpicaPath];
  return [];
}

function pickJolpicaResultKey(race, session) {
  const resultKeysBySession = {
    sprintQualy: ['QualifyingResults', 'SprintQualifyingResults', 'SprintShootoutResults'],
    qualy: ['QualifyingResults'],
    sprint: ['SprintResults', 'Results'],
    race: ['Results']
  };

  const candidateKeys = resultKeysBySession[session.key] || [];
  return candidateKeys.find(key => Array.isArray(race[key]) && race[key].length > 0) || '';
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

function mapJolpicaQualifyingRows(race, weekend, session, resultKey = 'QualifyingResults') {
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
  const year = encodeURIComponent(getSeason(weekend));
  const country = encodeURIComponent(weekend.Country || '');
  let sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${year}&country_name=${country}`);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${year}`);
  }
  const openF1Session = findOpenF1Session(sessions, weekend, session);

  if (!openF1Session?.session_key) return [];

  const sessionKey = encodeURIComponent(openF1Session.session_key);
  const drivers = await fetchJson(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`);
  const driversByNumber = new Map(drivers.map(driver => [Number(driver.driver_number), driver]));

  if (session.key === 'race' || session.key === 'sprint') {
    const positions = await fetchJson(`https://api.openf1.org/v1/position?session_key=${sessionKey}`).catch(() => []);
    const latestPositions = new Map();
    const pointsByPosition = session.key === 'sprint'
      ? [8, 7, 6, 5, 4, 3, 2, 1]
      : [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

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
          Points: String(pointsByPosition[entry.latest.position - 1] || 0),
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
  let lastError = null;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'mysportzone-f1-session-results/1.0'
        }
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} for ${url}${responseText ? ` :: ${responseText.slice(0, 120)}` : ''}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await delay(FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || new Error(`Unable to fetch ${url}`);
}

function findOpenF1Session(sessions, weekend, session) {
  const targetNames = openF1SessionNameCandidates(session);
  const localDate = weekend[session.dateCol] || '';
  const localDates = expandDateWindow(localDate);

  return sessions.find(row => {
    const apiName = normalize(row.session_name);
    const apiDate = String(row.date_start || '').slice(0, 10);
    return targetNames.some(targetName => apiName.includes(targetName) || targetName.includes(apiName))
      && (localDates.length === 0 || localDates.includes(apiDate));
  }) || sessions.find(row => targetNames.includes(normalize(row.session_name))) || null;
}

function openF1SessionNameCandidates(session) {
  const namesByKey = {
    fp1: ['Practice 1', 'FP1'],
    fp2: ['Practice 2', 'FP2'],
    fp3: ['Practice 3', 'FP3'],
    sprintQualy: ['Sprint Qualifying', 'Sprint Shootout', 'Sprint Qualy'],
    sprint: ['Sprint'],
    qualy: ['Qualifying', 'Qualifying Session'],
    race: ['Race', 'Grand Prix']
  };

  return (namesByKey[session.key] || [session.shortLabel || session.label || session.key])
    .map(normalize)
    .filter(Boolean);
}

function expandDateWindow(date) {
  if (!date) return [];

  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return [date];

  return [
    toIsoDate(parsed),
    toIsoDate(new Date(parsed.getTime() - (24 * 60 * 60 * 1000))),
    toIsoDate(new Date(parsed.getTime() + (24 * 60 * 60 * 1000)))
  ];
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function readCachedLatestSession(weekend = null) {
  const text = await fs.readFile(CACHE_FILE, 'utf8');
  const cached = JSON.parse(text);
  if (!cached || typeof cached !== 'object' || !Array.isArray(cached.rows)) return null;
  if (cached.status !== 'ok' || cached.rows.length === 0) return null;

  if (weekend) {
    const weekendSeason = String(getSeason(weekend));
    const weekendRound = String(weekend.Round || '');
    const cachedSeason = String(cached.season || cached.rows[0]?.Season || '');
    const cachedRound = String(cached.round || cached.rows[0]?.Round || '');

    if (!weekendRound || cachedSeason !== weekendSeason || cachedRound !== weekendRound) {
      return null;
    }
  }

  return cached;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
