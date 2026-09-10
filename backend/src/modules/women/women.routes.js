const router = require('express').Router();
const prisma = require('../../config/prisma');
const { requireAuth } = require('../../middleware/auth');
const realtimeService = require('../realtime/realtime.service');

// Dedicated Access Control Middleware for Women's Ministry
async function requireWomenAccess(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const role = req.user.role;
    const email = (req.user.email || '').toLowerCase();

    // 1. Super Admin or dedicated women user or administrator
    if (role === 'SUPER_ADMIN' || role === 'ADMIN' || email === 'women@solutionsfaith.com') {
      return next();
    }

    // 2. Sub-Admin with 'women' or 'members' permission
    if (role === 'SUB_ADMIN') {
      const targetUserId = req.user.id || req.user.userId || req.user.sub;
      const log = await prisma.auditLog.findFirst({
        where: { entity: 'SUB_ADMIN_PROFILE', entityId: targetUserId },
        orderBy: { createdAt: 'desc' }
      });
      const perms = (log && log.metadata && Array.isArray(log.metadata.permissions)) ? log.metadata.permissions : [];
      if (perms.includes('women') || perms.includes('members')) {
        return next();
      }
    }

    return res.status(403).json({ error: "Access Denied: Women's Ministry leader privileges required" });
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
    defaultAmount: 50,
    icon: 'fas fa-calendar-check',
    color: '#e11d48',
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
    defaultAmount: 20,
    icon: 'fas fa-hand-holding-heart',
    color: '#38bdf8',
    isStandard: true,
    active: true
  },
  {
    id: 'WOMEN_CONTRIBUTION',
    name: 'Women Contribution',
    category: "Women's Ministry",
    description: "General fellowship offerings, special seeds, and love contributions",
    frequency: 'MONTHLY',
    targetAmount: 100,
    defaultAmount: 100,
    icon: 'fas fa-gem',
    color: '#f472b6',
    isStandard: true,
    active: true
  }
];

// Helper to load and deduplicate all collection types
async function getAllCollectionTypes() {
  const logs = await prisma.auditLog.findMany({
    where: { entity: 'WOMEN_COLLECTION_TYPE' },
    orderBy: { createdAt: 'asc' }
  });

  const deletionLogs = await prisma.auditLog.findMany({
    where: { entity: 'DELETE_WOMEN_COLLECTION_TYPE' }
  });
  const deletedIds = new Set(deletionLogs.map(l => (l.entityId || '').trim().toUpperCase()));

  const seenNorm = new Set();
  const result = [];

  // Add standard collection types first if not deleted
  for (const s of standardWomenCollectionTypes) {
    const sId = (s.id || '').toUpperCase();
    const sName = normCol(s.name);
    if (!deletedIds.has(sId) && !deletedIds.has(sName) && !seenNorm.has(sName)) {
      seenNorm.add(sName);
      seenNorm.add(sId);
      result.push(s);
    }
  }

  // Add custom collection types, strictly deduplicating by normalized name & ID
  for (const l of logs) {
    const cid = (l.entityId || l.id || '').toUpperCase();
    const cName = normCol(l.metadata?.name || '');
    if (l.metadata && l.metadata.active !== false && !deletedIds.has(cid) && !deletedIds.has(cName) && !seenNorm.has(cName)) {
      seenNorm.add(cName);
      seenNorm.add(cid);
      const tgt = Number(l.metadata.targetAmount || l.metadata.defaultAmount || 50);
      result.push({
        id: l.entityId || l.id,
        ...(l.metadata || {}),
        targetAmount: tgt,
        defaultAmount: tgt,
        isStandard: false,
        createdAt: l.createdAt
      });
    }
  }

  return result;
}

// List collection types (returns both array and { data } compatibility)
router.get('/collection-types', async (req, res, next) => {
  try {
    const collections = await getAllCollectionTypes();
    res.json({
      success: true,
      data: collections,
      collections
    });
  } catch (e) { next(e); }
});

// Create or update a collection type for Women's Ministry
router.post('/collection-types', async (req, res, next) => {
  try {
    const { id, name, category = "Women's Ministry", description = '', frequency = 'MONTHLY', targetAmount = 0, defaultAmount = 0, icon = 'fas fa-gem', color = '#e11d48' } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Collection name is required' });
    }

    const cleanName = name.trim();
    const cleanNorm = normCol(cleanName);
    const amountVal = Number(defaultAmount || targetAmount || 50);

    const existingLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_COLLECTION_TYPE' }
    });
    const match = existingLogs.find(l => 
      (l.entityId && l.entityId === id) ||
      (l.metadata && normCol(l.metadata.name) === cleanNorm)
    );

    const typeId = match ? (match.entityId || match.id) : (id || `wcol_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`);

    const metadata = {
      name: cleanName,
      category: category.trim() || "Women's Ministry",
      description: description.trim(),
      frequency,
      targetAmount: amountVal,
      defaultAmount: amountVal,
      icon,
      color,
      active: true
    };

    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_COLLECTION_TYPE', entityId: typeId }
    });

    await prisma.auditLog.deleteMany({
      where: {
        entity: 'DELETE_WOMEN_COLLECTION_TYPE',
        entityId: { in: [cleanName.toUpperCase(), cleanNorm, typeId.toUpperCase()] }
      }
    });

    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: match ? 'UPDATE_WOMEN_COLLECTION_TYPE' : 'CREATE_WOMEN_COLLECTION_TYPE',
        entity: 'WOMEN_COLLECTION_TYPE',
        entityId: typeId,
        metadata
      }
    });

    res.status(201).json({ success: true, data: { id: typeId, ...metadata, isStandard: false } });
  } catch (e) { next(e); }
});

// Delete collection type
router.delete('/collection-types/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const cleanId = (id || '').trim();

    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_COLLECTION_TYPE', entityId: cleanId }
    });

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

// ── 2. REGISTERED WOMEN FELLOWSHIP DIRECTORY & ROSTER ──
async function getUnifiedWomenRoster(targetCollectionType = 'WOMEN_DUES') {
  // 1. Fetch registered sisters from audit logs
  let customLogs = [];
  try {
    customLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_MEMBER' },
      orderBy: { createdAt: 'asc' }
    });
  } catch (e) {}

  let deletionLogs = [];
  try {
    deletionLogs = await prisma.auditLog.findMany({
      where: { entity: 'DELETE_WOMEN_MEMBER' }
    });
  } catch (e) {}
  const deletedIds = new Set(deletionLogs.map(l => (l.entityId || '').trim()));

  const collectionList = await getAllCollectionTypes();
  const targetColNorm = normCol(targetCollectionType);
  const matchedCol = collectionList.find(c => normCol(c.id) === targetColNorm || normCol(c.name) === targetColNorm);
  const defaultPledge = matchedCol ? (Number(matchedCol.defaultAmount || matchedCol.targetAmount) || 50) : (targetColNorm.includes('WELFARE') ? 20 : (targetColNorm.includes('CONTRIBUTION') ? 100 : 50));

  const sistersMap = new Map();

  for (const l of customLogs) {
    if (!l.metadata || l.metadata.active === false) continue;
    const entityId = (l.entityId || l.id || '').trim();
    if (deletedIds.has(entityId) || deletedIds.has(l.id)) continue;

    const m = l.metadata;
    const fullName = (m.fullName || m.memberName || `${m.firstName || ''} ${m.lastName || ''}`).trim() || 'Sister';
    const cleanPhone = (m.phone || '').trim();
    const key = entityId || ((cleanPhone && cleanPhone !== '—') ? cleanPhone : fullName.toLowerCase());

    const existing = sistersMap.get(key);
    if (existing) {
      if (m.pledgeAmount !== undefined && Number(m.pledgeAmount) > 0 && (normCol(m.collectionType) === targetColNorm || !existing.hasCustomRate)) {
        existing.pledgeAmount = Number(m.pledgeAmount);
        existing.hasCustomRate = true;
      }
      if (m.notes) existing.notes = m.notes;
    } else {
      sistersMap.set(key, {
        id: entityId,
        womenMemberId: entityId,
        partnerId: entityId,
        memberId: m.memberId || null,
        memberName: fullName,
        fullName: fullName,
        firstName: m.firstName || fullName.split(' ')[0] || 'Sister',
        lastName: m.lastName || fullName.split(' ').slice(1).join(' ') || '',
        phone: cleanPhone || '—',
        email: m.email || '',
        gender: 'Female',
        address: m.address || '',
        pledgeAmount: (m.pledgeAmount !== undefined && Number(m.pledgeAmount) > 0) ? Number(m.pledgeAmount) : defaultPledge,
        currency: m.currency || 'GHS',
        collectionType: targetCollectionType,
        hasCustomRate: Boolean(m.pledgeAmount && Number(m.pledgeAmount) > 0),
        active: true,
        createdAt: l.createdAt
      });
    }
  }

  const result = Array.from(sistersMap.values());
  result.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return result;
}

// Enrolled Women Members Roster
router.get('/members', async (req, res, next) => {
  try {
    const { collectionType = 'WOMEN_DUES' } = req.query;
    const sisters = await getUnifiedWomenRoster(collectionType);

    const paymentLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_PAYMENT' },
      select: { metadata: true }
    });

    const totalsMap = {};
    for (const p of paymentLogs) {
      if (p.metadata) {
        const pCol = normCol(p.metadata.collectionType);
        const amt = Number(p.metadata.amount) || 0;
        const memberIdKey = p.metadata.womenMemberId || p.metadata.partnerId || p.metadata.memberId;
        
        if (memberIdKey) {
          const k = `${memberIdKey}_${pCol}`;
          totalsMap[k] = (totalsMap[k] || 0) + amt;
        } else if (p.metadata.memberName || p.metadata.fullName) {
          const kName = `${(p.metadata.fullName || p.metadata.memberName || '').trim().toLowerCase()}_${pCol}`;
          totalsMap[kName] = (totalsMap[kName] || 0) + amt;
        }
      }
    }

    const enriched = sisters.map(s => {
      const sCol = normCol(collectionType);
      const kId = `${s.id}_${sCol}`;
      const kName = `${(s.fullName || s.memberName || '').trim().toLowerCase()}_${sCol}`;
      const totalContributed = totalsMap[kId] !== undefined ? totalsMap[kId] : (totalsMap[kName] || 0);
      return {
        ...s,
        totalContributed,
        totalPaid: totalContributed
      };
    });

    res.json({
      success: true,
      data: enriched,
      members: enriched
    });
  } catch (e) { next(e); }
});

// Register a Sister into the Women's Ministry Fellowship Directory
router.post('/members', async (req, res, next) => {
  try {
    const { id, memberId, fullName, memberName, phone, email, pledgeAmount = 50, currency = 'GHS', frequency = 'MONTHLY', collectionType = 'WOMEN_DUES', startDate, notes } = req.body || {};

    const cleanName = (fullName || memberName || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Sister name is required' });
    }

    const cleanCollection = (collectionType || 'WOMEN_DUES').trim();

    let targetEntityId = id;
    if (!targetEntityId) {
      const existingLogs = await prisma.auditLog.findMany({
        where: { entity: 'WOMEN_MEMBER' }
      });
      const match = existingLogs.find(l =>
        l.metadata &&
        (l.metadata.fullName || l.metadata.memberName || '').trim().toLowerCase() === cleanName.toLowerCase()
      );
      if (match) {
        targetEntityId = match.entityId || match.id;
      }
    }

    const womenMemberId = targetEntityId || `wmem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_MEMBER', entityId: womenMemberId }
    });

    const metadata = {
      memberId: memberId || null,
      fullName: cleanName,
      memberName: cleanName,
      phone: phone ? phone.trim() : '',
      email: email ? email.trim() : '',
      pledgeAmount: Number(pledgeAmount) || 50,
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

    try {
      realtimeService.broadcast('WOMEN_MEMBER_UPDATED', {
        memberId: womenMemberId,
        name: cleanName
      });
    } catch (rErr) {}

    res.status(201).json({ success: true, data: { id: womenMemberId, ...metadata } });
  } catch (e) { next(e); }
});

// Remove a sister
router.delete('/members/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.auditLog.deleteMany({
      where: { entity: 'WOMEN_MEMBER', entityId: id }
    });
    res.json({ success: true, message: 'Sister updated in roster successfully' });
  } catch (e) { next(e); }
});

// ── 3. WOMEN PAYMENTS (STRICT DEDUPLICATION & ZERO DOUBLE-COUNTING) ──
router.post('/payments', async (req, res, next) => {
  try {
    const {
      womenMemberId,
      fullName,
      memberName,
      amount,
      targetMonth,
      month,
      year,
      paymentDate,
      paymentMethod = 'CASH',
      collectionType = 'WOMEN_DUES',
      recordedBy = "Women's Ministry Leader",
      notes
    } = req.body || {};

    const cleanMemberName = (fullName || memberName || '').trim();
    const parsedAmount = Number(amount);

    // Resolve month format
    let resolvedMonth = targetMonth;
    if (!resolvedMonth) {
      const y = year || new Date().getFullYear();
      const m = month || (new Date().getMonth() + 1);
      resolvedMonth = `${y}-${String(m).padStart(2, '0')}`;
    }

    if (!cleanMemberName || !parsedAmount || !resolvedMonth) {
      return res.status(400).json({ error: 'Sister name, amount, and target month are required' });
    }

    const resolvedCollection = (collectionType || 'WOMEN_DUES').trim();
    const dateStr = paymentDate || new Date().toISOString().slice(0, 10);

    // ── DEDUPLICATION GUARD ──
    const recentDuplicate = await prisma.auditLog.findFirst({
      where: {
        entity: 'WOMEN_PAYMENT',
        createdAt: { gte: new Date(Date.now() - 10000) }
      },
      orderBy: { createdAt: 'desc' }
    });
    if (recentDuplicate && recentDuplicate.metadata) {
      const rm = recentDuplicate.metadata;
      if (
        (rm.fullName || rm.memberName || '').trim().toLowerCase() === cleanMemberName.toLowerCase() &&
        normCol(rm.collectionType) === normCol(resolvedCollection) &&
        rm.targetMonth === resolvedMonth &&
        Number(rm.amount) === parsedAmount
      ) {
        return res.status(200).json({ success: true, data: rm });
      }
    }

    const paymentId = `wpay_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const monthNumber = parseInt(resolvedMonth.slice(5, 7), 10) || 1;
    const yearNumber = parseInt(resolvedMonth.slice(0, 4), 10) || new Date().getFullYear();

    const paymentMeta = {
      id: paymentId,
      paymentId,
      receiptNumber: `REC-${paymentId.slice(-6).toUpperCase()}`,
      womenMemberId: womenMemberId || null,
      partnerId: womenMemberId || null,
      fullName: cleanMemberName,
      memberName: cleanMemberName,
      amount: parsedAmount,
      targetMonth: resolvedMonth,
      month: monthNumber,
      year: yearNumber,
      paymentDate: dateStr,
      paymentMethod,
      collectionType: resolvedCollection,
      recordedBy: recordedBy ? recordedBy.trim() : "Women's Ministry Leader",
      notes: notes ? notes.trim() : ''
    };

    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'RECORD_WOMEN_PAYMENT',
        entity: 'WOMEN_PAYMENT',
        entityId: paymentId,
        metadata: paymentMeta
      }
    });

    try {
      const code = `WOMEN_${normCol(resolvedCollection)}`;
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
          description: `Women ${resolvedCollection} Payment: ${cleanMemberName} for ${resolvedMonth} via ${paymentMethod}`
        }
      });
    } catch (err) {}

    try {
      realtimeService.broadcast('WOMEN_PAYMENT_RECORDED', {
        paymentId,
        memberName: cleanMemberName,
        amount: parsedAmount,
        collectionType: resolvedCollection,
        targetMonth: resolvedMonth
      });
    } catch (rErr) {}

    res.status(201).json({ success: true, data: paymentMeta });
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
      const cNorm = normCol(collectionType);
      payments = payments.filter(p => normCol(p.collectionType || 'WOMEN_DUES') === cNorm);
    }

    res.json({
      success: true,
      data: payments,
      payments
    });
  } catch (e) { next(e); }
});

// Delete a payment record
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
router.get('/matrix', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const { collectionType = 'WOMEN_DUES' } = req.query;
    const currentMonthNum = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const sisters = await getUnifiedWomenRoster(collectionType);

    const paymentLogs = await prisma.auditLog.findMany({
      where: { entity: 'WOMEN_PAYMENT' },
      orderBy: { createdAt: 'desc' }
    });
    const allPayments = paymentLogs.map(l => l.metadata).filter(Boolean);

    // Map payments strictly ONCE per transaction
    const memberMonthMap = {};
    const currMonthPad = String(currentMonthNum).padStart(2, '0');
    const targetCurrMonth = `${year}-${currMonthPad}`;

    const collectionBreakdown = {};
    const allCollections = await getAllCollectionTypes();
    allCollections.forEach(c => {
      const cNorm = normCol(c.id || c.name);
      collectionBreakdown[cNorm] = {
        name: c.name,
        totalEnrolled: sisters.length,
        totalMonthlyPledged: (Number(c.defaultAmount || c.targetAmount) || 0) * sisters.length,
        currentMonthCollected: 0,
        yearTotalCollected: 0
      };
    });

    const activeColNorm = normCol(collectionType);

    for (const p of allPayments) {
      const pCol = normCol(p.collectionType || 'WOMEN_DUES');
      const amt = Number(p.amount) || 0;

      if (!collectionBreakdown[pCol]) {
        collectionBreakdown[pCol] = {
          name: p.collectionType || 'Women Collection',
          totalEnrolled: sisters.length,
          totalMonthlyPledged: 0,
          currentMonthCollected: 0,
          yearTotalCollected: 0
        };
      }
      collectionBreakdown[pCol].yearTotalCollected += amt;
      if (p.targetMonth === targetCurrMonth) {
        collectionBreakdown[pCol].currentMonthCollected += amt;
      }

      if (pCol === activeColNorm && p.targetMonth && p.targetMonth.startsWith(String(year))) {
        const monthPart = parseInt(p.targetMonth.slice(5, 7), 10);
        const memberIdKey = p.womenMemberId || p.partnerId || p.memberId;
        const nameKey = (p.fullName || p.memberName || '').trim().toLowerCase();

        const primaryKey = memberIdKey ? `id_${memberIdKey}` : `name_${nameKey}`;
        if (!memberMonthMap[primaryKey]) memberMonthMap[primaryKey] = {};
        memberMonthMap[primaryKey][monthPart] = (memberMonthMap[primaryKey][monthPart] || 0) + amt;

        // Also record under name fallback if id was used
        if (memberIdKey && nameKey) {
          const fallbackKey = `name_${nameKey}`;
          if (!memberMonthMap[fallbackKey]) memberMonthMap[fallbackKey] = {};
          memberMonthMap[fallbackKey][monthPart] = (memberMonthMap[fallbackKey][monthPart] || 0) + amt;
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

    const monthTotals = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 };

    const matrix = sisters.map(s => {
      const pledge = Number(s.pledgeAmount) || 50;
      totalMonthlyPledged += pledge;

      const monthlyStatus = {};
      const months = {};
      let memberYearPaid = 0;

      const idKey = `id_${s.id}`;
      const nameKey = `name_${(s.fullName || s.memberName || '').trim().toLowerCase()}`;

      const activeMonthNum = (year < currentYear) ? 12 : ((year > currentYear) ? 1 : currentMonthNum);

      for (let month = 1; month <= 12; month++) {
        const mKey = String(month).padStart(2, '0');
        const paidAmount = (memberMonthMap[idKey] && memberMonthMap[idKey][month] !== undefined)
          ? memberMonthMap[idKey][month]
          : ((memberMonthMap[nameKey] && memberMonthMap[nameKey][month] !== undefined) ? memberMonthMap[nameKey][month] : 0);

        months[month] = paidAmount;
        monthTotals[month] += paidAmount;
        memberYearPaid += paidAmount;

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

      totalYearToDate += memberYearPaid;

      return {
        id: s.id,
        womenMemberId: s.id,
        partnerId: s.id,
        memberId: s.memberId || null,
        memberName: s.fullName || s.memberName,
        fullName: s.fullName || s.memberName,
        phone: s.phone || '—',
        email: s.email || '',
        collectionType: collectionType,
        pledgeAmount: pledge,
        currency: s.currency || 'GHS',
        yearTotalPaid: memberYearPaid,
        totalPaid: memberYearPaid,
        months,
        monthlyStatus
      };
    });

    const responsePayload = {
      year,
      collectionType: collectionType || 'WOMEN_DUES',
      collectionBreakdown,
      monthTotals,
      yearTotal: totalYearToDate,
      summary: {
        totalEnrolled: sisters.length,
        totalMonthlyPledged,
        currentMonthPledged,
        currentMonthCollected,
        currentMonthFulfillmentPct: currentMonthPledged > 0 ? Math.round((currentMonthCollected / currentMonthPledged) * 100) : 0,
        currentMonthPaidCount,
        currentMonthMissedCount,
        totalYearToDate
      },
      members: matrix,
      matrix
    };

    res.json({
      success: true,
      data: responsePayload,
      ...responsePayload
    });
  } catch (e) { next(e); }
});

module.exports = router;
