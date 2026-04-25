// =============================================================================
// FILE: api/news.js  —  Vercel Serverless Function
// =============================================================================
// WHAT IS THIS FILE?
//   A Vercel Serverless Function. Any .js file placed in the /api/ folder of
//   your GitHub repository is automatically recognised by Vercel and deployed
//   as a serverless API endpoint — no extra configuration needed.
//
//   This file becomes the URL:  https://mysportzone.vercel.app/api/news
//
// WHY DO WE NEED IT?
//   NewsAPI blocks all requests made directly from a web browser (CORS policy).
//   This is a deliberate restriction on their free Developer plan.
//   By calling NewsAPI from THIS server-side function instead, the request
//   arrives at NewsAPI as a normal server-to-server call — which is allowed.
//
// HOW THE FLOW WORKS:
//   Browser  →  GET /api/news  →  This function  →  NewsAPI servers
//   Browser  ←  JSON articles  ←  This function  ←  NewsAPI servers
//
//   The browser only ever talks to mysportzone.vercel.app (same domain),
//   so there is ZERO cross-origin issue.
// =============================================================================

const NEWS_API_KEY = '00f830d4d3ab417f86dc71daea685c34';

// Keywords covering all desired topics.
// NewsAPI 'everything' endpoint supports OR logic using spaces between terms.
// sortBy=publishedAt ensures newest articles appear first.
// pageSize=18 fetches more raw results so after deduplication you still have ~9 good ones.
const TOPICS = [
  'Formula 1 OR F1 OR Grand Prix',
  'South African motorsport OR SA motorsport OR Zwartkops OR Mahem Raceway',
  'boxing',
  'UFC OR MMA',
  'rugby OR Springboks OR Super Rugby',
  'tennis OR ATP OR WTA',
  'MotoGP OR motorcycle racing',
  'South Africa music event OR South Africa concert OR SA festival'
].join(' OR ');

const NEWS_API_URL =
  `https://newsapi.org/v2/everything?q=${encodeURIComponent(TOPICS)}&language=en&sortBy=publishedAt&pageSize=18&apiKey=${NEWS_API_KEY}`;

// handler() is called by Vercel every time the browser hits /api/news
// req = incoming request  |  res = response we send back
module.exports = async function handler(req, res) {

  // Allow the browser to read this response (CORS header)
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Cache the response for 5 minutes on Vercel's CDN to reduce API calls
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

  // Tell the browser the response is JSON
  res.setHeader('Content-Type', 'application/json');

  // Handle browser CORS preflight check
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Call NewsAPI from the server (no CORS restriction here)
    const response = await fetch(NEWS_API_URL);

    if (!response.ok) {
      return res.status(response.status).json({
        error: true,
        message: `NewsAPI returned status ${response.status}`
      });
    }

// Parse the full NewsAPI response
    const data = await response.json();

    // Filter out removed articles (NewsAPI sometimes returns [Removed] placeholders)
    // and deduplicate by title, then cap at 9 for display
    if (data.articles) {
      const seen = new Set();
      data.articles = data.articles
        .filter(a => a.title && !a.title.includes('[Removed]') && a.url)
        .filter(a => {
          const key = a.title.toLowerCase().trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 9);
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
};
