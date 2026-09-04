const router = require('express').Router();
const prisma = require('../../config/prisma');

router.get('/', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1 as health_check`;
    res.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Health check error:', e?.message || e);
    res.status(503).json({ status: 'degraded', database: 'error', error: e?.message || 'Database unavailable' });
  }
});

module.exports = router;
