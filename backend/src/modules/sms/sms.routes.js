const router = require('express').Router();
const prisma = require('../../config/prisma');
const { requireAuth, requireRoles } = require('../../middleware/auth');
const arkeselService = require('./arkesel.service');

/**
 * GET /api/v1/sms/balance
 * Returns live SMS balance & Main account balance from Arkesel
 */
router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const { apiKey } = req.query || {};
    const balance = await arkeselService.checkBalance(apiKey);
    res.json(balance);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/v1/sms/send
 * Sends SMS to single or multiple recipient phone numbers
 */
router.post('/send', requireAuth, async (req, res, next) => {
  try {
    const { recipients, message, sender, sandbox = false, apiKey } = req.body || {};

    if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
      return res.status(400).json({ error: 'Recipient phone number is required' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const result = await arkeselService.sendSms({
      recipients,
      message: message.trim(),
      sender,
      sandbox,
      apiKey
    });

    // Log dispatch to audit logs
    await prisma.auditLog.create({
      data: {
        actorId: req.user?.userId || null,
        action: 'SEND_SMS',
        entity: 'SMS_DISPATCH',
        entityId: `sms_${Date.now()}`,
        metadata: {
          recipientCount: result.recipientCount,
          recipients: result.recipients,
          sender: result.sender,
          messagePreview: message.trim().substring(0, 80),
          sentAt: new Date().toISOString()
        }
      }
    }).catch(err => console.error('[SMS AuditLog error]:', err.message));

    res.json({
      success: true,
      message: `SMS dispatched successfully to ${result.recipientCount} recipient(s).`,
      result
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/v1/sms/send-bulk
 * Sends personalized SMS in batch to a list of recipients
 */
router.post('/send-bulk', requireAuth, async (req, res, next) => {
  try {
    const { messages, sender, apiKey } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const results = await arkeselService.sendBulkPersonalizedSms(messages, sender, apiKey);

    // Record audit log
    await prisma.auditLog.create({
      data: {
        actorId: req.user?.userId || null,
        action: 'SEND_BULK_SMS',
        entity: 'SMS_DISPATCH',
        entityId: `sms_bulk_${Date.now()}`,
        metadata: {
          total: results.total,
          sent: results.sent,
          failed: results.failed,
          sender: sender || arkeselService.defaultSenderId,
          sentAt: new Date().toISOString()
        }
      }
    }).catch(err => console.error('[SMS Bulk AuditLog error]:', err.message));

    res.json({
      success: true,
      message: `Batch SMS processed: ${results.sent} sent, ${results.failed} failed.`,
      results
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/sms/logs
 * Retrieves recent SMS dispatch history from audit logs
 */
router.get('/logs', requireAuth, async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        entity: 'SMS_DISPATCH'
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    const formatted = logs.map(l => ({
      id: l.id,
      action: l.action,
      entityId: l.entityId,
      metadata: l.metadata || {},
      createdAt: l.createdAt
    }));

    res.json({ logs: formatted });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/v1/sms/webhook
 * Public endpoint to receive Arkesel delivery status reports
 */
router.post('/webhook', async (req, res) => {
  try {
    const { sms_id, status, recipient, message } = req.body || req.query || {};

    // Log delivery report
    await prisma.auditLog.create({
      data: {
        action: 'SMS_WEBHOOK_STATUS',
        entity: 'SMS_DELIVERY',
        entityId: sms_id || `webhook_${Date.now()}`,
        metadata: {
          smsId: sms_id,
          status: status || 'RECEIVED',
          recipient,
          rawPayload: req.body || req.query,
          receivedAt: new Date().toISOString()
        }
      }
    }).catch(err => console.error('[SMS Webhook AuditLog error]:', err.message));

    res.status(200).json({ status: 'success', message: 'Webhook received' });
  } catch (e) {
    res.status(200).json({ status: 'ok' }); // Always return 200 to Arkesel
  }
});

module.exports = router;
