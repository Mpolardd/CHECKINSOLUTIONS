const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');

async function main() {
  const adminHash = await bcrypt.hash('Solutions12@26', 12);
  const financeHash = await bcrypt.hash('Money12@26', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@solutionsfaith.com' },
    update: {
      passwordHash: adminHash,
      role: 'SUPER_ADMIN'
    },
    create: {
      email: 'admin@solutionsfaith.com',
      passwordHash: adminHash,
      role: 'SUPER_ADMIN'
    }
  });

  const financeUser = await prisma.user.upsert({
    where: { email: 'finance@solutionsfaith.com' },
    update: {
      passwordHash: financeHash,
      role: 'FINANCE'
    },
    create: {
      email: 'finance@solutionsfaith.com',
      passwordHash: financeHash,
      role: 'FINANCE'
    }
  });

  const general = await prisma.financialAccount.upsert({
    where: { code: 'GENERAL' },
    update: {},
    create: { name: 'General Fund', code: 'GENERAL' }
  });

  await prisma.financialAccount.upsert({
    where: { code: 'TITHE' },
    update: {},
    create: { name: 'Tithe & Offering', code: 'TITHE' }
  });

  await prisma.financialAccount.upsert({
    where: { code: 'BUILDING' },
    update: {},
    create: { name: 'Building & Welfare Fund', code: 'BUILDING' }
  });

  // 1. Wednesday Service: TIME WITH THE LORD (6:00 PM - 8:00 PM)
  let wednesdayType = await prisma.serviceType.findFirst({ where: { name: { contains: 'Time with the Lord', mode: 'insensitive' } } });
  if (!wednesdayType) {
    wednesdayType = await prisma.serviceType.create({
      data: {
        name: 'Time with the Lord (Wednesday)',
        dayOfWeek: 3,
        startTime: '18:00',
        endTime: '20:00'
      }
    });
  }

  // 2. Friday Service: PROPHETIC HEALING & DELIVERANCE SERVICE (6:00 PM - 8:00 PM)
  let fridayType = await prisma.serviceType.findFirst({ where: { name: { contains: 'Prophetic Healing', mode: 'insensitive' } } });
  if (!fridayType) {
    fridayType = await prisma.serviceType.create({
      data: {
        name: 'Prophetic Healing & Deliverance Service (Friday)',
        dayOfWeek: 5,
        startTime: '18:00',
        endTime: '20:00'
      }
    });
  }

  // 3. Sunday Service: FAMILY & FRIENDS SERVICE (7:00 AM - 11:00 AM)
  let sundayType = await prisma.serviceType.findFirst({ where: { name: { contains: 'Family & Friends', mode: 'insensitive' } } });
  if (!sundayType) {
    sundayType = await prisma.serviceType.create({
      data: {
        name: 'Family & Friends Service (Sunday)',
        dayOfWeek: 0,
        startTime: '07:00',
        endTime: '11:00'
      }
    });
  }

  // Create active services for today and this week
  const now = new Date();
  const todayDate = new Date(now);
  todayDate.setHours(0, 0, 0, 0);

  const activeServiceType = now.getDay() === 3 ? wednesdayType : (now.getDay() === 5 ? fridayType : sundayType);

  const startsAt = new Date(todayDate);
  const [startH, startM] = activeServiceType.startTime.split(':').map(Number);
  startsAt.setHours(startH, startM, 0, 0);

  await prisma.service.upsert({
    where: {
      serviceTypeId_serviceDate: {
        serviceTypeId: activeServiceType.id,
        serviceDate: todayDate
      }
    },
    update: { active: true },
    create: {
      serviceTypeId: activeServiceType.id,
      serviceDate: todayDate,
      startsAt,
      active: true
    }
  });

  // Seed only Services and System Credentials (No member directory or financial figures)
  console.log('✅ Clean database setup completed:');
  console.log('  1. Super Admin Login:', admin.email, '/ Solutions12@26');
  console.log('  2. Treasury / Finance Login:', financeUser.email, '/ Money12@26');
  console.log('  Services configured:');
  console.log('   - Sunday: FAMILY & FRIENDS SERVICE (7:00 AM - 11:00 AM)');
  console.log('   - Wednesday: TIME WITH THE LORD (6:00 PM - 8:00 PM)');
  console.log('   - Friday: PROPHETIC HEALING & DELIVERANCE (6:00 PM - 8:00 PM)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

