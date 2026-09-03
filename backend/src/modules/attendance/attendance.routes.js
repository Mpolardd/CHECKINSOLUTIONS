const router = require('express').Router();
const prisma = require('../../config/prisma');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { requireAuth, requireRoles } = require('../../middleware/auth');
const { normalizePhone } = require('../../utils/phone');

function getDayRange(dateInput) {
  let y, m, d;
  if (dateInput && typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
    [y, m, d] = dateInput.trim().split('-').map(Number);
    m = m - 1;
  } else {
    const dateObj = dateInput ? new Date(dateInput) : new Date();
    if (isNaN(dateObj.getTime())) {
      const now = new Date();
      y = now.getFullYear();
      m = now.getMonth();
      d = now.getDate();
    } else {
      y = dateObj.getFullYear();
      m = dateObj.getMonth();
      d = dateObj.getDate();
    }
  }
  const start = new Date(y, m, d, 0, 0, 0, 0);
  const end = new Date(y, m, d, 23, 59, 59, 999);
  return { start, end };
}

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

      // Resolve targetServiceId strictly for today's service date
      let targetServiceId = b.serviceId;
      if (!targetServiceId) {
        let matched = null;
        const { start: startOfDay, end: endOfDay } = getDayRange();

        if (b.serviceName) {
          const prefix = b.serviceName.split(':')[0].trim();
          matched = await tx.service.findFirst({
            where: {
              serviceType: { name: { contains: prefix, mode: 'insensitive' } },
              serviceDate: { gte: startOfDay, lte: endOfDay },
              active: true
            },
            orderBy: { startsAt: 'desc' }
          });
        }
        if (!matched) {
          matched = await tx.service.findFirst({
            where: {
              serviceDate: { gte: startOfDay, lte: endOfDay },
              active: true
            },
            orderBy: { startsAt: 'desc' }
          });
        }
        if (!matched) {
          // Find or create service type
          let svcType = null;
          if (b.serviceName) {
            const prefix = b.serviceName.split(':')[0].trim();
            svcType = await tx.serviceType.findFirst({
              where: { name: { contains: prefix, mode: 'insensitive' }, active: true }
            });
          }
          if (!svcType) {
            svcType = await tx.serviceType.findFirst({ where: { active: true } });
          }
          if (!svcType) {
            svcType = await tx.serviceType.create({
              data: { name: 'Family & Friends Service (Sunday)', dayOfWeek: 0, startTime: '07:00', endTime: '11:00' }
            });
          }

          matched = await tx.service.findFirst({
            where: {
              serviceTypeId: svcType.id,
              serviceDate: { gte: startOfDay, lte: endOfDay }
            }
          });

          if (!matched) {
            matched = await tx.service.create({
              data: {
                serviceTypeId: svcType.id,
                serviceDate: startOfDay,
                startsAt: new Date(),
                active: true
              }
            });
          }
        }
        targetServiceId = matched.id;
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
      where: {
        serviceId: req.params.serviceId,
        member: { active: true, deletedAt: null }
      },
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

router.get('/by-service-name', async (req, res, next) => {
  try {
    const rawName = String(req.query.name || '').trim();
    const dateParam = String(req.query.date || '').trim();

    const attendanceWhere = {
      member: { active: true, deletedAt: null }
    };

    if (dateParam) {
      const { start, end } = getDayRange(dateParam);
      // Generous buffer so client timezones (-14h to +14h) match the selected calendar date
      const expandedStart = new Date(start.getTime() - 14 * 3600 * 1000);
      const expandedEnd = new Date(end.getTime() + 14 * 3600 * 1000);
      attendanceWhere.checkedInAt = { gte: expandedStart, lte: expandedEnd };
    } else {
      // Default live view: Query the last 48 hours so live check-ins show up immediately across all timezones
      const cutoff = new Date(Date.now() - 48 * 3600 * 1000);
      attendanceWhere.checkedInAt = { gte: cutoff };
    }

    if (rawName && rawName.toUpperCase() !== 'ALL') {
      const parts = rawName.split(/[:\&\(\)\—\-]+/).map(p => p.trim()).filter(p => p.length >= 3);
      const serviceTypeOr = parts.map(p => ({
        serviceType: { name: { contains: p, mode: 'insensitive' } }
      }));
      serviceTypeOr.push({ serviceType: { name: { contains: rawName, mode: 'insensitive' } } });

      const svcs = await prisma.service.findMany({
        where: { OR: serviceTypeOr },
        select: { id: true }
      });
      const svcIds = svcs.map(s => s.id);

      if (svcIds.length > 0) {
        attendanceWhere.serviceId = { in: svcIds };
      }
    }

    let attendees = await prisma.attendance.findMany({
      where: attendanceWhere,
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
        },
        service: {
          select: {
            id: true,
            serviceDate: true,
            serviceType: {
              select: { name: true }
            }
          }
        }
      },
      orderBy: { checkedInAt: 'desc' },
      take: 1000
    });

    // If a specific service filter returned 0, fallback to all recent active check-ins so no attendee is hidden
    if (attendees.length === 0 && attendanceWhere.serviceId) {
      const fallbackWhere = { ...attendanceWhere };
      delete fallbackWhere.serviceId;
      const fallbackAttendees = await prisma.attendance.findMany({
        where: fallbackWhere,
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
          },
          service: {
            select: {
              id: true,
              serviceDate: true,
              serviceType: {
                select: { name: true }
              }
            }
          }
        },
        orderBy: { checkedInAt: 'desc' },
        take: 1000
      });
      if (fallbackAttendees.length > 0) {
        attendees = fallbackAttendees;
      }
    }

    const count = attendees.length;
    let maleCount = 0;
    let femaleCount = 0;

    const memberIds = attendees.map(a => a.memberId).filter(Boolean);
    let guestLogs = [];
    if (memberIds.length > 0) {
      try {
        guestLogs = await prisma.auditLog.findMany({
          where: {
            action: 'VISITOR_REGISTRATION',
            entityId: { in: memberIds }
          }
        });
      } catch (aErr) {}
    }
    const guestIds = new Set(guestLogs.map(l => l.entityId));

    attendees.forEach(a => {
      const g = (a.member?.gender || '').toUpperCase();
      if (g.startsWith('M')) maleCount++;
      else if (g.startsWith('F')) femaleCount++;
    });

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
      const mCat = (a.member?.category || '').toLowerCase();
      const mRole = (a.member?.role || '').toLowerCase();
      const isGuest = Boolean(
        guestIds.has(a.memberId) ||
        mCat.includes('visitor') || mCat.includes('guest') || mCat.includes('first timer') ||
        mRole.includes('visitor') || mRole.includes('first timer') || mRole.includes('guest')
      );
      if (isAdmin) {
        return {
          id: a.id,
          memberId: a.memberId,
          serviceId: a.serviceId,
          method: a.method,
          checkedInAt: a.checkedInAt,
          isGuest,
          member: {
            ...(a.member || {}),
            isGuest
          }
        };
      }
      return {
        id: a.id,
        method: a.method,
        checkedInAt: a.checkedInAt,
        isGuest,
        member: {
          firstName: a.member?.firstName || '',
          lastName: a.member?.lastName ? `${a.member.lastName.charAt(0)}.` : '',
          gender: a.member?.gender || '',
          isGuest
        }
      };
    });

    return res.json({
      count,
      maleCount,
      femaleCount,
      otherCount: count - (maleCount + femaleCount),
      recent: sanitizedRecent
    });
  } catch (e) {
    console.error('Unhandled by-service-name error:', e);
    return res.json({ count: 0, maleCount: 0, femaleCount: 0, otherCount: 0, recent: [] });
  }
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

router.get('/programs', async (req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { entity: 'CUSTOM_PROGRAM' },
      orderBy: { createdAt: 'desc' }
    });
    const programs = logs.map(l => ({
      id: l.entityId || l.id,
      ...(l.metadata || {})
    }));
    res.json(programs);
  } catch (e) { next(e); }
});

router.post('/programs', async (req, res, next) => {
  try {
    const program = req.body;
    if (!program || !program.id || !program.name) {
      return res.status(400).json({ error: 'id and name are required' });
    }

    // Upsert custom program in AuditLog storage
    await prisma.auditLog.deleteMany({
      where: { entity: 'CUSTOM_PROGRAM', entityId: program.id }
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user?.userId || null,
        action: 'SAVE_PROGRAM',
        entity: 'CUSTOM_PROGRAM',
        entityId: program.id,
        metadata: {
          name: program.name,
          category: program.category || 'Special Program / Convention',
          schedule: program.schedule || '',
          cutoffTime: program.cutoffTime || '11:30',
          flyerUrl: program.flyerUrl || '/Sunday.JPG',
          isStandard: Boolean(program.isStandard)
        }
      }
    });

    res.status(201).json({ success: true, program });
  } catch (e) { next(e); }
});

router.delete('/programs/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.auditLog.deleteMany({
      where: { entity: 'CUSTOM_PROGRAM', entityId: id }
    });
    res.json({ success: true, message: 'Program deleted' });
  } catch (e) { next(e); }
});

router.get('/active-kiosk', async (req, res, next) => {
  try {
    const log = await prisma.auditLog.findFirst({
      where: { entity: 'ACTIVE_KIOSK_PROGRAM' },
      orderBy: { createdAt: 'desc' }
    });
    const programName = log && log.metadata ? log.metadata.programName : null;
    res.json({ activeKiosk: programName });
  } catch (e) { next(e); }
});

router.post('/active-kiosk', async (req, res, next) => {
  try {
    const { programName } = req.body || {};
    await prisma.auditLog.deleteMany({
      where: { entity: 'ACTIVE_KIOSK_PROGRAM' }
    });
    if (programName) {
      await prisma.auditLog.create({
        data: {
          actorId: req.user?.userId || null,
          action: 'SET_ACTIVE_KIOSK',
          entity: 'ACTIVE_KIOSK_PROGRAM',
          metadata: { programName }
        }
      });
    }
    res.json({ success: true, activeKiosk: programName || null });
  } catch (e) { next(e); }
});

router.get('/services', async (req, res, next) => {
  try {
    const { serviceTypeId, date } = req.query;

    const where = { active: true };
    if (serviceTypeId) where.serviceTypeId = serviceTypeId;
    if (date) {
      const { start, end } = getDayRange(String(date));
      where.serviceDate = { gte: start, lte: end };
    }

    const services = await prisma.service.findMany({
      where,
      include: { serviceType: true },
      orderBy: [
        { serviceDate: 'desc' },
        { startsAt: 'desc' }
      ]
    });

    res.json(services);
  } catch (e) { next(e); }
});

router.get('/services/current', async (req, res, next) => {
  try {
    const now = new Date();
    const { start, end } = getDayRange();

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
      const visitorCategory = body.category
        ? (body.category.toLowerCase().includes('visitor') ? body.category : `Visitor (${body.category})`)
        : 'Visitor / Guest';

      if (!member) {
        member = await tx.member.create({
          data: {
            firstName: body.firstName.trim(),
            lastName: body.lastName.trim(),
            phone: normPhone || body.phone?.trim() || null,
            gender: body.gender?.trim() || null,
            address: body.address?.trim() || null,
            category: visitorCategory,
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
            guardian: body.guardian?.trim() || member.guardian,
            category: member.category || visitorCategory,
            role: member.role || 'Visitor / First Timer'
          }
        });
      }

      // Resolve Service ID strictly for today's active service
      let targetServiceId = body.serviceId;
      if (!targetServiceId) {
        let matched = null;
        const { start: startOfDay, end: endOfDay } = getDayRange();

        if (body.serviceName) {
          const raw = body.serviceName.trim();
          const clean = raw.replace(/^(Sunday|Wednesday|Friday)[:\s—-]+/i, '').trim();
          const prefix = raw.split(/[:\&\(\)\—\-]+/)[0].trim();

          matched = await tx.service.findFirst({
            where: {
              serviceType: {
                OR: [
                  { name: { contains: clean, mode: 'insensitive' } },
                  { name: { contains: prefix, mode: 'insensitive' } },
                  { name: { contains: raw, mode: 'insensitive' } }
                ]
              },
              serviceDate: { gte: startOfDay, lte: endOfDay },
              active: true
            },
            orderBy: { startsAt: 'desc' }
          });
        }
        if (!matched) {
          matched = await tx.service.findFirst({
            where: {
              serviceDate: { gte: startOfDay, lte: endOfDay },
              active: true
            },
            orderBy: { startsAt: 'desc' }
          });
        }
        if (!matched) {
          let svcType = null;
          if (body.serviceName) {
            const raw = body.serviceName.trim();
            const clean = raw.replace(/^(Sunday|Wednesday|Friday)[:\s—-]+/i, '').trim();
            const prefix = raw.split(/[:\&\(\)\—\-]+/)[0].trim();
            svcType = await tx.serviceType.findFirst({
              where: {
                OR: [
                  { name: { contains: clean, mode: 'insensitive' } },
                  { name: { contains: prefix, mode: 'insensitive' } },
                  { name: { contains: raw, mode: 'insensitive' } }
                ],
                active: true
              }
            });
          }
          if (!svcType) {
            svcType = await tx.serviceType.findFirst({ where: { active: true } });
          }
          if (!svcType) {
            svcType = await tx.serviceType.create({
              data: { name: 'Family & Friends Service (Sunday)', dayOfWeek: 0, startTime: '07:00', endTime: '11:00' }
            });
          }

          matched = await tx.service.findFirst({
            where: {
              serviceTypeId: svcType.id,
              serviceDate: { gte: startOfDay, lte: endOfDay }
            }
          });

          if (!matched) {
            matched = await tx.service.create({
              data: {
                serviceTypeId: svcType.id,
                serviceDate: startOfDay,
                startsAt: new Date(),
                active: true
              }
            });
          }
        }
        targetServiceId = matched.id;
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

router.post('/clear', async (req, res, next) => {
  try {
    const { serviceId, serviceName, clearAll } = req.body || {};
    if (clearAll) {
      await prisma.attendance.deleteMany({});
    } else if (serviceId) {
      await prisma.attendance.deleteMany({ where: { serviceId } });
    } else {
      const { start: startOfDay, end: endOfDay } = getDayRange();

      if (serviceName) {
        const prefix = serviceName.split(':')[0].trim();
        const svcs = await prisma.service.findMany({
          where: { serviceType: { name: { contains: prefix, mode: 'insensitive' } } },
          select: { id: true }
        });
        const svcIds = svcs.map(s => s.id);
        if (svcIds.length > 0) {
          await prisma.attendance.deleteMany({ where: { serviceId: { in: svcIds } } });
        }
        await prisma.attendance.deleteMany({
          where: { checkedInAt: { gte: startOfDay, lte: endOfDay } }
        });
      } else {
        await prisma.attendance.deleteMany({
          where: { checkedInAt: { gte: startOfDay, lte: endOfDay } }
        });
      }
    }
    res.json({ success: true, message: 'Attendance records cleared successfully' });
  } catch (e) { next(e); }
});

router.get('/history', async (req, res, next) => {
  try {
    const { startDate, endDate, serviceName, limit } = req.query;

    const where = {
      member: { active: true, deletedAt: null }
    };

    if (startDate || endDate) {
      where.checkedInAt = {};
      if (startDate) {
        const { start } = getDayRange(startDate);
        where.checkedInAt.gte = new Date(start.getTime() - 14 * 3600 * 1000);
      }
      if (endDate) {
        const { end } = getDayRange(endDate);
        where.checkedInAt.lte = new Date(end.getTime() + 14 * 3600 * 1000);
      }
    }

    if (serviceName && serviceName.toUpperCase() !== 'ALL') {
      const raw = serviceName.trim();
      const clean = raw.replace(/^(Sunday|Wednesday|Friday)[:\s—-]+/i, '').trim();
      const prefix = raw.split(/[:\&\(\)\—\-]+/)[0].trim();
      const svcs = await prisma.service.findMany({
        where: {
          OR: [
            { serviceType: { name: { contains: clean, mode: 'insensitive' } } },
            { serviceType: { name: { contains: prefix, mode: 'insensitive' } } },
            { serviceType: { name: { contains: raw, mode: 'insensitive' } } }
          ]
        },
        select: { id: true }
      });
      const svcIds = svcs.map(s => s.id);
      where.serviceId = { in: svcIds };
    }

    const take = limit ? Math.min(parseInt(limit, 10), 1000) : 500;

    const attendees = await prisma.attendance.findMany({
      where,
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
            guardian: true
          }
        },
        service: {
          select: {
            id: true,
            serviceDate: true,
            serviceType: {
              select: { name: true }
            }
          }
        }
      },
      orderBy: { checkedInAt: 'desc' },
      take
    });

    const memberIds = attendees.map(a => a.memberId).filter(Boolean);
    let guestLogs = [];
    if (memberIds.length > 0) {
      try {
        guestLogs = await prisma.auditLog.findMany({
          where: {
            action: 'VISITOR_REGISTRATION',
            entityId: { in: memberIds }
          },
          select: { entityId: true }
        });
      } catch (aErr) {}
    }
    const guestIdSet = new Set(guestLogs.map(g => g.entityId));

    const enriched = attendees.map(att => {
      const m = att.member || {};
      const cat = (m.category || '').toLowerCase();
      const role = (m.role || '').toLowerCase();
      const isGuest = Boolean(
        guestIdSet.has(att.memberId) ||
        cat.includes('visitor') || cat.includes('guest') || cat.includes('first-timer') || cat.includes('first timer') ||
        role.includes('visitor') || role.includes('guest') || role.includes('first-timer') || role.includes('first timer')
      );
      return {
        ...att,
        isGuest,
        member: {
          ...m,
          isGuest
        }
      };
    });

    res.json(enriched);
  } catch (e) { next(e); }
});

// Dedicated All-Services Visitors & First-Timers Directory Endpoint
router.get('/visitors', async (req, res, next) => {
  try {
    const { startDate, endDate, limit } = req.query;

    let guestLogs = [];
    try {
      guestLogs = await prisma.auditLog.findMany({
        where: { action: 'VISITOR_REGISTRATION' },
        select: { entityId: true, metadata: true, createdAt: true }
      });
    } catch (e) {}
    const guestIdSet = new Set(guestLogs.map(g => g.entityId).filter(Boolean));

    const visitorMembers = await prisma.member.findMany({
      where: {
        active: true,
        deletedAt: null,
        OR: [
          { id: { in: Array.from(guestIdSet) } },
          { category: { contains: 'Visitor', mode: 'insensitive' } },
          { category: { contains: 'Guest', mode: 'insensitive' } },
          { role: { contains: 'Visitor', mode: 'insensitive' } },
          { role: { contains: 'First Timer', mode: 'insensitive' } },
          { role: { contains: 'First-Timer', mode: 'insensitive' } }
        ]
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
        createdAt: true,
        photoUrl: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const visitorMemberIds = visitorMembers.map(m => m.id);
    const allVisitorIds = Array.from(new Set([...visitorMemberIds, ...Array.from(guestIdSet)]));

    const attWhere = {
      member: { active: true, deletedAt: null }
    };

    if (allVisitorIds.length > 0) {
      attWhere.memberId = { in: allVisitorIds };
    }

    if (startDate || endDate) {
      attWhere.checkedInAt = {};
      if (startDate) {
        const { start } = getDayRange(startDate);
        attWhere.checkedInAt.gte = new Date(start.getTime() - 14 * 3600 * 1000);
      }
      if (endDate) {
        const { end } = getDayRange(endDate);
        attWhere.checkedInAt.lte = new Date(end.getTime() + 14 * 3600 * 1000);
      }
    }

    const take = limit ? Math.min(parseInt(limit, 10), 1000) : 500;

    const attendances = await prisma.attendance.findMany({
      where: attWhere,
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
            photoUrl: true
          }
        },
        service: {
          select: {
            id: true,
            serviceDate: true,
            serviceType: {
              select: { name: true }
            }
          }
        }
      },
      orderBy: { checkedInAt: 'desc' },
      take
    });

    const summary = {
      totalRegisteredVisitors: visitorMembers.length,
      totalAttendanceCheckIns: attendances.length,
      sundayCount: attendances.filter(a => {
        const sName = (a.service?.serviceType?.name || '').toLowerCase();
        return sName.includes('sunday') || sName.includes('family') || sName.includes('friends');
      }).length,
      midweekCount: attendances.filter(a => {
        const sName = (a.service?.serviceType?.name || '').toLowerCase();
        return sName.includes('wednesday') || sName.includes('friday') || sName.includes('time with') || sName.includes('prophetic');
      }).length
    };

    res.json({
      success: true,
      summary,
      visitors: visitorMembers,
      attendances
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

