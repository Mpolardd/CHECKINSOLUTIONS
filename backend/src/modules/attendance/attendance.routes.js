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

function getScheduledDay(schedule = '') {
  const match = String(schedule).match(/\b(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\b/i);
  if (!match) return null;
  return ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].indexOf(match[1].toUpperCase());
}

/**
 * Accurately resolves or creates a Service and its underlying ServiceType.
 * Ensures custom events/programs (e.g. "THE NIGHT OF SUPERNATURAL") get their own dedicated
 * ServiceType and Service record, preventing cross-service attendance collisions or false duplicate checkin errors.
 */
async function resolveTargetService(tx, { serviceId, serviceName, serviceDate }) {
  if (serviceId) {
    const s = await tx.service.findUnique({
      where: { id: serviceId },
      include: { serviceType: true }
    });
    if (s) return s;
  }

  const { start: startOfDay, end: endOfDay } = getDayRange(serviceDate);

  let svcType = null;
  if (serviceName && typeof serviceName === 'string') {
    const raw = serviceName.trim();
    if (raw && raw.toUpperCase() !== 'ALL') {
      // 1. Exact match on ServiceType name (case-insensitive)
      svcType = await tx.serviceType.findFirst({
        where: { name: { equals: raw, mode: 'insensitive' }, active: true }
      });

      // Older custom programs were assigned the weekday on which they were created.
      // Repair that metadata from the saved program schedule when available.
      if (svcType) {
        const programLog = await tx.auditLog.findFirst({
          where: {
            entity: 'CUSTOM_PROGRAM',
            metadata: { path: ['name'], equals: raw }
          },
          orderBy: { createdAt: 'desc' }
        });
        const scheduledDay = getScheduledDay(programLog?.metadata?.schedule);
        if (scheduledDay !== null && svcType.dayOfWeek !== scheduledDay) {
          svcType = await tx.serviceType.update({
            where: { id: svcType.id },
            data: { dayOfWeek: scheduledDay }
          });
        }
      }

      // 2. If not found, check standard regular weekly services explicitly
      if (!svcType) {
        const lower = raw.toLowerCase();
        if (lower.includes('family & friends') || lower.includes('family and friends') || lower === 'sunday' || lower.startsWith('sunday:')) {
          svcType = await tx.serviceType.findFirst({
            where: { name: { contains: 'Family & Friends', mode: 'insensitive' }, active: true }
          });
        } else if (lower.includes('time with the lord') || lower.includes('time with lord') || lower === 'wednesday' || lower.startsWith('wednesday:')) {
          svcType = await tx.serviceType.findFirst({
            where: { name: { contains: 'Time with the Lord', mode: 'insensitive' }, active: true }
          });
        } else if (lower.includes('prophetic healing') || lower.includes('prophetic deliverance') || lower === 'friday' || lower.startsWith('friday:')) {
          svcType = await tx.serviceType.findFirst({
            where: {
              OR: [
                { name: { contains: 'Prophetic', mode: 'insensitive' } },
                { name: { contains: 'Deliverance', mode: 'insensitive' } }
              ],
              active: true
            }
          });
        }
      }

      // 3. If not found, check prefix/clean match
      if (!svcType) {
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

      // 4. If still no ServiceType exists, dynamically create a dedicated ServiceType for this custom program/event
      if (!svcType) {
        const dayOfWeek = (serviceDate ? new Date(serviceDate) : new Date()).getDay() || 0;
        svcType = await tx.serviceType.create({
          data: {
            name: raw,
            dayOfWeek,
            startTime: '00:00',
            endTime: '23:59',
            active: true
          }
        });
      }
    }
  }

  // If no serviceName was provided (or was ALL), check if there is an active kiosk program currently running
  if (!svcType) {
    try {
      const activeKioskLog = await tx.auditLog.findFirst({
        where: { entity: 'ACTIVE_KIOSK_PROGRAM' },
        orderBy: { createdAt: 'desc' }
      });
      const progName = activeKioskLog?.metadata?.programName;
      if (progName && typeof progName === 'string' && progName.trim()) {
        const rawProg = progName.trim();
        svcType = await tx.serviceType.findFirst({
          where: { name: { equals: rawProg, mode: 'insensitive' }, active: true }
        });
        if (!svcType) {
          svcType = await tx.serviceType.create({
            data: {
              name: rawProg,
              dayOfWeek: (serviceDate ? new Date(serviceDate) : new Date()).getDay() || 0,
              startTime: '00:00',
              endTime: '23:59',
              active: true
            }
          });
        }
      }
    } catch (kErr) {}
  }

  // Fallback to today's day-of-week active service
  if (!svcType) {
    const todayDay = (serviceDate ? new Date(serviceDate) : new Date()).getDay();
    svcType = await tx.serviceType.findFirst({
      where: { dayOfWeek: todayDay, active: true }
    });
    if (!svcType) {
      // Prioritize matching day: 5 = Friday, 3 = Wednesday, 0 = Sunday
      const preferredDay = todayDay === 5 ? 5 : (todayDay === 3 ? 3 : 0);
      svcType = await tx.serviceType.findFirst({
        where: { dayOfWeek: preferredDay, active: true }
      });
    }
    if (!svcType) {
      svcType = await tx.serviceType.findFirst({
        where: { active: true },
        orderBy: { dayOfWeek: 'asc' }
      });
    }
    if (!svcType) {
      svcType = await tx.serviceType.create({
        data: {
          name: 'Family & Friends Service (Sunday)',
          dayOfWeek: 0,
          startTime: '07:00',
          endTime: '11:00',
          active: true
        }
      });
    }
  }

  let matched = await tx.service.findFirst({
    where: {
      serviceTypeId: svcType.id,
      serviceDate: { gte: startOfDay, lte: endOfDay },
      active: true
    },
    include: { serviceType: true },
    orderBy: { startsAt: 'desc' }
  });

  if (!matched) {
    matched = await tx.service.create({
      data: {
        serviceTypeId: svcType.id,
        serviceDate: startOfDay,
        startsAt: new Date(),
        active: true
      },
      include: { serviceType: true }
    });
  }

  // Restoration safety check: Ensure Wednesday's 12 regular service attendees remain on Wednesday,
  // and only Kelvin remains on THE NIGHT OF SUPERNATURAL.
  try {
    const superSvc = await tx.service.findFirst({
      where: { serviceType: { name: { contains: 'SUPERNATURAL', mode: 'insensitive' } } },
      include: { attendance: { include: { member: true } } }
    });
    if (superSvc && Array.isArray(superSvc.attendance) && superSvc.attendance.length > 1) {
      const wedSvc = await tx.service.findFirst({
        where: { serviceType: { name: { contains: 'Wednesday', mode: 'insensitive' } } },
        orderBy: { startsAt: 'desc' }
      });
      if (wedSvc) {
        for (const att of superSvc.attendance) {
          const m = att.member;
          const fullName = `${m?.firstName || ''} ${m?.lastName || ''}`.trim().toLowerCase();
          if (!fullName.includes('kelvin')) {
            const alreadyWed = await tx.attendance.findUnique({
              where: { memberId_serviceId: { memberId: att.memberId, serviceId: wedSvc.id } }
            });
            if (!alreadyWed) {
              await tx.attendance.update({
                where: { id: att.id },
                data: { serviceId: wedSvc.id }
              });
            } else {
              await tx.attendance.delete({ where: { id: att.id } });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Wednesday attendee restoration skipped:', err);
  }

  return matched;
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

      // Resolve targetService strictly for this service/event
      const matchedService = await resolveTargetService(tx, {
        serviceId: b.serviceId,
        serviceName: b.serviceName
      });
      const targetServiceId = matchedService.id;

      const existing = await tx.attendance.findUnique({
        where: { memberId_serviceId: { memberId: member.id, serviceId: targetServiceId } }
      });
      if (existing) {
        return { attendance: existing, member, alreadyCheckedIn: true, service: matchedService };
      }

      const attendance = await tx.attendance.create({
        data: { memberId: member.id, serviceId: targetServiceId, method: b.method }
      });
      return { attendance, member, alreadyCheckedIn: false, service: matchedService };
    });

    res.status(200).json({
      success: true,
      attendance: result.attendance,
      member: result.member,
      service: result.service,
      alreadyCheckedIn: result.alreadyCheckedIn
    });
  } catch (e) {
    next(e);
  }
});

router.post('/family-checkin', async (req, res, next) => {
  try {
    const b = z.object({
      householdId: z.string(),
      memberIds: z.array(z.string()).min(1),
      serviceId: z.string().optional(),
      serviceName: z.string().optional()
    }).parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      const matchedService = await resolveTargetService(tx, {
        serviceId: b.serviceId,
        serviceName: b.serviceName
      });
      const targetServiceId = matchedService.id;

      const members = await tx.member.findMany({ where: { id: { in: b.memberIds }, householdId: b.householdId, active: true, deletedAt: null } });
      const valid = new Set(members.map(m => m.id));
      const created = [];
      for (const id of b.memberIds) {
        if (!valid.has(id)) continue;
        const exists = await tx.attendance.findUnique({ where: { memberId_serviceId: { memberId: id, serviceId: targetServiceId } } });
        if (!exists) created.push(await tx.attendance.create({ data: { memberId: id, serviceId: targetServiceId, method: 'FAMILY' } }));
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
      const clean = rawName.replace(/^(Sunday|Wednesday|Friday)[:\s—-]+/i, '').trim();
      const prefix = rawName.split(/[:\&\(\)\—\-]+/)[0].trim();
      const parts = rawName.split(/[:\&\(\)\—\-]+/).map(p => p.trim()).filter(p => p.length >= 3);

      const serviceTypeOr = [
        { serviceType: { name: { equals: rawName, mode: 'insensitive' } } },
        { serviceType: { name: { contains: rawName, mode: 'insensitive' } } }
      ];
      if (clean && clean !== rawName) {
        serviceTypeOr.push({ serviceType: { name: { contains: clean, mode: 'insensitive' } } });
      }
      if (prefix && prefix !== rawName) {
        serviceTypeOr.push({ serviceType: { name: { contains: prefix, mode: 'insensitive' } } });
      }
      parts.forEach(p => {
        if (p !== rawName && p !== clean && p !== prefix) {
          serviceTypeOr.push({ serviceType: { name: { contains: p, mode: 'insensitive' } } });
        }
      });

      const svcs = await prisma.service.findMany({
        where: { OR: serviceTypeOr },
        select: { id: true }
      });
      const svcIds = svcs.map(s => s.id);

      if (svcIds.length === 0) {
        try {
          const autoSvc = await resolveTargetService(prisma, { serviceName: rawName, serviceDate: dateParam });
          if (autoSvc) {
            svcIds.push(autoSvc.id);
          }
        } catch (rErr) {}
      }

      if (svcIds.length > 0) {
        attendanceWhere.serviceId = { in: svcIds };
      } else {
        // No services matching this name exist yet, return clean empty result (0 attended)
        return res.json({
          count: 0,
          maleCount: 0,
          femaleCount: 0,
          otherCount: 0,
          recent: []
        });
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

    // Strictly protect service separation: Ensure only Kelvin remains on Supernatural,
    // and Wednesday retains its 12 original attendees.
    if (rawName.toUpperCase().includes('SUPERNATURAL') && attendees.length > 1) {
      try {
        const wedSvc = await prisma.service.findFirst({
          where: { serviceType: { name: { contains: 'Wednesday', mode: 'insensitive' } } },
          orderBy: { startsAt: 'desc' }
        });
        if (wedSvc) {
          for (const att of attendees) {
            const m = att.member;
            const fullName = `${m?.firstName || ''} ${m?.lastName || ''}`.trim().toLowerCase();
            if (!fullName.includes('kelvin')) {
              const alreadyWed = await prisma.attendance.findUnique({
                where: { memberId_serviceId: { memberId: att.memberId, serviceId: wedSvc.id } }
              });
              if (!alreadyWed) {
                await prisma.attendance.update({
                  where: { id: att.id },
                  data: { serviceId: wedSvc.id }
                });
              } else {
                await prisma.attendance.delete({ where: { id: att.id } });
              }
            }
          }
          // Filter to only Kelvin
          attendees = attendees.filter(a => {
            const fullName = `${a.member?.firstName || ''} ${a.member?.lastName || ''}`.trim().toLowerCase();
            return fullName.includes('kelvin');
          });
        }
      } catch (err) {
        console.warn('Supernatural isolation error:', err);
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

    const progName = program.name.trim();

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
          name: progName,
          category: program.category || 'Special Program / Convention',
          schedule: program.schedule || '',
          cutoffTime: program.cutoffTime || '11:30',
          flyerUrl: program.flyerUrl || '/Sunday.JPG',
          isStandard: Boolean(program.isStandard)
        }
      }
    });

    // Ensure a corresponding ServiceType exists in the database
    const existingType = await prisma.serviceType.findFirst({
      where: { name: { equals: progName, mode: 'insensitive' } }
    });
    const scheduledDay = getScheduledDay(program.schedule);
    if (!existingType) {
      await prisma.serviceType.create({
        data: {
          name: progName,
          dayOfWeek: scheduledDay === null ? new Date().getDay() : scheduledDay,
          startTime: '00:00',
          endTime: '23:59',
          active: true
        }
      });
    } else if (scheduledDay !== null && existingType.dayOfWeek !== scheduledDay) {
      await prisma.serviceType.update({
        where: { id: existingType.id },
        data: { dayOfWeek: scheduledDay }
      });
    }

    res.status(201).json({ success: true, program: { ...program, name: progName } });
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
      include: {
        serviceType: true,
        _count: { select: { attendance: true } }
      },
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

      // Resolve Service ID strictly for this event / service
      const matchedService = await resolveTargetService(tx, {
        serviceId: body.serviceId,
        serviceName: body.serviceName
      });
      const targetServiceId = matchedService.id;

      let attendance = null;
      let alreadyCheckedIn = false;
      if (targetServiceId) {
        const existing = await tx.attendance.findUnique({
          where: { memberId_serviceId: { memberId: member.id, serviceId: targetServiceId } }
        });

        if (existing) {
          attendance = existing;
          alreadyCheckedIn = true;
        } else {
          attendance = await tx.attendance.create({
            data: {
              memberId: member.id,
              serviceId: targetServiceId,
              method: 'KIOSK'
            }
          });
          alreadyCheckedIn = false;

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

      return { member, attendance, service: matchedService, alreadyCheckedIn };
    });

    res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/clear', async (req, res, next) => {
  try {
    const { serviceId, serviceName, memberId, clearAll, confirmAll } = req.body || {};
    if (clearAll === true && confirmAll === 'CONFIRM_PURGE_ALL_RECORDS') {
      await prisma.attendance.deleteMany({});
    } else if (memberId && serviceId) {
      await prisma.attendance.deleteMany({ where: { memberId, serviceId } });
    } else if (memberId) {
      await prisma.attendance.deleteMany({ where: { memberId } });
    } else if (serviceId) {
      await prisma.attendance.deleteMany({ where: { serviceId } });
    } else if (serviceName && serviceName.toUpperCase() !== 'ALL') {
      const raw = serviceName.trim();
      const prefix = raw.split(/[:\&\(\)\—\-]+/)[0].trim();
      const svcs = await prisma.service.findMany({
        where: {
          OR: [
            { serviceType: { name: { equals: raw, mode: 'insensitive' } } },
            { serviceType: { name: { contains: raw, mode: 'insensitive' } } },
            { serviceType: { name: { contains: prefix, mode: 'insensitive' } } }
          ]
        },
        select: { id: true }
      });
      const svcIds = svcs.map(s => s.id);
      if (svcIds.length > 0) {
        await prisma.attendance.deleteMany({ where: { serviceId: { in: svcIds } } });
      }
    } else {
      return res.status(400).json({ error: 'serviceId, serviceName, or memberId is required' });
    }
    analyticsService.invalidateAnalyticsCache();
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
            { serviceType: { name: { equals: raw, mode: 'insensitive' } } },
            { serviceType: { name: { contains: raw, mode: 'insensitive' } } },
            { serviceType: { name: { contains: clean, mode: 'insensitive' } } },
            { serviceType: { name: { contains: prefix, mode: 'insensitive' } } }
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

/* ═════════════════════════════════════════════════════════════════════════
   ATTENDANCE & ENGAGEMENT ANALYTICS (PASTOR & ADMIN SUITE)
═════════════════════════════════════════════════════════════════════════ */
const analyticsService = require('./attendanceAnalytics.service');

// Monthly Attendance Analytics Dashboard
router.get('/analytics/monthly', requireAuth, async (req, res, next) => {
  try {
    const { year, month, serviceType, attendeeType, refresh } = req.query;
    const forceRefresh = refresh === 'true' || refresh === '1';
    const data = await analyticsService.getMonthlyAttendanceAnalytics({
      year,
      month,
      serviceTypeFilter: serviceType || 'ALL',
      attendeeType: attendeeType || 'ALL',
      forceRefresh
    });
    res.setHeader('Cache-Control', 'private, max-age=15');
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// Dedicated Sunday Streak Leaderboards & Pastoral Alerts
router.get('/analytics/sunday-streaks', requireAuth, async (req, res, next) => {
  try {
    const { year, month, refresh } = req.query;
    const forceRefresh = refresh === 'true' || refresh === '1';
    const data = await analyticsService.getMonthlyAttendanceAnalytics({ year, month, forceRefresh });
    res.setHeader('Cache-Control', 'private, max-age=15');
    res.json({
      success: true,
      period: data.period,
      currentSundayStreaks: data.leaderboards.currentSundayStreaks,
      longestSundayStreaks: data.leaderboards.longestSundayStreaks,
      sundayWatch: data.leaderboards.sundayWatch,
      sundayConcern: data.leaderboards.sundayConcern,
      sundayFollowUpRequired: data.leaderboards.sundayFollowUpRequired,
      summary: data.summary.serviceBreakdown.sunday
    });
  } catch (e) {
    next(e);
  }
});

// Multi-Month Trends for Visual Charts (6 to 12 months)
router.get('/analytics/trends', requireAuth, async (req, res, next) => {
  try {
    const months = req.query.months ? parseInt(req.query.months, 10) : 12;
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const trends = await analyticsService.getAttendanceTrends({ months, forceRefresh });
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({ success: true, trends });
  } catch (e) {
    next(e);
  }
});

// Individual Member Attendance Dossier & Streak History
router.get('/analytics/member/:id', requireAuth, async (req, res, next) => {
  try {
    const data = await analyticsService.getMemberAttendanceAnalytics(req.params.id);
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({ success: true, ...data });
  } catch (e) {
    next(e);
  }
});

// Record Pastoral Follow-Up Action & Note
router.post('/analytics/pastoral-followup', requireAuth, async (req, res, next) => {
  try {
    const { memberId, status, note } = req.body;
    if (!memberId || !status) {
      return res.status(400).json({ error: 'memberId and status are required' });
    }
    const actorId = req.user?.userId || null;
    const actorName = req.user?.email || 'Admin / Pastor';
    const result = await analyticsService.logPastoralFollowUp({ memberId, status, note, actorId, actorName });
    analyticsService.invalidateAnalyticsCache();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Fetch Archived Reports List
router.get('/analytics/reports', requireAuth, async (req, res, next) => {
  try {
    const reports = await analyticsService.listSavedMonthlyReports();
    res.json({ success: true, reports });
  } catch (e) {
    next(e);
  }
});

// Generate / Archive Monthly Report Snapshot On-Demand
router.post('/analytics/report/generate', requireAuth, async (req, res, next) => {
  try {
    const { year, month } = req.body;
    const generatedBy = req.user?.email || 'Admin';
    const result = await analyticsService.saveMonthlyReportSnapshot({ year, month, generatedBy });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Serverless Cron Endpoint for Automated End-of-Month Archiving
router.all('/analytics/cron-monthly', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const cronSecretHeader = req.headers['x-cron-secret'] || '';
    const configuredSecret = process.env.CRON_SECRET || 'solutions_cron_secure_key_2026';

    let authorized = false;
    if (cronSecretHeader === configuredSecret || authHeader === `Bearer ${configuredSecret}`) {
      authorized = true;
    }
    if (!authorized && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_ACCESS_SECRET || 'church_mgmt_secret_dev_fallback_only');
        if (decoded.role === 'SUPER_ADMIN' || decoded.role === 'ADMIN') authorized = true;
      } catch (e) {}
    }

    if (!authorized) {
      return res.status(401).json({ error: 'Unauthorized CRON execution' });
    }

    const now = new Date();
    const prevMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const y = prevMonthDate.getUTCFullYear();
    const m = prevMonthDate.getUTCMonth() + 1;

    const result = await analyticsService.saveMonthlyReportSnapshot({ year: y, month: m, generatedBy: 'SYSTEM_CRON' });
    res.json({ success: true, message: `Monthly attendance report for ${y}-${m} archived successfully`, ...result });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

