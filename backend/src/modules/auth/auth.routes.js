const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const prisma = require('../../config/prisma');

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });

function accessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, memberId: user.memberId || null },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: `${process.env.ACCESS_TOKEN_MINUTES || 15}m` }
  );
}

async function refreshToken(user) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + Number(process.env.REFRESH_TOKEN_DAYS || 30) * 86400000)
    }
  });
  return raw;
}

router.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    let name = user.role === 'SUPER_ADMIN' ? 'Super Admin' : (user.role === 'FINANCE' ? 'Treasury Officer' : 'Staff');
    let permissions = user.role === 'SUPER_ADMIN'
      ? ['finance', 'attendance', 'members', 'programs', 'subAdmins']
      : (user.role === 'FINANCE' ? ['finance'] : ['attendance', 'members', 'programs']);

    if (user.role === 'ADMIN') {
      const log = await prisma.auditLog.findFirst({
        where: { entity: 'SUB_ADMIN_PROFILE', entityId: user.id },
        orderBy: { createdAt: 'desc' }
      });
      if (log && log.metadata) {
        if (log.metadata.name) name = log.metadata.name;
        if (Array.isArray(log.metadata.permissions)) permissions = log.metadata.permissions;
      }
    }

    res.json({
      accessToken: accessToken(user),
      refreshToken: await refreshToken(user),
      user: {
        id: user.id,
        email: user.email,
        name,
        role: user.role === 'ADMIN' ? 'SUB_ADMIN' : user.role,
        permissions,
        memberId: user.memberId
      }
    });
  } catch (e) {
    next(e);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.body?.refreshToken;
    if (!raw) return res.status(400).json({ error: 'refreshToken required' });
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) return res.status(401).json({ error: 'Invalid refresh token' });
    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    res.json({ accessToken: accessToken(row.user), refreshToken: await refreshToken(row.user) });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const raw = req.body?.refreshToken;
    if (raw) {
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      await prisma.refreshToken.updateMany({ where: { tokenHash: hash }, data: { revokedAt: new Date() } });
    }
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: { id: true, email: true, role: true, memberId: true }
    });
    if (!user) {
      return res.status(401).json({ error: 'User account no longer exists' });
    }

    let name = user.role === 'SUPER_ADMIN' ? 'Super Admin' : (user.role === 'FINANCE' ? 'Treasury Officer' : 'Staff');
    let permissions = user.role === 'SUPER_ADMIN'
      ? ['finance', 'attendance', 'members', 'programs', 'subAdmins']
      : (user.role === 'FINANCE' ? ['finance'] : ['attendance', 'members', 'programs']);

    if (user.role === 'ADMIN') {
      const log = await prisma.auditLog.findFirst({
        where: { entity: 'SUB_ADMIN_PROFILE', entityId: user.id },
        orderBy: { createdAt: 'desc' }
      });
      if (log && log.metadata) {
        if (log.metadata.name) name = log.metadata.name;
        if (Array.isArray(log.metadata.permissions)) permissions = log.metadata.permissions;
      }
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        name,
        role: user.role === 'ADMIN' ? 'SUB_ADMIN' : user.role,
        permissions,
        memberId: user.memberId
      }
    });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
});

// ── Sub-Admin Cloud Persistence Endpoints ──

router.get('/subadmins', async (req, res) => {
  try {
    const subAdminUsers = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, createdAt: true }
    });

    const list = [];
    for (const u of subAdminUsers) {
      const log = await prisma.auditLog.findFirst({
        where: { entity: 'SUB_ADMIN_PROFILE', entityId: u.id },
        orderBy: { createdAt: 'desc' }
      });
      const meta = (log && log.metadata) ? log.metadata : {};
      list.push({
        id: u.id,
        email: u.email,
        name: meta.name || u.email.split('@')[0],
        permissions: Array.isArray(meta.permissions) ? meta.permissions : ['attendance', 'members', 'programs'],
        createdAt: u.createdAt.toLocaleDateString('en-GB')
      });
    }

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sub-admins' });
  }
});

router.post('/subadmins', async (req, res) => {
  try {
    const { name, email, password, permissions } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(400).json({ error: 'An account with this email address already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        role: 'ADMIN'
      }
    });

    const allowedPerms = Array.isArray(permissions)
      ? permissions.filter(p => p !== 'finance' && p !== 'subAdmins')
      : ['attendance', 'members', 'programs'];

    await prisma.auditLog.create({
      data: {
        action: 'CREATE_SUB_ADMIN',
        entity: 'SUB_ADMIN_PROFILE',
        entityId: user.id,
        metadata: {
          name,
          email: user.email,
          permissions: allowedPerms
        }
      }
    });

    res.json({
      id: user.id,
      name,
      email: user.email,
      permissions: allowedPerms,
      createdAt: user.createdAt.toLocaleDateString('en-GB')
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create sub-admin' });
  }
});

router.put('/subadmins/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, password, permissions } = req.body || {};

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== 'ADMIN') {
      return res.status(404).json({ error: 'Sub-admin not found' });
    }

    if (password && password.trim().length >= 6) {
      const passwordHash = await bcrypt.hash(password.trim(), 10);
      await prisma.user.update({
        where: { id },
        data: { passwordHash }
      });
    }

    const allowedPerms = Array.isArray(permissions)
      ? permissions.filter(p => p !== 'finance' && p !== 'subAdmins')
      : ['attendance', 'members', 'programs'];

    await prisma.auditLog.create({
      data: {
        action: 'UPDATE_SUB_ADMIN',
        entity: 'SUB_ADMIN_PROFILE',
        entityId: user.id,
        metadata: {
          name: name || user.email.split('@')[0],
          email: user.email,
          permissions: allowedPerms
        }
      }
    });

    res.json({
      id: user.id,
      name: name || user.email.split('@')[0],
      email: user.email,
      permissions: allowedPerms
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update sub-admin' });
  }
});

router.delete('/subadmins/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== 'ADMIN') {
      return res.status(404).json({ error: 'Sub-admin not found' });
    }

    await prisma.refreshToken.deleteMany({ where: { userId: id } });
    await prisma.auditLog.deleteMany({ where: { entityId: id } });
    await prisma.user.delete({ where: { id } });

    res.json({ success: true, message: 'Sub-admin revoked successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sub-admin' });
  }
});

module.exports = router;
