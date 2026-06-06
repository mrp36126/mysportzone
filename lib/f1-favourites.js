const fs = require('fs/promises');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const FILES = {
  calendar: path.join(DATA_DIR, 'f1_calendar.csv'),
  results: path.join(DATA_DIR, 'f1_results.csv'),
  sprintResults: path.join(DATA_DIR, 'f1_sprint_results.csv'),
  drivers: path.join(DATA_DIR, 'f1_drivers.csv'),
  constructors: path.join(DATA_DIR, 'f1_constructors.csv')
};

const SCORE_WEIGHTS = {
  form: 0.30,
  qualifying: 0.18,
  team: 0.22,
  track: 0.14,
  practice: 0.08,
  weather: 0.04,
  sentiment: 0.04
};

const WEEKEND_SCORE_WEIGHTS = {
  form: 0.15,
  qualifying: 0.08,
  team: 0.10,
  track: 0.09,
  practice: 0.50,
  weather: 0.04,
  sentiment: 0.04
};

const QUALIFYING_SCORE_WEIGHTS = {
  form: 0.18,
  qualifying: 0.30,
  team: 0.18,
  track: 0.09,
  practice: 0.17,
  weather: 0.04,
  sentiment: 0.04
};

const POINTS_BY_POSITION = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const NEUTRAL_SCORE = 50;
const CURRENT_SEASON = 'current';

async function buildF1Favourites({ preferCache = false, persist = false } = {}) {
  const calendar = await readCsvIfExists(FILES.calendar);
  const drivers = await readCsvIfExists(FILES.drivers);
  const constructors = await readCsvIfExists(FILES.constructors);
  const localRaceResults = await readCsvIfExists(FILES.results);
  const localSprintResults = await readCsvIfExists(FILES.sprintResults);
  const nextRace = findNextRace(calendar);

  if (!nextRace) {
    return {
      status: 'off-season',
      race: null,
      updated_at: new Date().toISOString(),
      favourites: []
    };
  }

  if (preferCache) {
    const cached = await fetchCachedFavourites(nextRace.Round);
    if (cached.length > 0) {
      return formatResponse(nextRace, cached, cached[0].updated_at, true);
    }
  }

  const [raceResults, sprintResults, weatherScore, sentimentScores] = await Promise.all([
    fetchRaceResults().then(rows => rows.length ? rows : localRaceResults).catch(() => localRaceResults),
    Promise.resolve(localSprintResults),
    fetchWeatherScore(nextRace).catch(() => NEUTRAL_SCORE),
    fetchSentimentScores(drivers, nextRace).catch(() => new Map())
  ]);
  const practiceRows = await fetchPracticeResults(nextRace).catch(() => []);
  const qualifyingRows = await fetchQualifyingResults(nextRace).catch(() => []);

  const rows = calculateFavourites({
    nextRace,
    drivers,
    constructors,
    raceResults,
    sprintResults,
    qualifyingRows,
    practiceRows,
    weatherScore,
    sentimentScores
  });

  if (persist && rows.length > 0) {
    await upsertFavourites(rows).catch(error => {
      console.warn(`Supabase favourites upsert skipped: ${error.message}`);
    });
  }

  return formatResponse(nextRace, rows, new Date().toISOString(), false);
}

function calculateFavourites({
  nextRace,
  drivers,
  constructors,
  raceResults,
  sprintResults,
  qualifyingRows,
  practiceRows,
  weatherScore = NEUTRAL_SCORE,
  sentimentScores = new Map()
}) {
  const driverPool = drivers
    .filter(row => row.Driver && row.Team)
    .map(row => ({
      driver_name: row.Driver,
      constructor_name: row.Team,
      standings_position: toNumber(row.Position, 99),
      standings_points: toNumber(row.Points, 0),
      points_change: toNumber(row.PointsChange, 0)
    }));

  const teamScores = buildTeamScores(constructors, drivers);
  const recentResultsByDriver = groupByDriver([...raceResults, ...sprintResults]);
  const qualifyingByDriver = groupByDriver(qualifyingRows);
  const practiceByDriver = groupByDriver(practiceRows);
  const trackRows = raceResults.filter(row => sameTrack(row, nextRace));
  const trackByDriver = groupByDriver(trackRows);

  return driverPool
    .map(driver => {
      const formScore = scoreRecentForm(driverRows(recentResultsByDriver, driver.driver_name), driver);
      const qualifyingScore = scoreQualifying(driverRows(qualifyingByDriver, driver.driver_name), driver);
      const teamScore = teamScores.get(driver.constructor_name) ?? NEUTRAL_SCORE;
      const trackScore = scoreTrackHistory(driverRows(trackByDriver, driver.driver_name), driver);
      const practiceScore = scorePractice(driverRows(practiceByDriver, driver.driver_name));
      const driverWeatherScore = weatherScore;
      const sentimentScore = sentimentScores.get(driver.driver_name) ?? NEUTRAL_SCORE;
      const hasPractice = driverRows(practiceByDriver, driver.driver_name).length > 0;
      const hasQualifying = driverRows(qualifyingByDriver, driver.driver_name).length > 0;

      const favouriteScore = weightedAverage({
        form: formScore,
        qualifying: qualifyingScore,
        team: teamScore,
        track: trackScore,
        practice: practiceScore,
        weather: driverWeatherScore,
        sentiment: sentimentScore
      }, chooseScoreWeights({ hasPractice, hasQualifying }));

      return {
        race_round: String(nextRace.Round),
        race_name: nextRace.RaceName,
        race_date: nextRace.RaceDate,
        driver_name: driver.driver_name,
        constructor_name: driver.constructor_name,
        favourite_score: roundScore(favouriteScore),
        form_score: roundScore(formScore),
        qualifying_score: roundScore(qualifyingScore),
        team_score: roundScore(teamScore),
        track_score: roundScore(trackScore),
        practice_score: roundScore(practiceScore),
        weather_score: roundScore(driverWeatherScore),
        sentiment_score: roundScore(sentimentScore),
        explanation: buildExplanation({
          driver,
          formScore,
          qualifyingScore,
          teamScore,
          trackScore,
          practiceScore,
          weatherScore: driverWeatherScore,
          sentimentScore,
          hasPractice,
          hasQualifying
        }),
        updated_at: new Date().toISOString()
      };
    })
    .sort((a, b) => b.favourite_score - a.favourite_score);
}

function findNextRace(calendar) {
  const now = new Date();

  return calendar
    .filter(row => row.RaceDate)
    .map(row => ({
      ...row,
      raceDateTime: parseSastDateTime(row.RaceDate, row.RaceTime || '23:59')
    }))
    .filter(row => row.raceDateTime && row.raceDateTime >= now)
    .sort((a, b) => a.raceDateTime - b.raceDateTime)[0] || null;
}

function buildTeamScores(constructors, drivers) {
  const teams = constructors.length > 0
    ? constructors.map(row => ({
        team: row.Constructor,
        points: toNumber(row.Points, 0),
        position: toNumber(row.Position, 99)
      }))
    : Object.values(drivers.reduce((acc, row) => {
        if (!row.Team) return acc;
        if (!acc[row.Team]) acc[row.Team] = { team: row.Team, points: 0, position: 99 };
        acc[row.Team].points += toNumber(row.Points, 0);
        return acc;
      }, {})).sort((a, b) => b.points - a.points).map((team, index) => ({
        ...team,
        position: index + 1
      }));

  const maxPoints = Math.max(...teams.map(row => row.points), 1);
  return new Map(teams.map(row => {
    const pointsScore = (row.points / maxPoints) * 100;
    const rankScore = positionToScore(row.position, teams.length || 10);
    return [row.team, clamp((pointsScore * 0.65) + (rankScore * 0.35))];
  }));
}

function scoreRecentForm(rows = [], driver) {
  const recentRows = rows
    .slice()
    .sort(compareResultRows)
    .slice(-5);

  if (recentRows.length === 0) {
    return clamp(100 - ((driver.standings_position - 1) * 4) + Math.min(driver.points_change, 15));
  }

  const scores = recentRows.map((row, index) => {
    const position = toNumber(row.Position, 20);
    const points = toNumber(row.Points, POINTS_BY_POSITION[position - 1] || 0);
    const resultScore = positionToScore(position, 20);
    const pointsScore = Math.min(points * 4, 100);
    const recencyBoost = 0.8 + (index * 0.05);
    return ((resultScore * 0.72) + (pointsScore * 0.28)) * recencyBoost;
  });

  return clamp(average(scores));
}

function scoreQualifying(rows = [], driver) {
  const recentRows = rows.slice().sort(compareResultRows).slice(-4);

  if (recentRows.length === 0) {
    return clamp(68 - ((driver.standings_position - 1) * 1.6), 40, 68);
  }

  return clamp(average(recentRows.map(row => positionToScore(toNumber(row.Position, 20), 20))));
}

function scoreTrackHistory(rows = [], driver) {
  if (rows.length === 0) {
    return clamp(NEUTRAL_SCORE + Math.max(0, 10 - driver.standings_position));
  }

  return clamp(average(rows.map(row => {
    const finishScore = positionToScore(toNumber(row.Position, 20), 20);
    const pointsScore = Math.min(toNumber(row.Points, 0) * 4, 100);
    return (finishScore * 0.75) + (pointsScore * 0.25);
  })));
}

function scorePractice(rows = []) {
  if (rows.length === 0) return NEUTRAL_SCORE;
  const orderedRows = rows.slice().sort(compareResultRows);
  const weighted = orderedRows.reduce((acc, row, index) => {
    const weight = 1 + (index * 0.35);
    return {
      score: acc.score + (positionToScore(toNumber(row.Position, 20), 20) * weight),
      weight: acc.weight + weight
    };
  }, { score: 0, weight: 0 });

  return clamp(weighted.score / Math.max(weighted.weight, 1));
}

function buildExplanation({ driver, formScore, qualifyingScore, teamScore, trackScore, practiceScore, weatherScore, sentimentScore, hasPractice, hasQualifying }) {
  const strengths = [
    { label: 'recent race form', score: formScore },
    { label: 'qualifying baseline', score: qualifyingScore },
    { label: 'team performance', score: teamScore },
    { label: 'track history', score: trackScore },
    { label: 'practice pace', score: practiceScore, active: hasPractice },
    { label: 'weather outlook', score: weatherScore, active: weatherScore !== NEUTRAL_SCORE },
    { label: 'news momentum', score: sentimentScore, active: sentimentScore !== NEUTRAL_SCORE }
  ].filter(item => item.active !== false)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(item => item.label);

  const fallback = driver.standings_position <= 5
    ? 'championship position'
    : 'available season data';

  const qualiText = hasQualifying ? 'qualifying data is included' : 'qualifying uses season baseline until session data lands';
  const practiceText = hasPractice ? 'practice pace is included' : 'practice is neutral until FP data is published';

  return `${driver.driver_name} rates well on ${strengths.join(' and ') || fallback}; ${qualiText}, and ${practiceText}.`;
}

function chooseScoreWeights({ hasPractice, hasQualifying }) {
  if (hasQualifying) return QUALIFYING_SCORE_WEIGHTS;
  if (hasPractice) return WEEKEND_SCORE_WEIGHTS;
  return SCORE_WEIGHTS;
}

function weightedAverage(scores, weights = SCORE_WEIGHTS) {
  return Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + ((scores[key] ?? NEUTRAL_SCORE) * weight);
  }, 0);
}

async function fetchRaceResults() {
  const payload = await fetchJson(`https://api.jolpi.ca/ergast/f1/${CURRENT_SEASON}/results.json?limit=2000`);
  const races = payload?.MRData?.RaceTable?.Races || [];
  return races.flatMap(race => (race.Results || []).map(result => mapResultRow(race, result)));
}

async function fetchQualifyingResults(nextRace) {
  const [openF1Rows, jolpicaRows] = await Promise.all([
    fetchOpenF1TimingRows(nextRace, ['Sprint Qualifying', 'Qualifying']).catch(() => []),
    fetchJolpicaQualifyingResults(nextRace.Round).catch(() => [])
  ]);

  return openF1Rows.length > 0 ? openF1Rows : jolpicaRows;
}

async function fetchJolpicaQualifyingResults(round) {
  const payload = await fetchJson(`https://api.jolpi.ca/ergast/f1/${CURRENT_SEASON}/${encodeURIComponent(round)}/qualifying.json`);
  const races = payload?.MRData?.RaceTable?.Races || [];
  return races.flatMap(race => (race.QualifyingResults || []).map(result => mapResultRow(race, result)));
}

async function fetchPracticeResults(nextRace) {
  return fetchOpenF1TimingRows(nextRace, ['Practice 1', 'Practice 2', 'Practice 3']).catch(() => []);
}

async function fetchOpenF1TimingRows(nextRace, sessionNames) {
  const year = encodeURIComponent(String(nextRace.RaceDate || '').slice(0, 4) || new Date().getFullYear());
  const country = encodeURIComponent(nextRace.Country || '');
  const sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${year}&country_name=${country}`);
  const raceDate = parseSastDateTime(nextRace.RaceDate, nextRace.RaceTime || '23:59') || new Date();
  const now = currentDate();

  const completedSessions = sessions
    .filter(session => sessionNames.includes(session.session_name))
    .filter(session => !session.is_cancelled)
    .filter(session => sessionEnded(session) <= now && sessionEnded(session) <= raceDate)
    .sort((a, b) => sessionEnded(a) - sessionEnded(b));

  const rows = [];
  for (const session of completedSessions) {
    rows.push(...await fetchOpenF1SessionRows(nextRace, session).catch(() => []));
  }

  return rows;
}

async function fetchOpenF1SessionRows(nextRace, session) {
  const sessionKey = encodeURIComponent(session.session_key);
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
    .map(([driverNumber, best]) => ({ driver: driversByNumber.get(driverNumber) || {}, best }))
    .sort((a, b) => a.best.lapDuration - b.best.lapDuration)
    .map((entry, index) => ({
      Season: String(session.year || String(nextRace.RaceDate || '').slice(0, 4)),
      Round: String(nextRace.Round || ''),
      RaceName: nextRace.RaceName || '',
      Circuit: session.circuit_short_name || nextRace.Circuit || '',
      Country: session.country_name || nextRace.Country || '',
      Date: String(session.date_start || '').slice(0, 10) || nextRace.RaceDate || '',
      Position: String(index + 1),
      Driver: formatOpenF1DriverName(entry.driver),
      Team: entry.driver.team_name || '',
      Grid: '',
      Laps: entry.best.lapNumber,
      Time: formatLapTime(entry.best.lapDuration),
      Status: session.session_name,
      Points: '',
      FastestLapRank: index === 0 ? '1' : '',
      FastestLapTime: index === 0 ? formatLapTime(entry.best.lapDuration) : '',
      FastestLapLap: index === 0 ? entry.best.lapNumber : ''
    }))
    .filter(row => row.Driver);
}

async function fetchWeatherScore(nextRace) {
  const place = encodeURIComponent(nextRace.Country || nextRace.Circuit || nextRace.RaceName);
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${place}&count=1&language=en&format=json`);
  const location = geo?.results?.[0];
  if (!location) return NEUTRAL_SCORE;

  const date = nextRace.RaceDate;
  const forecast = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&daily=precipitation_probability_max,wind_speed_10m_max&start_date=${date}&end_date=${date}&timezone=Africa%2FJohannesburg`
  );
  const rain = toNumber(forecast?.daily?.precipitation_probability_max?.[0], 0);
  const wind = toNumber(forecast?.daily?.wind_speed_10m_max?.[0], 0);
  if (rain >= 45 || wind >= 35) return 66;
  if (rain >= 25 || wind >= 25) return 58;
  return NEUTRAL_SCORE;
}

async function fetchSentimentScores(drivers, nextRace) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return new Map();

  const query = encodeURIComponent(`"Formula 1" OR F1 "${nextRace.RaceName}"`);
  const url = `https://newsapi.org/v2/everything?q=${query}&language=en&pageSize=50&sortBy=publishedAt&apiKey=${encodeURIComponent(apiKey)}`;
  const payload = await fetchJson(url);
  const articles = payload?.articles || [];
  if (articles.length === 0) return new Map();

  const positive = /\b(win|wins|fast|fastest|strong|boost|confident|upgrade|podium|pole|leads|impressive|fit|cleared)\b/i;
  const negative = /\b(crash|penalty|struggle|issue|problem|damage|injury|illness|doubt|investigation|grid penalty|reprimand|setback)\b/i;

  return new Map(drivers.filter(row => row.Driver).map(row => {
    const driverName = row.Driver;
    const matches = articles.filter(article => {
      const text = `${article.title || ''} ${article.description || ''}`;
      return text.toLowerCase().includes(driverName.toLowerCase());
    });

    if (matches.length === 0) return [driverName, NEUTRAL_SCORE];

    const delta = matches.reduce((sum, article) => {
      const text = `${article.title || ''} ${article.description || ''}`;
      return sum + (positive.test(text) ? 4 : 0) - (negative.test(text) ? 5 : 0);
    }, 0);

    return [driverName, clamp(NEUTRAL_SCORE + delta, 35, 68)];
  }));
}

function mapResultRow(race, result) {
  return {
    Season: race.season,
    Round: race.round,
    RaceName: race.raceName,
    Circuit: race.Circuit?.circuitName || '',
    Country: race.Circuit?.Location?.country || '',
    Date: race.date || '',
    Position: result.position || result.grid || '',
    Driver: fullDriverName(result.Driver),
    Team: result.Constructor?.name || '',
    Points: result.points || '',
    Status: result.status || ''
  };
}

function fullDriverName(driver) {
  return [driver?.givenName, driver?.familyName].filter(Boolean).join(' ');
}

async function fetchCachedFavourites(round) {
  const supabase = getSupabaseConfig();
  if (!supabase) return [];

  const url = `${supabase.url}/rest/v1/f1_favourites?race_round=eq.${encodeURIComponent(round)}&order=favourite_score.desc`;
  const response = await fetch(url, {
    headers: {
      apikey: supabase.key,
      Authorization: `Bearer ${supabase.key}`
    }
  });

  if (!response.ok) return [];
  return response.json();
}

async function upsertFavourites(rows) {
  const supabase = getSupabaseConfig();
  if (!supabase) return;

  const response = await fetch(`${supabase.url}/rest/v1/f1_favourites?on_conflict=race_round,driver_name`, {
    method: 'POST',
    headers: {
      apikey: supabase.key,
      Authorization: `Bearer ${supabase.key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(rows)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase returned ${response.status}: ${text}`);
  }
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

function formatResponse(nextRace, rows, updatedAt, cached) {
  return {
    status: 'ok',
    cached,
    race: {
      round: String(nextRace.Round),
      name: nextRace.RaceName,
      circuit: nextRace.Circuit,
      country: nextRace.Country,
      date: nextRace.RaceDate,
      time: nextRace.RaceTime
    },
    updated_at: updatedAt,
    favourites: rows.sort((a, b) => b.favourite_score - a.favourite_score)
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'mysportzone-f1-favourites/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function readCsvIfExists(filePath) {
  try {
    return parseCsv(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
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

function groupByDriver(rows) {
  return rows.reduce((map, row) => {
    const name = row.Driver || row.driver_name;
    if (!name) return map;
    const keys = driverKeys(name);
    keys.forEach(key => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return map;
  }, new Map());
}

function driverRows(map, driverName) {
  const rows = [];
  driverKeys(driverName).forEach(key => {
    rows.push(...(map.get(key) || []));
  });

  return rows.filter((row, index, allRows) => {
    const marker = `${row.Season || ''}-${row.Round || ''}-${row.Date || ''}-${row.Driver || ''}-${row.Position || ''}-${row.Time || ''}`;
    return allRows.findIndex(other => (
      `${other.Season || ''}-${other.Round || ''}-${other.Date || ''}-${other.Driver || ''}-${other.Position || ''}-${other.Time || ''}` === marker
    )) === index;
  });
}

function driverKeys(driverName) {
  const normalized = normalizeDriverName(driverName);
  const parts = normalized.split(' ').filter(Boolean);
  const keys = new Set([normalized]);
  if (parts.length > 1) keys.add(parts[parts.length - 1]);
  return [...keys].filter(Boolean);
}

function normalizeDriverName(driverName) {
  return String(driverName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bandrea\s+kimi\s+antonelli\b/g, 'kimi antonelli')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameTrack(row, nextRace) {
  return String(row.RaceName || '').toLowerCase() === String(nextRace.RaceName || '').toLowerCase()
    || String(row.Circuit || '').toLowerCase() === String(nextRace.Circuit || '').toLowerCase()
    || String(row.Country || '').toLowerCase() === String(nextRace.Country || '').toLowerCase();
}

function compareResultRows(a, b) {
  const seasonDiff = toNumber(a.Season, 0) - toNumber(b.Season, 0);
  if (seasonDiff !== 0) return seasonDiff;
  return toNumber(a.Round, 0) - toNumber(b.Round, 0);
}

function positionToScore(position, fieldSize) {
  const pos = toNumber(position, fieldSize);
  return clamp(100 - (((pos - 1) / Math.max(fieldSize - 1, 1)) * 100));
}

function parseSastDateTime(date, time) {
  const safeTime = /^\d{1,2}:\d{2}$/.test(time || '') ? time : '23:59';
  const parsed = new Date(`${date}T${safeTime}:00+02:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function currentDate() {
  const override = process.env.F1_FAVOURITES_NOW;
  if (!override) return new Date();
  const parsed = new Date(override);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function sessionEnded(session) {
  const parsed = new Date(session.date_end || session.date_start || '');
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
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

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function average(values) {
  if (!values.length) return NEUTRAL_SCORE;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value) {
  return Math.round(clamp(value) * 10) / 10;
}

module.exports = {
  buildF1Favourites,
  calculateFavourites,
  findNextRace
};
