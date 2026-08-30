const router=require('express').Router();
const prisma=require('../../config/prisma');
const {z}=require('zod');
const {requireAuth,requireRoles}=require('../../middleware/auth');

router.get('/search', async(req,res,next)=>{
 try{
  const q=String(req.query.q||'').trim();
  if(q.length<2)return res.json([]);
  const rows=await prisma.member.findMany({
   where:{active:true,deletedAt:null,OR:[
    {firstName:{contains:q,mode:'insensitive'}},{lastName:{contains:q,mode:'insensitive'}},
    {phone:{contains:q}}
   ]},select:{id:true,firstName:true,lastName:true,phone:true,gender:true,address:true,dateOfBirth:true,email:true,photoUrl:true,householdId:true},take:20
  });
  res.json(rows);
 }catch(e){next(e)}
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

    const result = await prisma.$transaction(async (tx) => {
      let member = null;
      if (b.memberId) {
        member = await tx.member.findFirst({ where: { id: b.memberId, active: true, deletedAt: null } });
      }
      if (!member && b.phone) {
        member = await tx.member.findFirst({ where: { phone: b.phone, active: true, deletedAt: null } });
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

router.post('/family-checkin',async(req,res,next)=>{
 try{
  const b=z.object({householdId:z.string(),memberIds:z.array(z.string()).min(1),serviceId:z.string()}).parse(req.body);
  const result=await prisma.$transaction(async(tx)=>{
   const members=await tx.member.findMany({where:{id:{in:b.memberIds},householdId:b.householdId,active:true,deletedAt:null}});
   const valid=new Set(members.map(m=>m.id));
   const created=[];
   for(const id of b.memberIds){
    if(!valid.has(id)) continue;
    const exists=await tx.attendance.findUnique({where:{memberId_serviceId:{memberId:id,serviceId:b.serviceId}}});
    if(!exists) created.push(await tx.attendance.create({data:{memberId:id,serviceId:b.serviceId,method:'FAMILY'}}));
   }
   return created;
  });
  res.status(201).json({success:true,checkedInCount:result.length,members:result});
 }catch(e){next(e)}
});

router.get('/live-count/:serviceId', async (req, res, next) => {
  try {
    const attendees = await prisma.attendance.findMany({
      where: { serviceId: req.params.serviceId },
      include: { member: { select: { id: true, firstName: true, lastName: true, phone: true, gender: true } } },
      orderBy: { checkedInAt: 'desc' }
    });

    const count = attendees.length;
    let maleCount = 0;
    let femaleCount = 0;

    attendees.forEach(a => {
      const g = (a.member?.gender || '').toUpperCase();
      if (g.startsWith('M')) maleCount++;
      else if (g.startsWith('F')) femaleCount++;
    });

    const last = attendees[0] || null;
    const recent = attendees.slice(0, 50);

    res.json({
      count,
      maleCount,
      femaleCount,
      otherCount: count - (maleCount + femaleCount),
      malePct: count > 0 ? Math.round((maleCount / count) * 100) : 0,
      femalePct: count > 0 ? Math.round((femaleCount / count) * 100) : 0,
      lastCheckedIn: last,
      recent
    });
  } catch (e) { next(e); }
});

router.get('/service-types', async (req, res, next) => {
  try {
    const types = await prisma.serviceType.findMany({ where: { active: true }, orderBy: { dayOfWeek: 'asc' } });
    res.json(types);
  } catch (e) { next(e); }
});

router.get('/services', async (req, res, next) => {
  try {
    const services = await prisma.service.findMany({
      where: { active: true },
      include: { serviceType: true, _count: { select: { attendance: true } } },
      orderBy: { startsAt: 'desc' },
      take: 20
    });
    res.json(services);
  } catch (e) { next(e); }
});

router.get('/services/current', async (req, res, next) => {
  try {
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);

    let service = await prisma.service.findFirst({
      where: { serviceDate: { gte: start, lte: end }, active: true },
      include: { serviceType: true },
      orderBy: { startsAt: 'asc' }
    });

    if (!service) {
      // Find default service type matching today or fallback to any active service type
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
        // Fallback to most recent service in database
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

    const result = await prisma.$transaction(async (tx) => {
      // Find or create member
      let member = null;
      if (body.phone) {
        member = await tx.member.findFirst({ where: { phone: body.phone, active: true, deletedAt: null } });
      }
      if (!member) {
        member = await tx.member.create({
          data: {
            firstName: body.firstName.trim(),
            lastName: body.lastName.trim(),
            phone: body.phone?.trim() || null,
            gender: body.gender?.trim() || null,
            address: body.address?.trim() || null,
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
            email: body.email?.trim() || member.email
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
        }
      }

      return { member, attendance, alreadyCheckedIn: !!attendance && attendance.createdAt < new Date(Date.now() - 5000) };
    });

    res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;

