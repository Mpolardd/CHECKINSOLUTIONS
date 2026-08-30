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
  recordedBy: z.string().min(1, 'Recorded by is required'),
  notes: z.string().optional()
});

// Accounts List - Protected for Finance and Administrators
router.get('/accounts', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'FINANCE'), async (req, res, next) => {
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

router.get('/summary', requireAuth, requireRoles('SUPER_ADMIN', 'FINANCE'), async (req, res, next) => {
  try {
    const rows = await prisma.financialTransaction.findMany({ select: { type: true, amount: true } });
    let income = 0, expense = 0;
    for (const r of rows) {
      const n = Number(r.amount);
      if (r.type === 'INCOME') income += n;
      if (r.type === 'EXPENSE') expense += n;
    }
    res.json({ income, expense, balance: income - expense });
  } catch (e) { next(e); }
});

module.exports = router;
