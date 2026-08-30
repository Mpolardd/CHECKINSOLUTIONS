const prisma = require('../config/prisma');
module.exports = function audit(action, entity) {
  return async (req,res,next) => {
    res.on('finish', async () => {
      if (res.statusCode < 400) {
        try { await prisma.auditLog.create({
          data:{actorId:req.user?.sub, action, entity, entityId:req.params.id || null,
                metadata:{method:req.method,path:req.originalUrl}}
        }); } catch (_) {}
      }
    });
    next();
  };
};
