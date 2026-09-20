const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({error:'Authentication required'});
  try {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('JWT_ACCESS_SECRET is missing');
    req.user = jwt.verify(token, secret);
    if (req.user && req.user.sub && !req.user.userId) {
      req.user.userId = req.user.sub;
    }
    next();
  } catch {
    return res.status(401).json({error:'Invalid or expired access token'});
  }
}

function requireRoles(...roles) {
  return (req,res,next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({error:'Insufficient permissions'});
    next();
  };
}

/**
 * Enhanced middleware to check for specific module permissions.
 * Grants access if:
 * 1. User is SUPER_ADMIN
 * 2. User has the specified role (optional)
 * 3. User is an ADMIN (Sub-Admin) and has the required permission string in their profile audit log
 */
function requirePermission(permissionName, requiredRole = null) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });

      const { role } = req.user;

      // 1. Super Admins bypass all module-level permission checks
      if (role === 'SUPER_ADMIN') return next();

      // 2. Check if user matches a specific required role (e.g. FINANCE for the whole module)
      if (requiredRole && role === requiredRole) return next();

      // 3. For Sub-Admins (ADMIN role), check the dynamic permissions list in their profile
      if (role === 'ADMIN') {
        const targetUserId = req.user.id || req.user.userId || req.user.sub;
        const log = await prisma.auditLog.findFirst({
          where: { entity: 'SUB_ADMIN_PROFILE', entityId: targetUserId },
          orderBy: { createdAt: 'desc' }
        });
        const perms = (log && log.metadata && Array.isArray(log.metadata.permissions)) ? log.metadata.permissions : [];

        if (perms.includes(permissionName)) {
          return next();
        }
      }

      return res.status(403).json({
        error: `Insufficient permissions: '${permissionName}' access required for this action.`
      });
    } catch (err) {
      return res.status(500).json({ error: 'Internal authorization error during permission check' });
    }
  };
}

module.exports = { requireAuth, requireRoles, requirePermission };
