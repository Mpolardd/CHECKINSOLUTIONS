const router=require('express').Router();
const prisma=require('../../config/prisma');
const {requireAuth,requireRoles}=require('../../middleware/auth');

router.get('/',requireAuth,requireRoles('SUPER_ADMIN','ADMIN','PASTORAL'),async(req,res,next)=>{
 try{res.json(await prisma.reminder.findMany({where:{status:'PENDING'},orderBy:{scheduledFor:'asc'},take:100}))}catch(e){next(e)}
});
router.post('/',requireAuth,requireRoles('SUPER_ADMIN','ADMIN','PASTORAL'),async(req,res,next)=>{
 try{
  const {title,message,scheduledFor,channel='in_app'}=req.body;
  if(!title||!message||!scheduledFor)return res.status(400).json({error:'title, message and scheduledFor are required'});
  res.status(201).json(await prisma.reminder.create({data:{title,message,scheduledFor:new Date(scheduledFor),channel}}));
 }catch(e){next(e)}
});
module.exports=router;
