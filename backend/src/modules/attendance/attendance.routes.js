const router = require('express').Router();
const prisma = require('../../config/prisma');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { requireAuth, requireRoles } = require('../../middleware/auth');
const { normalizePhone } = require('../../utils/phone');

router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const normalized = normalizePhone(q);
    const searchConditions = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } }
    ];
    if (normalized && normalized !== q) {
      searchConditions.push({ phone: { contains: normalized } });
    }

    const rows = await prisma.member.findMany({
      where: {
        active: true,
        deletedAt: null,
        OR: searchConditions
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        gender: true,
        address: true,
        category: true,
        role: true,
        guardian: true,
        dateOfBirth: true,
        email: true,
        photoUrl: true,
        householdId: true
      },
      take: 20
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/checkin', async (req, res, next) => {
  try {
    const b = z.object({
      memberId: z.string().optional(),
      phone: z.string().optional(),
      serviceId: z.string().optional(),
      serviceName: z.string().optional(),
      method: z.enum(['KIOSK', 'QR_CODE', 'FAMILY', 'MANUAL', 'MOBILE']).default('KIOSK')
    }).parse(req.body);

    const normPhone = normalizePhone(b.phone);

    const result = await prisma.$transaction(async (tx) => {
      let member = null;
      if (b.memberId) {
        member = await tx.member.findFirst({ where: { id: b.memberId, active: true, deletedAt: null } });
      }
      if (!member && (normPhone || b.phone)) {
        const phoneQueries = [];
        if (normPhone) phoneQueries.push({ phone: normPhone });
        if (b.phone && b.phone !== normPhone) phoneQueries.push({ phone: b.phone });
        member = await tx.member.findFirst({
          where: { active: true, deletedAt: null, OR: phoneQueries }
        });
      }
      if (!member) {
        const e = new Error('Member not found or inactive');
        e.status = 404;
        throw e;
      }

      // Resolve targetServiceId
      let targetServiceId = b.serviceId;
      if (!targetServiceId) {
        let matched = null;
        if (b.serviceName) {
          const prefix = b.serviceName.split(':')[0].trim();
          matched = await tx.service.findFirst({
            where: { serviceType: { name: { contains: prefix, mode: 'insensitive' } }, active: true },
            orderBy: { startsAt: 'desc' }
          });
        }
        if (!matched) {
          matched = await tx.service.findFirst({ where: { active: true }, orderBy: { startsAt: 'desc' } });
        }
        if (matched) targetServiceId = matched.id;
      }

      if (!targetServiceId) {
        let svcType = await tx.serviceType.findFirst({ where: { active: true } });
        if (!svcType) {
          svcType = await tx.serviceType.create({
            data: { name: 'Family & Friends Service (Sunday)', dayOfWeek: 0, startTime: '07:00', endTime: '11:00' }
          });
        }
        const newSvc = await tx.service.create({
          data: { serviceTypeId: svcType.id, serviceDate: new Date(), startsAt: new Date(), active: true }
        });
        targetServiceId = newSvc.id;
      }

      const existing = await tx.attendance.findUnique({
        where: { memberId_serviceId: { memberId: member.id, serviceId: targetServiceId } }
      });
      if (existing) {
        return { attendance: existing, member, alreadyCheckedIn: true };
      }

      const attendance = await tx.attendance.create({
        data: { memberId: member.id, serviceId: targetServiceId, method: b.method }
      });
      return { attendance, member, alreadyCheckedIn: false };
    });

    res.status(200).json({ success: true, attendance: result.attendance, member: result.member, alreadyCheckedIn: result.alreadyCheckedIn });
  } catch (e) {
    next(e);
  }
});

router.post('/family-checkin', async (req, res, next) => {
  try {
    const b = z.object({ householdId: z.string(), memberIds: z.array(z.string()).min(1), serviceId: z.string() }).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const members = await tx.member.findMany({ where: { id: { in: b.memberIds }, householdId: b.householdId, active: true, deletedAt: null } });
      const valid = new Set(members.map(m => m.id));
      const created = [];
      for (const id of b.memberIds) {
        if (!valid.has(id)) continue;
        const exists = await tx.attendance.findUnique({ where: { memberId_serviceId: { memberId: id, serviceId: b.serviceId } } });
        if (!exists) created.push(await tx.attendance.create({ data: { memberId: id, serviceId: b.serviceId, method: 'FAMILY' } }));
      }
      return created;
    });
    res.status(201).json({ success: true, checkedInCount: result.length, members: result });
  } catch (e) { next(e); }
});

router.get('/live-count/:serviceId', async (req, res, next) => {
  try {
    const attendees = await prisma.attendance.findMany({
      where: { serviceId: req.params.serviceId },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            gender: true,
            address: true,
            category: true,
            role: true,
            guardian: true,
            createdAt: true
          }
        }
      },
      orderBy: { checkedInAt: 'desc' }
    });

    const count = attendees.length;
    let maleCount = 0;
    let femaleCount = 0;

    const memberIds = attendees.map(a => a.memberId);
    const guestLogs = await prisma.auditLog.findMany({
      where: {
        action: 'VISITOR_REGISTRATION',
        entityId: { in: memberIds }
      }
    });
    const guestIds = new Set(guestLogs.map(l => l.entityId));

    attendees.forEach(a => {
      const g = (a.member?.gender || '').toUpperCase();
      if (g.startsWith('M')) maleCount++;
      else if (g.startsWith('F')) femaleCount++;
    });

    // Check if requester is an authenticated administrator
    let isAdmin = false;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_ACCESS_SECRET || 'church_mgmt_secret_dev_fallback_only');
        if (decoded.role === 'SUPER_ADMIN' || decoded.role === 'ADMIN') {
          isAdmin = true;
        }
      } catch (e) {}
    }

    const sanitizedRecent = attendees.slice(0, 100).map(a => {
      const isGuest = guestIds.has(a.memberId);
      if (isAdmin) {
        return {
          id: a.id,
          memberId: a.memberId,
          serviceId: a.serviceId,
          method: a.method,
          checkedInAt: a.checkedInAt,
          isGuest,
          member: a.member
        };
      }
      // Public / Kiosk sanitized view (no home address, masked phone)
      return {
        id: a.id,
        method: a.method,
        checkedInAt: a.checkedInAt,
        isGuest,
        member: {
          firstName: a.member?.firstName || '',
          lastName: a.member?.lastName ? `${a.member.lastName.charAt(0)}.` : '',
          gender: a.member?.gender || ''
        }
      };
    });

    const last = sanitizedRecent[0] || null;

    res.json({
      count,
      maleCount,
      femaleCount,
      otherCount: count - (maleCount + femaleCount),
      malePct: count > 0 ? Math.round((maleCount / count) * 100) : 0,
      femalePct: count > 0 ? Math.round((femaleCount / count) * 100) : 0,
      lastCheckedIn: last,
      recent: sanitizedRecent
    });
  } catch (e) { next(e); }
});

router.get('/service-types', async (req, res, next) => {
  try {
    const types = await prisma.serviceType.findMany({ where: { active: true }, orderBy: { dayOfWeek: 'asc' } });
    res.json(types);
  } catch (e) { next(e); }
});

router.post('/services', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const b = z.object({
      serviceTypeId: z.string(),
      serviceDate: z.string(),
      startsAt: z.string(),
      endsAt: z.string().optional()
    }).parse(req.body);

    const s = await prisma.service.create({
      data: {
        serviceTypeId: b.serviceTypeId,
        serviceDate: new Date(b.serviceDate),
        startsAt: new Date(b.startsAt),
        endsAt: b.endsAt ? new Date(b.endsAt) : null,
        active: true
      },
      include: { serviceType: true }
    });
    res.status(201).json(s);
  } catch (e) { next(e); }
});

router.get('/services/current', async (req, res, next) => {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    let service = await prisma.service.findFirst({
      where: {
        active: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }]
      },
      include: { serviceType: true },
      orderBy: { startsAt: 'desc' }
    });

    if (!service) {
      service = await prisma.service.findFirst({
        where: {
          serviceDate: { gte: start, lte: end },
          active: true
        },
        include: { serviceType: true },
        orderBy: { startsAt: 'desc' }
      });
    }

    if (!service) {
      const todayDay = now.getDay();
      let serviceType = await prisma.serviceType.findFirst({ where: { dayOfWeek: todayDay, active: true } });
      if (!serviceType) {
        serviceType = await prisma.serviceType.findFirst({ where: { active: true }, orderBy: { dayOfWeek: 'asc' } });
      }

      if (serviceType) {
        const startsAt = new Date(start);
        const [h, m] = (serviceType.startTime || '10:00').split(':').map(Number);
        startsAt.setHours(h || 10, m || 0, 0, 0);

        service = await prisma.service.upsert({
          where: {
            serviceTypeId_serviceDate: {
              serviceTypeId: serviceType.id,
              serviceDate: start
            }
          },
          update: { active: true },
          create: {
            serviceTypeId: serviceType.id,
            serviceDate: start,
            startsAt,
            active: true
          },
          include: { serviceType: true }
        });
      } else {
        service = await prisma.service.findFirst({
          where: { active: true },
          include: { serviceType: true },
          orderBy: { startsAt: 'desc' }
        });
      }
    }

    res.json(service);
  } catch (e) { next(e); }
});

router.post('/quick-register-checkin', async (req, res, next) => {
  try {
    const body = z.object({
      firstName: z.string().min(1, 'First name is required'),
      lastName: z.string().min(1, 'Last name is required'),
      category: z.string().optional(),
      guardian: z.string().optional(),
      phone: z.string().optional(),
      gender: z.string().optional(),
      address: z.string().optional(),
      email: z.string().email().optional().or(z.literal('')),
      serviceId: z.string().optional(),
      serviceName: z.string().optional()
    }).parse(req.body);

    const normPhone = normalizePhone(body.phone);

    const result = await prisma.$transaction(async (tx) => {
      let member = null;
      if (normPhone || body.phone) {
        const phoneQueries = [];
        if (normPhone) phoneQueries.push({ phone: normPhone });
        if (body.phone && body.phone !== normPhone) phoneQueries.push({ phone: body.phone });
        member = await tx.member.findFirst({ where: { active: true, deletedAt: null, OR: phoneQueries } });
      }
      if (!member) {
        member = await tx.member.create({
          data: {
            firstName: body.firstName.trim(),
            lastName: body.lastName.trim(),
            phone: normPhone || body.phone?.trim() || null,
            gender: body.gender?.trim() || null,
            address: body.address?.trim() || null,
            category: body.category || 'Visitor / Guest',
            role: 'Visitor / First Timer',
            guardian: body.guardian?.trim() || null,
            email: body.email?.trim() || null
          }
        });
      } else {
        member = await tx.member.update({
          where: { id: member.id },
          data: {
            firstName: body.firstName.trim(),
            lastName: body.lastName.trim(),
            gender: body.gender?.trim() || member.gender,
            address: body.address?.trim() || member.address,
            email: body.email?.trim() || member.email,
            guardian: body.guardian?.trim() || member.guardian
          }
        });
      }

      // Resolve Service ID
      let targetServiceId = body.serviceId;
      if (!targetServiceId) {
        let matchedService = null;
        if (body.serviceName) {
          matchedService = await tx.service.findFirst({
            where: { serviceType: { name: { contains: body.serviceName.split(':')[0], mode: 'insensitive' } }, active: true },
            orderBy: { startsAt: 'desc' }
          });
        }
        if (!matchedService) {
          matchedService = await tx.service.findFirst({ where: { active: true }, orderBy: { startsAt: 'desc' } });
        }
        if (matchedService) {
          targetServiceId = matchedService.id;
        }
      }

      if (!targetServiceId) {
        const anyService = await tx.service.findFirst({ where: { active: true } });
        if (anyService) targetServiceId = anyService.id;
      }

      let attendance = null;
      if (targetServiceId) {
        attendance = await tx.attendance.findUnique({
          where: { memberId_serviceId: { memberId: member.id, serviceId: targetServiceId } }
        });

        if (!attendance) {
          attendance = await tx.attendance.create({
            data: {
              memberId: member.id,
              serviceId: targetServiceId,
              method: 'KIOSK'
            }
          });

          await tx.auditLog.create({
            data: {
              action: 'VISITOR_REGISTRATION',
              entity: 'MEMBER',
              entityId: member.id,
              metadata: {
                category: body.category || 'Visitor',
                guardian: body.guardian || null,
                isGuest: true,
                serviceName: body.serviceName || null
              }
            }
          });
        }
      }

      return { member, attendance, alreadyCheckedIn: !!attendance && attendance.createdAt < new Date(Date.now() - 5000) };
    });

    res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
