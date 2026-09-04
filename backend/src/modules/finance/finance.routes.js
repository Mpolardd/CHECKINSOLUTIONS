const router = require('express').Router();
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { requireAuth, requireRoles } = require('../../middleware/auth');

const financial = z.object({
  accountId: z.string(),
  memberId: z.string().optional(),
  type: z.enum(['INCOME', 'EXPENSE', 'REVERSAL']),
  amount: z.coerce.number().positive(),
  description: z.string().optional(),
  reference: z.string().optional()
});

const serviceFinanceSchema = z.object({
  serviceName: z.string().min(1, 'Service name is required'),
  serviceDate: z.string().min(1, 'Service date is required'),
  tithes: z.coerce.number().min(0).default(0),
  offering: z.coerce.number().min(0).default(0),
  buildingFund: z.coerce.number().min(0).default(0),
  specialSeed: z.coerce.number().min(0).default(0),
  thanksgiving: z.coerce.number().min(0).default(0),
  other: z.coerce.number().min(0).default(0),
  cashAmount: z.coerce.number().min(0).default(0),
  momoAmount: z.coerce.number().min(0).default(0),
  bankAmount: z.coerce.number().min(0).default(0),
  posAmount: z.coerce.number().min(0).default(0),
  recordedBy: z.string().optional().nullable().transform(v => (v && v.trim()) ? v.trim() : 'Treasury Officer'),
  notes: z.string().optional().nullable()
});

// Accounts List - Protected for Finance and Administrators
router.get('/accounts', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    res.json(await prisma.financialAccount.findMany({ where: { active: true }, orderBy: { name: 'asc' } }));
  } catch (e) { next(e); }
});

// Record Service Financial Figures - Atomic creation with ledger cross-posting
router.post('/service-entry', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const b = serviceFinanceSchema.parse(req.body);
    const computedTotal = (b.tithes + b.offering + b.buildingFund + b.specialSeed + b.thanksgiving + b.other);

    const result = await prisma.$transaction(async (tx) => {
      const entry = await tx.serviceFinance.create({
        data: {
          serviceName: b.serviceName,
          serviceDate: new Date(b.serviceDate),
          tithes: b.tithes,
          offering: b.offering,
          buildingFund: b.buildingFund,
          specialSeed: b.specialSeed,
          thanksgiving: b.thanksgiving,
          other: b.other,
          totalAmount: computedTotal,
          cashAmount: b.cashAmount,
          momoAmount: b.momoAmount,
          bankAmount: b.bankAmount,
          posAmount: b.posAmount,
          recordedBy: b.recordedBy,
          notes: b.notes || null,
          status: 'CONFIRMED'
        }
      });

      // Synchronize with double-entry ledger account
      let generalAccount = await tx.financialAccount.findUnique({ where: { code: 'GENERAL_COLLECTIONS' } });
      if (!generalAccount) {
        generalAccount = await tx.financialAccount.create({
          data: { name: 'General Collections & Offerings', code: 'GENERAL_COLLECTIONS', active: true }
        });
      }

      const txRef = `SVC-${entry.id.slice(-8).toUpperCase()}`;
      await tx.financialTransaction.create({
        data: {
          accountId: generalAccount.id,
          type: 'INCOME',
          amount: computedTotal,
          reference: txRef,
          description: `Service Collections: ${b.serviceName} (${b.serviceDate}) - Recorded by ${b.recordedBy}`
        }
      });

      // Audit Log for financial entry
      await tx.auditLog.create({
        data: {
          actorId: req.user?.userId || null,
          action: 'RECORD_SERVICE_FINANCE',
          entity: 'SERVICE_FINANCE',
          entityId: entry.id,
          metadata: {
            serviceName: b.serviceName,
            totalAmount: computedTotal,
            recordedBy: b.recordedBy
          }
        }
      });

      return entry;
    });

    res.status(201).json({ success: true, entry: result });
  } catch (e) { next(e); }
});

// Get List of Service Financial Entries - Protected
router.get('/service-entries', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const entries = await prisma.serviceFinance.findMany({
      orderBy: { serviceDate: 'desc' },
      take: 100
    });
    res.json(entries);
  } catch (e) { next(e); }
});

// Get Comprehensive Financial Analytics - Protected
router.get('/analytics', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const entries = await prisma.serviceFinance.findMany({
      orderBy: { serviceDate: 'asc' }
    });

    let totalCollections = 0;
    let totalTithes = 0;
    let totalOffering = 0;
    let totalBuilding = 0;
    let totalSpecialSeed = 0;
    let totalThanksgiving = 0;
    let totalOther = 0;

    let totalCash = 0;
    let totalMomo = 0;
    let totalBank = 0;
    let totalPos = 0;

    const serviceMap = {};

    entries.forEach(e => {
      const tot = Number(e.totalAmount);
      totalCollections += tot;
      totalTithes += Number(e.tithes);
      totalOffering += Number(e.offering);
      totalBuilding += Number(e.buildingFund);
      totalSpecialSeed += Number(e.specialSeed);
      totalThanksgiving += Number(e.thanksgiving);
      totalOther += Number(e.other);

      totalCash += Number(e.cashAmount);
      totalMomo += Number(e.momoAmount);
      totalBank += Number(e.bankAmount);
      totalPos += Number(e.posAmount);

      const svcKey = e.serviceName.split('(')[0].trim();
      if (!serviceMap[svcKey]) serviceMap[svcKey] = { name: svcKey, total: 0, count: 0 };
      serviceMap[svcKey].total += tot;
      serviceMap[svcKey].count += 1;
    });

    const averagePerService = entries.length > 0 ? (totalCollections / entries.length).toFixed(2) : 0;

    const categoryBreakdown = {
      tithes: { amount: totalTithes, pct: totalCollections > 0 ? Math.round((totalTithes / totalCollections) * 100) : 0 },
      offering: { amount: totalOffering, pct: totalCollections > 0 ? Math.round((totalOffering / totalCollections) * 100) : 0 },
      buildingFund: { amount: totalBuilding, pct: totalCollections > 0 ? Math.round((totalBuilding / totalCollections) * 100) : 0 },
      specialSeed: { amount: totalSpecialSeed, pct: totalCollections > 0 ? Math.round((totalSpecialSeed / totalCollections) * 100) : 0 },
      thanksgiving: { amount: totalThanksgiving, pct: totalCollections > 0 ? Math.round((totalThanksgiving / totalCollections) * 100) : 0 },
      other: { amount: totalOther, pct: totalCollections > 0 ? Math.round((totalOther / totalCollections) * 100) : 0 }
    };

    const paymentModes = {
      cash: { amount: totalCash, pct: totalCollections > 0 ? Math.round((totalCash / totalCollections) * 100) : 0 },
      momo: { amount: totalMomo, pct: totalCollections > 0 ? Math.round((totalMomo / totalCollections) * 100) : 0 },
      bank: { amount: totalBank, pct: totalCollections > 0 ? Math.round((totalBank / totalCollections) * 100) : 0 },
      pos: { amount: totalPos, pct: totalCollections > 0 ? Math.round((totalPos / totalCollections) * 100) : 0 }
    };

    const recentEntries = [...entries].reverse().slice(0, 15);

    res.json({
      totalCollections,
      totalEntries: entries.length,
      averagePerService: Number(averagePerService),
      categoryBreakdown,
      paymentModes,
      serviceComparison: Object.values(serviceMap),
      recentEntries
    });
  } catch (e) { next(e); }
});

// Generic Transactions CRUD - Protected
router.post('/transactions', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const b = financial.parse(req.body);
    const tx = await prisma.financialTransaction.create({
      data: {
        accountId: b.accountId,
        memberId: b.memberId || null,
        type: b.type,
        amount: b.amount,
        description: b.description || null,
        reference: b.reference || null
      }
    });
    res.status(201).json(tx);
  } catch (e) { next(e); }
});

router.get('/transactions', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const rows = await prisma.financialTransaction.findMany({
      include: { account: true, member: { select: { firstName: true, lastName: true } } },
      orderBy: { postedAt: 'desc' },
      take: 200
    });
    res.json(rows);
  } catch (e) { next(e); }
});

// ── PARTNERSHIP & MONTHLY PLEDGES SYSTEM ──

// List all registered partners
router.get('/partners', async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { entity: 'PARTNER' },
      orderBy: { createdAt: 'desc' }
    });

    const partners = logs.map(l => ({
      id: l.entityId || l.id,
      ...(l.metadata || {}),
      createdAt: l.createdAt
    })).filter(p => p.active !== false);

    // Fetch all partnership payments to calculate lifetime contributions
    const paymentLogs = await prisma.auditLog.findMany({
      where: { entity: 'PARTNERSHIP_PAYMENT' },
      select: { metadata: true }
    });

    const totalsMap = {};
    for (const p of paymentLogs) {
      if (p.metadata && p.metadata.partnerId) {
        totalsMap[p.metadata.partnerId] = (totalsMap[p.metadata.partnerId] || 0) + (Number(p.metadata.amount) || 0);
      }
    }

    const enriched = partners.map(p => ({
      ...p,
      totalContributed: totalsMap[p.id] || 0
    }));

    res.json(enriched);
  } catch (e) { next(e); }
});

// Register or Update a Partner
router.post('/partners', async (req, res, next) => {
  try {
    const { id, memberId, memberName, phone, email, pledgeAmount, currency = 'GHS', frequency = 'MONTHLY', startDate, notes } = req.body || {};
    if (!memberName || !pledgeAmount) {
      return res.status(400).json({ error: 'Partner member name and pledge amount are required' });
    }

    const partnerId = id || `partner_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    await prisma.auditLog.deleteMany({
      where: { entity: 'PARTNER', entityId: partnerId }
    });

    const metadata = {
      memberId: memberId || null,
      memberName: memberName.trim(),
      phone: phone ? phone.trim() : '',
      email: email ? email.trim() : '',
      pledgeAmount: Number(pledgeAmount),
      currency,
      frequency,
      startDate: startDate || new Date().toISOString().slice(0, 10),
      notes: notes || '',
      active: true
    };

    await prisma.auditLog.create({
      data: {
        actorId: req.user?.userId || null,
        action: 'REGISTER_PARTNER',
        entity: 'PARTNER',
        entityId: partnerId,
        metadata
      }
    });

    res.status(201).json({ id: partnerId, ...metadata });
  } catch (e) { next(e); }
});

// Deactivate / Delete Partner
router.delete('/partners/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.auditLog.deleteMany({
      where: { entity: 'PARTNER', entityId: id }
    });
    res.json({ success: true, message: 'Partner removed' });
  } catch (e) { next(e); }
});

// Record a Partnership Payment
router.post('/partnerships/payments', async (req, res, next) => {
  try {
    const { partnerId, memberName, amount, targetMonth, paymentDate, paymentMethod = 'CASH', recordedBy = 'Treasury Officer', notes } = req.body || {};
    if (!partnerId || !amount || !targetMonth) {
      return res.status(400).json({ error: 'Partner, amount, and target month are required' });
    }

    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const parsedAmount = Number(amount);
    const dateStr = paymentDate || new Date().toISOString().slice(0, 10);

    const paymentMeta = {
      paymentId,
      partnerId,
      memberName: memberName || 'Partner',
      amount: parsedAmount,
      targetMonth, // format YYYY-MM e.g. "2026-08"
      paymentDate: dateStr,
      paymentMethod,
      recordedBy,
      notes: notes || ''
    };

    // Save payment log
    await prisma.auditLog.create({
      data: {
        actorId: req.user?.userId || null,
        action: 'RECORD_PARTNERSHIP_PAYMENT',
        entity: 'PARTNERSHIP_PAYMENT',
        entityId: paymentId,
        metadata: paymentMeta
      }
    });

    // Create entry in double-entry ledger account
    try {
      let partnerAccount = await prisma.financialAccount.findUnique({ where: { code: 'PARTNERSHIP_COLLECTIONS' } });
      if (!partnerAccount) {
        partnerAccount = await prisma.financialAccount.create({
          data: { name: 'Partnership & Monthly Pledges Collections', code: 'PARTNERSHIP_COLLECTIONS', active: true }
        });
      }

      await prisma.financialTransaction.create({
        data: {
          accountId: partnerAccount.id,
          type: 'INCOME',
          amount: parsedAmount,
          reference: `PARTNER-${paymentId.slice(-6).toUpperCase()}`,
          description: `Partnership Payment: ${memberName} for ${targetMonth} via ${paymentMethod}`
        }
      });
    } catch (err) {}

    res.status(201).json(paymentMeta);
  } catch (e) { next(e); }
});

// List all partnership payments
router.get('/partnerships/payments', async (req, res, next) => {
  try {
    const { partnerId, targetMonth, year } = req.query;
    const logs = await prisma.auditLog.findMany({
      where: { entity: 'PARTNERSHIP_PAYMENT' },
      orderBy: { createdAt: 'desc' }
    });

    let payments = logs.map(l => l.metadata).filter(Boolean);

    if (partnerId) {
      payments = payments.filter(p => p.partnerId === partnerId);
    }
    if (targetMonth) {
      payments = payments.filter(p => p.targetMonth === targetMonth);
    }
    if (year) {
      payments = payments.filter(p => p.targetMonth && p.targetMonth.startsWith(String(year)));
    }

    res.json(payments);
  } catch (e) { next(e); }
});

// 12-Month Tracking Matrix & Analytics
router.get('/partnerships/matrix', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const currentMonthNum = new Date().getMonth() + 1; // 1 to 12
    const currentYear = new Date().getFullYear();

    // 1. Fetch all partners
    const partnerLogs = await prisma.auditLog.findMany({
      where: { entity: 'PARTNER' },
      orderBy: { createdAt: 'desc' }
    });
    const partners = partnerLogs.map(l => ({
      id: l.entityId || l.id,
      ...(l.metadata || {})
    })).filter(p => p.active !== false);

    // 2. Fetch all payments for this year
    const paymentLogs = await prisma.auditLog.findMany({
      where: { entity: 'PARTNERSHIP_PAYMENT' },
      orderBy: { createdAt: 'desc' }
    });
    const allPayments = paymentLogs.map(l => l.metadata).filter(Boolean);

    // Map payments by partnerId and month (01 to 12)
    // Structure: { [partnerId]: { '01': sumAmount, '02': sumAmount, ... } }
    const partnerMonthMap = {};
    for (const p of allPayments) {
      if (p.targetMonth && p.targetMonth.startsWith(String(year))) {
        const monthPart = p.targetMonth.slice(5, 7); // e.g. "08"
        if (!partnerMonthMap[p.partnerId]) partnerMonthMap[p.partnerId] = {};
        partnerMonthMap[p.partnerId][monthPart] = (partnerMonthMap[p.partnerId][monthPart] || 0) + (Number(p.amount) || 0);
      }
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let totalMonthlyPledged = 0;
    let currentMonthPledged = 0;
    let currentMonthCollected = 0;
    let currentMonthMissedCount = 0;
    let currentMonthPaidCount = 0;

    const currMonthPad = String(currentMonthNum).padStart(2, '0');

    const matrix = partners.map(p => {
      const pledge = Number(p.pledgeAmount) || 0;
      totalMonthlyPledged += pledge;

      const monthlyStatus = {};
      let partnerYearPaid = 0;

      for (let m = 1; m <= 12; m++) {
        const mKey = String(m).padStart(2, '0');
        const paidAmount = (partnerMonthMap[p.id] && partnerMonthMap[p.id][mKey]) || 0;
        partnerYearPaid += paidAmount;

        let status = 'PENDING'; // Future month
        const isPastMonth = (year < currentYear) || (year === currentYear && m < currentMonthNum);
        const isCurrentMonth = (year === currentYear && m === currentMonthNum);

        if (paidAmount >= pledge && pledge > 0) {
          status = 'PAID';
        } else if (paidAmount > 0 && paidAmount < pledge) {
          status = 'PARTIAL';
        } else if (isPastMonth) {
          status = 'MISSED';
        } else if (isCurrentMonth) {
          status = 'DUE';
        } else {
          status = 'PENDING';
        }

        monthlyStatus[mKey] = {
          monthName: monthNames[m - 1],
          pledge,
          paid: paidAmount,
          status
        };

        if (isCurrentMonth) {
          currentMonthPledged += pledge;
          currentMonthCollected += paidAmount;
          if (status === 'PAID') currentMonthPaidCount++;
          else if (status === 'DUE' || status === 'MISSED') currentMonthMissedCount++;
        }
      }

      return {
        partnerId: p.id,
        memberName: p.memberName,
        phone: p.phone || '—',
        pledgeAmount: pledge,
        currency: p.currency || 'GHS',
        yearTotalPaid: partnerYearPaid,
        monthlyStatus
      };
    });

    res.json({
      year,
      summary: {
        totalPartners: partners.length,
        totalMonthlyPledged,
        currentMonthPledged,
        currentMonthCollected,
        currentMonthFulfillmentPct: currentMonthPledged > 0 ? Math.round((currentMonthCollected / currentMonthPledged) * 100) : 0,
        currentMonthPaidCount,
        currentMonthMissedCount
      },
      matrix
    });
  } catch (e) { next(e); }
});

// Clear / Reset Financial Overview & Analytics Records - Protected
router.post('/clear', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const deletedEntries = await tx.serviceFinance.deleteMany({});
      const deletedTransactions = await tx.financialTransaction.deleteMany({
        where: {
          OR: [
            { reference: { startsWith: 'SVC-' } },
            { description: { contains: 'Service Collections' } }
          ]
        }
      });
      const deletedAudit = await tx.auditLog.deleteMany({
        where: { entity: 'SERVICE_FINANCE' }
      });

      // Audit Log for clearing finance records
      await tx.auditLog.create({
        data: {
          actorId: req.user?.userId || null,
          action: 'CLEAR_SERVICE_FINANCE',
          entity: 'SERVICE_FINANCE',
          metadata: {
            clearedEntriesCount: deletedEntries.count,
            clearedTransactionsCount: deletedTransactions.count,
            clearedAt: new Date().toISOString()
          }
        }
      });

      return {
        clearedEntriesCount: deletedEntries.count,
        clearedTransactionsCount: deletedTransactions.count
      };
    });

    res.json({
      success: true,
      message: 'Financial Overview & Analytics records cleared successfully. Starting fresh with new production data.',
      ...result
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;


