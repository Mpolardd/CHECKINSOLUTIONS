const router = require('express').Router();
const prisma = require('../../config/prisma');
const jwt = require('jsonwebtoken');
const { requireAuth, requireRoles } = require('../../middleware/auth');

router.get('/', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'PASTORAL'), async (req, res, next) => {
  try {
    res.json(await prisma.reminder.findMany({ where: { status: 'PENDING' }, orderBy: { scheduledFor: 'asc' }, take: 100 }));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'PASTORAL'), async (req, res, next) => {
  try {
    const { title, message, scheduledFor, channel = 'in_app' } = req.body;
    if (!title || !message || !scheduledFor) {
      return res.status(400).json({ error: 'title, message and scheduledFor are required' });
    }
    const rem = await prisma.reminder.create({
      data: {
        title,
        message,
        scheduledFor: new Date(scheduledFor),
        channel
      }
    });
    res.status(201).json(rem);
  } catch (e) { next(e); }
});

// Serverless Cron & Scheduled Job Processor
router.all('/process', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const cronSecretHeader = req.headers['x-cron-secret'] || '';
    const configuredSecret = process.env.CRON_SECRET || 'solutions_cron_secure_key_2026';

    let authorized = false;

    // Check CRON secret header
    if (cronSecretHeader === configuredSecret || authHeader === `Bearer ${configuredSecret}`) {
      authorized = true;
    }

    // Check Super Admin token
    if (!authorized && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_ACCESS_SECRET || 'church_mgmt_secret_dev_fallback_only');
        if (decoded.role === 'SUPER_ADMIN' || decoded.role === 'ADMIN') {
          authorized = true;
        }
      } catch (e) {}
    }

    if (!authorized) {
      return res.status(401).json({ error: 'Unauthorized: Invalid CRON secret or admin authorization' });
    }

    const due = await prisma.reminder.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: new Date() } },
      take: 50
    });

    const results = [];
    for (const item of due) {
      try {
        console.log(`[SERVERLESS CRON] Processing reminder [${item.channel}]: ${item.title}`);
        await prisma.reminder.update({
          where: { id: item.id },
          data: { status: 'SENT' }
        });
        results.push({ id: item.id, title: item.title, status: 'SENT' });
      } catch (err) {
        await prisma.reminder.update({
          where: { id: item.id },
          data: { status: 'FAILED' }
        });
        results.push({ id: item.id, title: item.title, status: 'FAILED' });
      }
    }

    res.json({
      success: true,
      processedCount: results.length,
      timestamp: new Date().toISOString(),
      results
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
