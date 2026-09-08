const router = require('express').Router();
const prisma = require('../../config/prisma');
const { requireAuth } = require('../../middleware/auth');

// Dedicated Access Control Middleware for Women's Ministry
async function requireWomenAccess(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const role = req.user.role;
    const email = (req.user.email || '').toLowerCase();

    // 1. Super Admin or dedicated women user
    if (role === 'SUPER_ADMIN' || email === 'women@solutionsfaith.com') {
      return next();
    }

    // 2. Sub-Admin with 'women' permission
    if (role === 'ADMIN') {
      const targetUserId = req.user.id || req.user.userId || req.user.sub;
      const log = await prisma.auditLog.findFirst({
        where: { entity: 'SUB_ADMIN_PROFILE', entityId: targetUserId },
        orderBy: { createdAt: 'desc' }
      });
      const perms = (log && log.metadata && Array.isArray(log.metadata.permissions)) ? log.metadata.permissions : [];
      if (perms.includes('women')) {
        return next();
      }
    }

    return res.status(403).json({ error: 'Access Denied: Women\'s Ministry leader privileges required' });
  } catch (err) {
    return res.status(500).json({ error: 'Internal authorization error' });
  }
}

function normCol(str) {
  if (!str) return 'WOMEN_DUES';
  return String(str).replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').trim().toUpperCase();
}

// Helper to safely resolve valid User ID for AuditLog actor relation
async function resolveActorId(req) {
  const uid = req.user?.id || req.user?.userId || req.user?.sub;
  if (!uid) return null;
  try {
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
    return u ? u.id : null;
  } catch {
    return null;
  }
}

// Apply authentication and access control to all women routes
router.use(requireAuth, requireWomenAccess);

// ── 1. COLLECTION / FUND TYPES ──
const standardWomenCollectionTypes = [
  {
    id: 'WOMEN_DUES',
    name: 'Women Monthly Dues',
    category: "Women's Ministry",
    description: "Monthly fellowship dues for registered Women of Faith members",
    frequency: 'MONTHLY',
    targetAmount: 50,
    icon: 'fas fa-calendar-check',
    color: '#e11d48',
    isStandard: true,
    active: true
  },
  {
    id: 'WOMEN_CONTRIBUTION',
    name: 'Women Contribution',
    category: "Women's Ministry",
    description: "General fellowship offerings, special seeds, and love contributions",
    frequency: 'MONTHLY',
    targetAmount: 0,
    icon: 'fas fa-gem',
    color: '#f472b6',
    isStandard: true,
    active: true
  },
  {
    id: 'WOMEN_WELFARE',
    name: 'Women Welfare Fund',
    category: "Women's Ministry",
    description: "Sister-to-sister emergency support, benevolence, and visitation dues",
    frequency: 'MONTHLY',
    targetAmount: 20,
    icon: 'fas fa-hand-holding-heart',
    color: '#38bdf8',
    isStandard: true,
    active: true
  }
];

// List collection types (filtering out deleted standard or custom types)
router.get('/collection-types', async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_COLLECTION_TYPE' },
      orderBy: { createdAt: 'asc' }
    });

    const deletionLogs = await prisma.auditLog.findMany({
      where: { entity: 'DELETE_WOMEN_COLLECTION_TYPE' }
    });
    const deletedIds = new Set(deletionLogs.map(l => (l.entityId || '').trim().toUpperCase()));

    const customTypes = logs.map(l => ({
      id: l.entityId || l.id,
      ...(l.metadata || {}),
      isStandard: false,
      createdAt: l.createdAt
    })).filter(t => t.active !== false && !deletedIds.has((t.id || '').toUpperCase()) && !deletedIds.has((t.name || '').toUpperCase()));

    const standards = standardWomenCollectionTypes.filter(s => !deletedIds.has(s.id.toUpperCase()) && !deletedIds.has(s.name.toUpperCase()));

    res.json([...standards, ...customTypes]);
  } catch (e) { next(e); }
});

// Create a new collection type for Women's Ministry
router.post('/collection-types', async (req, res, next) => {
  try {
    const { name, category = "Women's Ministry", description = '', frequency = 'MONTHLY', targetAmount = 0, icon = 'fas fa-gem', color = '#e11d48' } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Collection name is required' });
    }

    const cleanName = name.trim();
    const typeId = `wcol_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const metadata = {
      name: cleanName,
      category: category.trim() || "Women's Ministry",
      description: description.trim(),
      frequency,
      targetAmount: Number(targetAmount) || 0,
      icon,
      color,
      active: true
    };

    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'CREATE_WOMEN_COLLECTION_TYPE',
        entity: 'WOMEN_COLLECTION_TYPE',
        entityId: typeId,
        metadata
      }
    });

    res.status(201).json({ id: typeId, ...metadata, isStandard: false });
  } catch (e) { next(e); }
});

// Delete collection type (allows removing standard & custom collection types)
router.delete('/collection-types/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const cleanId = (id || '').trim();

    // 1. Delete custom type record if present
    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_COLLECTION_TYPE', entityId: cleanId }
    });

    // 2. Log deletion record to suppress standard type if standard
    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'DELETE_WOMEN_COLLECTION_TYPE',
        entity: 'DELETE_WOMEN_COLLECTION_TYPE',
        entityId: cleanId.toUpperCase(),
        metadata: { deletedId: cleanId, deletedAt: new Date().toISOString() }
      }
    });

    res.json({ success: true, message: 'Collection type removed successfully' });
  } catch (e) { next(e); }
});

// ── 2. ENROLLED WOMEN MEMBERS (ROSTER) ──
// Strictly returns enrolled women members — never auto-adds all females in church
router.get('/members', async (req, res, next) => {
  try {
    const { collectionType } = req.query;

    const logs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_MEMBER' },
      orderBy: { createdAt: 'desc' }
    });

    let members = logs.map(l => ({
      id: l.entityId || l.id,
      collectionType: (l.metadata && l.metadata.collectionType) || 'WOMEN_DUES',
      pledgeAmount: (l.metadata && Number(l.metadata.pledgeAmount)) || 0,
      currency: (l.metadata && l.metadata.currency) || 'GHS',
      ...(l.metadata || {}),
      createdAt: l.createdAt
    })).filter(m => m.active !== false);

    if (collectionType && collectionType.toUpperCase() !== 'ALL') {
      const cNorm = collectionType.toUpperCase();
      members = members.filter(m => (m.collectionType || 'WOMEN_DUES').toUpperCase() === cNorm);
    }

    // Fetch payments to compute lifetime contributions per collection
    const paymentLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_PAYMENT' },
      select: { metadata: true }
    });

    const totalsMap = {};
    for (const p of paymentLogs) {
      if (p.metadata) {
        const pCol = normCol(p.metadata.collectionType);
        const amt = Number(p.metadata.amount) || 0;
        if (p.metadata.womenMemberId) {
          const k = `${p.metadata.womenMemberId}_${pCol}`;
          totalsMap[k] = (totalsMap[k] || 0) + amt;
        }
        if (p.metadata.partnerId) {
          const k = `${p.metadata.partnerId}_${pCol}`;
          totalsMap[k] = (totalsMap[k] || 0) + amt;
        }
        if (p.metadata.memberName) {
          const k = `${(p.metadata.memberName || '').trim().toLowerCase()}_${pCol}`;
          totalsMap[k] = (totalsMap[k] || 0) + amt;
        }
      }
    }

    const enriched = members.map(m => {
      const mCol = normCol(m.collectionType);
      const kId = `${m.id}_${mCol}`;
      const kName = `${(m.memberName || '').trim().toLowerCase()}_${mCol}`;
      return {
        ...m,
        totalContributed: totalsMap[kId] || totalsMap[kName] || 0
      };
    });

    res.json(enriched);
  } catch (e) { next(e); }
});

// Enrol / Register a Sister into a specific collection or fellowship
router.post('/members', async (req, res, next) => {
  try {
    const { id, memberId, memberName, phone, email, pledgeAmount = 50, currency = 'GHS', frequency = 'MONTHLY', collectionType = 'WOMEN_DUES', startDate, notes } = req.body || {};

    if (!memberName || !memberName.trim()) {
      return res.status(400).json({ error: 'Sister name is required' });
    }

    const cleanName = memberName.trim();
    const cleanCollection = (collectionType || 'WOMEN_DUES').trim();

    let targetEntityId = id;
    if (!targetEntityId) {
      const existingLogs = await prisma.auditLog.findMany({
        where: { entity: 'WOMEN_MEMBER' }
      });
      const match = existingLogs.find(l =>
        l.metadata &&
        (l.metadata.memberName || '').trim().toLowerCase() === cleanName.toLowerCase() &&
        (l.metadata.collectionType || 'WOMEN_DUES').trim().toUpperCase() === cleanCollection.toUpperCase()
      );
      if (match) {
        targetEntityId = match.entityId || match.id;
      }
    }

    const womenMemberId = targetEntityId || `wmem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Remove any previous active record with same entityId to update in place
    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_MEMBER', entityId: womenMemberId }
    });

    const metadata = {
      memberId: memberId || null,
      memberName: cleanName,
      phone: phone ? phone.trim() : '',
      email: email ? email.trim() : '',
      pledgeAmount: Number(pledgeAmount) || 0,
      currency,
      frequency,
      collectionType: cleanCollection,
      startDate: startDate || new Date().toISOString().slice(0, 10),
      notes: notes ? notes.trim() : '',
      active: true
    };

    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: id ? 'UPDATE_WOMEN_MEMBER' : 'REGISTER_WOMEN_MEMBER',
        entity: 'WOMEN_MEMBER',
        entityId: womenMemberId,
        metadata
      }
    });

    res.status(201).json({ id: womenMemberId, ...metadata });
  } catch (e) { next(e); }
});

// Delete / Remove an enrolled sister from the collection roster
router.delete('/members/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_MEMBER', entityId: id }
    });
    res.json({ success: true, message: 'Sister removed from collection roster successfully' });
  } catch (e) { next(e); }
});

// ── 3. WOMEN PAYMENTS ──
// Record a payment for an enrolled sister
router.post('/payments', async (req, res, next) => {
  try {
    const { womenMemberId, memberName, amount, targetMonth, paymentDate, paymentMethod = 'CASH', collectionType = 'WOMEN_DUES', recordedBy = "Women's Ministry Leader", notes } = req.body || {};

    if (!memberName || !amount || !targetMonth) {
      return res.status(400).json({ error: 'Sister name, amount, and target month (YYYY-MM) are required' });
    }

    let resolvedMemberId = womenMemberId;
    let resolvedCollection = collectionType || 'WOMEN_DUES';

    // If womenMemberId is given, resolve collectionType if needed
    if (resolvedMemberId) {
      const mLog = await prisma.auditLog.findFirst({
        where: { entity: 'WOMEN_MEMBER', entityId: resolvedMemberId }
      });
      if (mLog && mLog.metadata) {
        if (!collectionType && mLog.metadata.collectionType) {
          resolvedCollection = mLog.metadata.collectionType;
        }
      }
    }

    const paymentId = `wpay_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const parsedAmount = Number(amount);
    const dateStr = paymentDate || new Date().toISOString().slice(0, 10);

    const paymentMeta = {
      paymentId,
      womenMemberId: resolvedMemberId || null,
      partnerId: resolvedMemberId || null, // for uniform backward-compatibility
      memberName: memberName.trim(),
      amount: parsedAmount,
      targetMonth, // format YYYY-MM e.g. "2026-08"
      paymentDate: dateStr,
      paymentMethod,
      collectionType: resolvedCollection,
      recordedBy: recordedBy ? recordedBy.trim() : "Women's Ministry Leader",
      notes: notes ? notes.trim() : ''
    };

    // Save payment log
    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'RECORD_WOMEN_PAYMENT',
        entity: 'WOMEN_PAYMENT',
        entityId: paymentId,
        metadata: paymentMeta
      }
    });

    // Cross-post into double-entry ledger account
    try {
      const code = `WOMEN_${resolvedCollection.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
      let acct = await prisma.financialAccount.findUnique({ where: { code } });
      if (!acct) {
        acct = await prisma.financialAccount.create({
          data: {
            name: `Women's Ministry — ${resolvedCollection}`,
            code,
            active: true
          }
        });
      }

      await prisma.financialTransaction.create({
        data: {
          accountId: acct.id,
          type: 'INCOME',
          amount: parsedAmount,
          reference: `WMN-${paymentId.slice(-6).toUpperCase()}`,
          description: `Women ${resolvedCollection} Payment: ${memberName} for ${targetMonth} via ${paymentMethod}`
        }
      });
    } catch (err) {}

    res.status(201).json(paymentMeta);
  } catch (e) { next(e); }
});

// List all Women's Ministry payments
router.get('/payments', async (req, res, next) => {
  try {
    const { womenMemberId, targetMonth, year, collectionType } = req.query;
    const logs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_PAYMENT' },
      orderBy: { createdAt: 'desc' }
    });

    let payments = logs.map(l => l.metadata).filter(Boolean);

    if (womenMemberId) {
      payments = payments.filter(p => p.womenMemberId === womenMemberId || p.partnerId === womenMemberId);
    }
    if (targetMonth) {
      payments = payments.filter(p => p.targetMonth === targetMonth);
    }
    if (year) {
      payments = payments.filter(p => p.targetMonth && p.targetMonth.startsWith(String(year)));
    }
    if (collectionType && collectionType.toUpperCase() !== 'ALL') {
      const cNorm = collectionType.toUpperCase();
      payments = payments.filter(p => (p.collectionType || 'WOMEN_DUES').toUpperCase() === cNorm);
    }

    res.json(payments);
  } catch (e) { next(e); }
});

// Delete a Women payment
router.delete('/payments/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_PAYMENT', entityId: id }
    });
    res.json({ success: true, message: 'Payment record removed' });
  } catch (e) { next(e); }
});

// ── 4. 12-MONTH DUES & COLLECTION TRACKING MATRIX ──
// Returns the matrix strictly for enrolled sisters, separated by collection fund
router.get('/matrix', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const { collectionType } = req.query;
    const currentMonthNum = new Date().getMonth() + 1; // 1 to 12
    const currentYear = new Date().getFullYear();

    // 1. Fetch enrolled women members
    const memberLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_MEMBER' },
      orderBy: { createdAt: 'desc' }
    });

    let members = memberLogs.map(l => ({
      id: l.entityId || l.id,
      collectionType: (l.metadata && l.metadata.collectionType) || 'WOMEN_DUES',
      pledgeAmount: (l.metadata && Number(l.metadata.pledgeAmount)) || 0,
      currency: (l.metadata && l.metadata.currency) || 'GHS',
      ...(l.metadata || {})
    })).filter(m => m.active !== false);

    // 2. Fetch all women payments for this year
    const paymentLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_PAYMENT' },
      orderBy: { createdAt: 'desc' }
    });
    const allPayments = paymentLogs.map(l => l.metadata).filter(Boolean);

    // 3. Collection Breakdown for metric cards
    const collectionBreakdown = {};
    members.forEach(m => {
      const cType = (m.collectionType || 'WOMEN_DUES').toUpperCase();
      if (!collectionBreakdown[cType]) {
        collectionBreakdown[cType] = { totalEnrolled: 0, totalMonthlyPledged: 0, currentMonthCollected: 0, yearTotalCollected: 0 };
      }
      collectionBreakdown[cType].totalEnrolled++;
      collectionBreakdown[cType].totalMonthlyPledged += (Number(m.pledgeAmount) || 0);
    });

    const currMonthPad = String(currentMonthNum).padStart(2, '0');
    const targetCurrMonth = `${year}-${currMonthPad}`;

    allPayments.forEach(pay => {
      const cType = (pay.collectionType || 'WOMEN_DUES').toUpperCase();
      if (!collectionBreakdown[cType]) {
        collectionBreakdown[cType] = { totalEnrolled: 0, totalMonthlyPledged: 0, currentMonthCollected: 0, yearTotalCollected: 0 };
      }
      const amt = Number(pay.amount) || 0;
      collectionBreakdown[cType].yearTotalCollected += amt;
      if (pay.targetMonth === targetCurrMonth) {
        collectionBreakdown[cType].currentMonthCollected += amt;
      }
    });

    // 4. Filter by collectionType if requested
    if (collectionType && collectionType.toUpperCase() !== 'ALL') {
      const cNorm = collectionType.toUpperCase();
      members = members.filter(m => (m.collectionType || 'WOMEN_DUES').toUpperCase() === cNorm);
    }

    // 5. Map payments by womenMemberId/memberName, collectionType, and month
    const memberMonthMap = {};
    for (const p of allPayments) {
      if (p.targetMonth && p.targetMonth.startsWith(String(year))) {
        const monthPart = p.targetMonth.slice(5, 7); // e.g. "08"
        const pCol = normCol(p.collectionType);
        const amt = Number(p.amount) || 0;

        if (p.womenMemberId) {
          const k = `${p.womenMemberId}_${pCol}`;
          if (!memberMonthMap[k]) memberMonthMap[k] = {};
          memberMonthMap[k][monthPart] = (memberMonthMap[k][monthPart] || 0) + amt;
        }
        if (p.partnerId) {
          const k = `${p.partnerId}_${pCol}`;
          if (!memberMonthMap[k]) memberMonthMap[k] = {};
          memberMonthMap[k][monthPart] = (memberMonthMap[k][monthPart] || 0) + amt;
        }
        if (p.memberName) {
          const k = `${(p.memberName || '').trim().toLowerCase()}_${pCol}`;
          if (!memberMonthMap[k]) memberMonthMap[k] = {};
          memberMonthMap[k][monthPart] = (memberMonthMap[k][monthPart] || 0) + amt;
        }
      }
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let totalMonthlyPledged = 0;
    let currentMonthPledged = 0;
    let currentMonthCollected = 0;
    let currentMonthPaidCount = 0;
    let currentMonthMissedCount = 0;
    let totalYearToDate = 0;

    const matrix = members.map(m => {
      const pledge = Number(m.pledgeAmount) || 0;
      totalMonthlyPledged += pledge;

      const monthlyStatus = {};
      let memberYearPaid = 0;
      const mCol = normCol(m.collectionType);
      const kId = `${m.id}_${mCol}`;
      const kName = `${(m.memberName || '').trim().toLowerCase()}_${mCol}`;

      const activeMonthNum = (year < currentYear) ? 12 : ((year > currentYear) ? 1 : currentMonthNum);

      for (let month = 1; month <= 12; month++) {
        const mKey = String(month).padStart(2, '0');
        const paidAmount = (memberMonthMap[kId] && memberMonthMap[kId][mKey])
          || (memberMonthMap[kName] && memberMonthMap[kName][mKey])
          || 0;
        memberYearPaid += paidAmount;
        totalYearToDate += paidAmount;

        let status = 'PENDING';
        const isPastMonth = (year < currentYear) || (year === currentYear && month < currentMonthNum);
        const isCurrentMonth = (month === activeMonthNum);

        if (paidAmount > 0) {
          if (pledge > 0 && paidAmount < pledge) {
            status = 'PARTIAL';
          } else {
            status = 'PAID';
          }
        } else if (isPastMonth) {
          status = 'MISSED';
        } else if (isCurrentMonth) {
          status = 'DUE';
        } else {
          status = 'PENDING';
        }

        monthlyStatus[mKey] = {
          monthName: monthNames[month - 1],
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
        id: m.id,
        womenMemberId: m.id,
        partnerId: m.id,
        memberId: m.memberId || null,
        memberName: m.memberName,
        phone: m.phone || '—',
        email: m.email || '',
        collectionType: m.collectionType || 'WOMEN_DUES',
        pledgeAmount: pledge,
        currency: m.currency || 'GHS',
        yearTotalPaid: memberYearPaid,
        monthlyStatus
      };
    });

    res.json({
      year,
      collectionType: collectionType || 'ALL',
      collectionBreakdown,
      summary: {
        totalEnrolled: members.length,
        totalMonthlyPledged,
        currentMonthPledged,
        currentMonthCollected,
        currentMonthFulfillmentPct: currentMonthPledged > 0 ? Math.round((currentMonthCollected / currentMonthPledged) * 100) : 0,
        currentMonthPaidCount,
        currentMonthMissedCount,
        totalYearToDate
      },
      matrix
    });
  } catch (e) { next(e); }
});

module.exports = router;
