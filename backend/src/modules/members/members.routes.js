const router = require('express').Router();
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { requireAuth, requireRoles } = require('../../middleware/auth');
const { normalizePhone } = require('../../utils/phone');

const memberSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().optional(),
  category: z.string().optional(),
  role: z.string().optional(),
  guardian: z.string().optional(),
  dateOfBirth: z.string().optional(),
  anniversary: z.string().optional(),
  householdId: z.string().optional()
});

function parseOptionalDate(val) {
  if (!val || typeof val !== 'string') return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const where = { active: true, deletedAt: null };
    if (q) {
      const norm = normalizePhone(q);
      const orList = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } }
      ];
      if (norm && norm !== q) {
        orList.push({ phone: { contains: norm } });
      }
      where.OR = orList;
    }
    const rows = await prisma.member.findMany({
      where,
      take: 500,
      orderBy: { createdAt: 'desc' }
    });

    const memberIds = rows.map(r => r.id);
    const guestLogs = await prisma.auditLog.findMany({
      where: {
        action: 'VISITOR_REGISTRATION',
        entityId: { in: memberIds }
      }
    });
    const guestIds = new Set(guestLogs.map(l => l.entityId));

    const result = rows.map(r => {
      const isGuest = guestIds.has(r.id) ||
                      (r.category && r.category.toLowerCase().includes('visitor')) ||
                      (r.category && r.category.toLowerCase().includes('guest')) ||
                      (r.role && r.role.toLowerCase().includes('visitor')) ||
                      (r.role && r.role.toLowerCase().includes('first timer'));
      return {
        ...r,
        isGuest: Boolean(isGuest),
        category: isGuest ? (r.category || 'Visitor / Guest') : (r.category || 'Adult'),
        role: isGuest ? (r.role || 'Visitor / First Timer') : (r.role || 'Member')
      };
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'REGISTRATION'), async (req, res, next) => {
  try {
    const b = memberSchema.parse(req.body);
    const normPhone = normalizePhone(b.phone);

    const m = await prisma.member.create({
      data: {
        firstName: b.firstName.trim(),
        lastName: b.lastName.trim(),
        email: b.email ? b.email.trim().toLowerCase() : null,
        phone: normPhone || b.phone?.trim() || null,
        gender: b.gender ? b.gender.trim() : null,
        address: b.address ? b.address.trim() : null,
        category: b.category ? b.category.trim() : 'Adult',
        role: b.role ? b.role.trim() : 'Member',
        guardian: b.guardian ? b.guardian.trim() : null,
        dateOfBirth: parseOptionalDate(b.dateOfBirth),
        anniversary: parseOptionalDate(b.anniversary),
        householdId: b.householdId || null
      }
    });

    // Audit Log
    try {
      await prisma.auditLog.create({
        data: {
          actorId: req.user?.userId || null,
          action: 'CREATE_MEMBER',
          entity: 'MEMBER',
          entityId: m.id,
          metadata: { name: `${m.firstName} ${m.lastName}`, category: m.category, role: m.role }
        }
      });
    } catch (e) {}

    res.status(201).json(m);
  } catch (e) {
    next(e);
  }
});

router.put('/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'REGISTRATION'), async (req, res, next) => {
  try {
    const b = memberSchema.partial().parse(req.body);
    const data = {};
    if (b.firstName !== undefined) data.firstName = b.firstName.trim();
    if (b.lastName !== undefined) data.lastName = b.lastName.trim();
    if (b.email !== undefined) data.email = b.email ? b.email.trim().toLowerCase() : null;
    if (b.phone !== undefined) data.phone = normalizePhone(b.phone) || b.phone?.trim() || null;
    if (b.gender !== undefined) data.gender = b.gender ? b.gender.trim() : null;
    if (b.address !== undefined) data.address = b.address ? b.address.trim() : null;
    if (b.category !== undefined) data.category = b.category ? b.category.trim() : 'Adult';
    if (b.role !== undefined) data.role = b.role ? b.role.trim() : 'Member';
    if (b.guardian !== undefined) data.guardian = b.guardian ? b.guardian.trim() : null;
    if (b.dateOfBirth !== undefined) data.dateOfBirth = parseOptionalDate(b.dateOfBirth);
    if (b.anniversary !== undefined) data.anniversary = parseOptionalDate(b.anniversary);
    if (b.householdId !== undefined) data.householdId = b.householdId || null;

    const m = await prisma.member.update({
      where: { id: req.params.id },
      data
    });

    // Audit Log
    try {
      await prisma.auditLog.create({
        data: {
          actorId: req.user?.userId || null,
          action: 'UPDATE_MEMBER',
          entity: 'MEMBER',
          entityId: m.id,
          metadata: { name: `${m.firstName} ${m.lastName}` }
        }
      });
    } catch (e) {}

    res.json(m);
  } catch (e) {
    next(e);
  }
});

// Soft Delete to safeguard historical attendance and reporting data
router.delete('/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const member = await prisma.member.findUnique({ where: { id: req.params.id } });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    await prisma.member.update({
      where: { id: req.params.id },
      data: { active: false, deletedAt: new Date() }
    });

    // Audit Log
    try {
      await prisma.auditLog.create({
        data: {
          actorId: req.user?.userId || null,
          action: 'DELETE_MEMBER',
          entity: 'MEMBER',
          entityId: req.params.id,
          metadata: { deletedName: `${member.firstName} ${member.lastName}` }
        }
      });
    } catch (e) {}

    res.json({ success: true, message: 'Member archived successfully (historical attendance preserved)' });
  } catch (e) {
    next(e);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const m = await prisma.member.findUnique({
      where: { id: req.params.id },
      include: { household: true, attendance: { take: 20, orderBy: { checkedInAt: 'desc' } } }
    });
    if (!m) return res.status(404).json({ error: 'Member not found' });
    res.json(m);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
