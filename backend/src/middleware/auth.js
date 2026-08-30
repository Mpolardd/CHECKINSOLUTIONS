const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({error:'Authentication required'});
  try {
    req.user = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
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

module.exports = { requireAuth, requireRoles };
