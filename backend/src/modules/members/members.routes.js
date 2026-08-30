const router = require('express').Router();
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { requireAuth, requireRoles } = require('../../middleware/auth');

const memberSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().optional(),
  dateOfBirth: z.string().optional(),
  anniversary: z.string().optional(),
  householdId: z.string().optional()
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const where = { active: true, deletedAt: null };
    if (q) {
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } }
      ];
    }
    const rows = await prisma.member.findMany({
      where,
      take: 200,
      orderBy: { createdAt: 'desc' }
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'REGISTRATION'), async (req, res, next) => {
  try {
    const b = memberSchema.parse(req.body);
    const m = await prisma.member.create({
      data: {
        firstName: b.firstName.trim(),
        lastName: b.lastName.trim(),
        email: b.email ? b.email.trim().toLowerCase() : null,
        phone: b.phone ? b.phone.trim() : null,
        gender: b.gender ? b.gender.trim() : null,
        address: b.address ? b.address.trim() : null,
        householdId: b.householdId || null
      }
    });
    res.status(201).json(m);
  } catch (e) {
    next(e);
  }
});

router.put('/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'REGISTRATION'), async (req, res, next) => {
  try {
    const b = memberSchema.partial().parse(req.body);
    const m = await prisma.member.update({
      where: { id: req.params.id },
      data: {
        ...(b.firstName ? { firstName: b.firstName.trim() } : {}),
        ...(b.lastName ? { lastName: b.lastName.trim() } : {}),
        ...(b.email !== undefined ? { email: b.email ? b.email.trim().toLowerCase() : null } : {}),
        ...(b.phone !== undefined ? { phone: b.phone ? b.phone.trim() : null } : {}),
        ...(b.gender !== undefined ? { gender: b.gender ? b.gender.trim() : null } : {}),
        ...(b.address !== undefined ? { address: b.address ? b.address.trim() : null } : {})
      }
    });
    res.json(m);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    await prisma.attendance.deleteMany({ where: { memberId: req.params.id } });
    await prisma.member.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Member deleted' });
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
