const { buildF1Favourites } = require('../lib/f1-favourites');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: true, message: 'Method not allowed' });
  }

  try {
    const payload = await buildF1Favourites({ preferCache: true, persist: false });
    return res.status(200).json(payload);
  } catch (error) {
    console.error('F1 favourites API error:', error);
    return res.status(500).json({
      error: true,
      message: 'F1 favourites unavailable'
    });
  }
};
