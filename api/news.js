// =============================================================================
// api/news.js — Filtered F1 + South African Sports News
// =============================================================================

const NEWS_API_KEY = '00f830d4d3ab417f86dc71daea685c34';

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const baseUrl = "https://newsapi.org/v2/everything";

  const f1Query = "Formula 1 OR F1 OR Grand Prix OR FIA";
  const saQuery = "South Africa rugby OR Springboks OR Proteas OR Bafana Bafana OR SA cricket OR SA football";

  try {
    const f1Url = `${baseUrl}?q=${encodeURIComponent(f1Query)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_API_KEY}`;
    const saUrl = `${baseUrl}?q=${encodeURIComponent(saQuery)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_API_KEY}`;

    const [f1Res, saRes] = await Promise.all([
      fetch(f1Url),
      fetch(saUrl)
    ]);

    const f1Data = await f1Res.json();
    const saData = await saRes.json();

    const filterArticles = (articles, type) => {
      return articles.filter(article => {
        const text = `${article.title} ${article.description}`.toLowerCase();

        if (type === "f1") {
          return text.includes("formula 1") || text.includes("f1") || text.includes("grand prix");
        }

        if (type === "sa") {
          return text.includes("south africa") || text.includes("springboks") || text.includes("proteas") || text.includes("bafana");
        }

        return false;
      });
    };

    const clean = (articles, type) =>
      filterArticles(articles || [], type).map(a => ({
        title: a.title,
        description: a.description,
        image: a.urlToImage,
        url: a.url,
        source: a.source.name,
        publishedAt: a.publishedAt
      }));

    const f1 = clean(f1Data.articles, "f1");
    const sa = clean(saData.articles, "sa");

    const combined = [...f1, ...sa]
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return res.status(200).json({ f1, sa, combined });

  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
};