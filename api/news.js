const NEWS_API_KEY = '00f830d4d3ab417f86dc71daea685c34';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Simple focused queries — one per topic group, merged server-side
  // This avoids long OR chains that confuse the free-plan API
  const queries = [
    'Formula 1 OR F1 OR Grand Prix',
    'boxing OR UFC OR MMA',
    'rugby OR Springboks',
    'tennis OR ATP OR WTA',
    'MotoGP',
    'South Africa concert OR South Africa music'
  ];

  try {
    // Fire all queries in parallel
    const results = await Promise.all(
      queries.map(q =>
        fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=3&apiKey=${NEWS_API_KEY}`)
          .then(r => r.json())
          .then(d => d.articles || [])
          .catch(() => [])
      )
    );

    // Flatten all articles, deduplicate by title, remove junk
    const seen = new Set();
    const articles = results
      .flat()
      .filter(a => {
        if (!a.title || a.title.includes('[Removed]') || !a.url) return false;
        const key = a.title.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 9);

    return res.status(200).json({ status: 'ok', totalResults: articles.length, articles });

  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
};
