require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');

async function seedWomenUser() {
  try {
    const passwordHash = await bcrypt.hash('Women12@26', 10);
    const email = 'women@solutionsfaith.com';

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        passwordHash,
        role: 'ADMIN'
      },
      create: {
        email,
        passwordHash,
        role: 'ADMIN'
      }
    });

    // Remove any previous SUB_ADMIN_PROFILE logs for this user to avoid duplicates
    await prisma.auditLog.deleteMany({
      where: { entity: 'SUB_ADMIN_PROFILE', entityId: user.id }
    });

    await prisma.auditLog.create({
      data: {
        action: 'CREATE_SUB_ADMIN',
        entity: 'SUB_ADMIN_PROFILE',
        entityId: user.id,
        metadata: {
          name: "Women's Ministry Leader",
          email: user.email,
          permissions: ['women']
        }
      }
    });

    console.log('✅ Women Ministry User seeded successfully:');
    console.log('   Email: women@solutionsfaith.com');
    console.log('   Role: ADMIN with [women] privilege');
    console.log('   Password: Women12@26');
  } catch (err) {
    console.error('❌ Error seeding women user:', err);
  } finally {
    await prisma.$disconnect();
  }
}

seedWomenUser();
