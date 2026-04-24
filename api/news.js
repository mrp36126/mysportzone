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

const NEWS_API_KEY = 'cd0036d802097242c095659ca9f8873b';

// NewsAPI endpoint — returns top sports headlines in English, 9 articles
const NEWS_API_URL =
  `https://newsapi.org/v2/top-headlines?category=sports&language=en&pageSize=9&apiKey=${NEWS_API_KEY}`;

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

    // Parse and forward the full NewsAPI response to the browser
    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
};
