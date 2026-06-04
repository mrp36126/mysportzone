const { buildF1Favourites } = require('../lib/f1-favourites');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: true, message: 'Method not allowed' });
  }

  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: true, message: 'Unauthorized' });
    }
  }

  try {
    const payload = await buildF1Favourites({ preferCache: false, persist: true });
    return res.status(200).json({
      ...payload,
      refreshed: true
    });
  } catch (error) {
    console.error('F1 favourites update error:', error);
    return res.status(500).json({
      error: true,
      message: 'F1 favourites refresh failed'
    });
  }
};
