const NEWS_API_KEY = process.env.NEWS_API_KEY || process.env.NEWSAPI_KEY || process.env.NEWS_API_TOKEN;

const TOPICS = [
  {
    name: 'Formula 1',
    query: '"Formula 1" OR F1 OR "Grand Prix"',
    match: /\b(formula\s*1|f1|grand prix|verstappen|hamilton|norris|leclerc|ferrari|mclaren|red bull racing)\b/i
  },
  {
    name: 'Rugby',
    query: 'rugby OR Springboks OR "South Africa rugby"',
    match: /\b(rugby|springboks?|six nations|rugby championship|urc|currie cup)\b/i
  },
  {
    name: 'South Africa Motorsport',
    query: '"South Africa motorsport" OR "South African motorsport" OR "SA motorsport" OR "National Hot Rods" OR hotrods',
    match: /\b(south africa motorsport|south african motorsport|sa motorsport|national hot rods?|hotrods?|zwartkops|kyalami|mahem raceway|motorsport)\b/i
  },
  {
    name: 'Tennis',
    query: 'tennis OR ATP OR WTA OR "French Open" OR Wimbledon',
    match: /\b(tennis|atp|wta|french open|roland garros|wimbledon|us open|australian open)\b/i
  },
  {
    name: 'Combat Sports',
    query: 'UFC OR MMA OR boxing',
    match: /\b(ufc|mma|mixed martial arts|boxing|boxer|fight night|heavyweight|middleweight|welterweight)\b/i
  }
];

const TOPIC_QUERIES = [
  'Formula 1',
  'F1',
  'Grand Prix',
  'rugby',
  'Springboks',
  'South Africa rugby',
  'South Africa motorsport',
  'South African motorsport',
  'National Hot Rods',
  'hotrods',
  'tennis',
  'ATP tennis',
  'WTA tennis',
  'French Open',
  'UFC',
  'MMA',
  'boxing'
];

const FALLBACK_QUERY = TOPIC_QUERIES.join(' OR ');
const ALLOWED_TOPIC_MATCH = new RegExp(TOPICS.map(topic => topic.match.source).join('|'), 'i');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!NEWS_API_KEY) {
    return res.status(503).json({
      error: true,
      message: 'News service is not configured. Set NEWS_API_KEY in Vercel environment variables.'
    });
  }

  try {
    const topicResults = await Promise.all(TOPIC_QUERIES.map(query => fetchNews(query, 2)));
    let articles = normalizeArticles(topicResults.flatMap(result => result.articles), {
      requireTopicMatch: false
    });
    const errors = topicResults.filter(result => result.error);

    if (articles.length === 0) {
      const fallback = await fetchNews(FALLBACK_QUERY, 30);
      articles = normalizeArticles(fallback.articles, { requireTopicMatch: true });
      if (fallback.error) errors.push(fallback);
    }

    if (articles.length === 0) {
      const headlineResults = await Promise.all(['za', 'gb', 'us', 'au'].map(country => fetchSportsHeadlines(country)));
      articles = normalizeArticles(headlineResults.flatMap(result => result.articles), {
        requireTopicMatch: true
      });
      errors.push(...headlineResults.filter(result => result.error));
    }

    if (articles.length === 0 && errors.length > 0) {
      console.error('NewsAPI returned no usable articles:', errors);
      return res.status(502).json({
        error: true,
        message: `NewsAPI did not return articles: ${errors[0].message || 'unknown error'}`
      });
    }

    return res.status(200).json({ status: 'ok', totalResults: articles.length, articles });
  } catch (err) {
    console.error('News feed error:', err);
    return res.status(500).json({ error: true, message: 'News service unavailable' });
  }
};

async function fetchNews(query, pageSize) {
  const params = new URLSearchParams({
    q: query,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: String(pageSize),
    searchIn: 'title,description',
    apiKey: NEWS_API_KEY
  });

  const response = await fetch(`https://newsapi.org/v2/everything?${params}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.status === 'error') {
    return {
      articles: [],
      error: true,
      message: data.message || `NewsAPI HTTP ${response.status}`
    };
  }

  return { articles: data.articles || [] };
}

async function fetchSportsHeadlines(country) {
  const params = new URLSearchParams({
    country,
    category: 'sports',
    pageSize: '30',
    apiKey: NEWS_API_KEY
  });

  const response = await fetch(`https://newsapi.org/v2/top-headlines?${params}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.status === 'error') {
    return {
      articles: [],
      error: true,
      message: data.message || `NewsAPI HTTP ${response.status}`
    };
  }

  return { articles: data.articles || [] };
}

function normalizeArticles(rawArticles, options = {}) {
  const { requireTopicMatch = true } = options;
  const seen = new Set();

  return rawArticles
    .filter(article => {
      const title = article?.title || '';
      const description = article?.description || '';
      const content = article?.content || '';
      const url = article?.url || '';
      const haystack = `${title} ${description} ${content}`.toLowerCase();

      if (!title || title.includes('[Removed]') || !url) return false;
      if (requireTopicMatch && !ALLOWED_TOPIC_MATCH.test(haystack)) return false;

      const key = `${title.toLowerCase().trim()}|${url.trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, 9);
}
