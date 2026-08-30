const router=require('express').Router();
const prisma=require('../../config/prisma');
router.get('/',async(req,res)=>{try{await prisma.$queryRaw`SELECT 1`;res.json({status:'ok',database:'ok',timestamp:new Date().toISOString()})}catch(e){res.status(503).json({status:'degraded',database:'error'})}});
module.exports=router;
