const router=require('express').Router();
const prisma=require('../../config/prisma');
const {requireAuth,requireRoles}=require('../../middleware/auth');

router.get('/today',requireAuth,async(req,res,next)=>{
 try{
  const now=new Date(), tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);
  const month=now.getMonth()+1, day=now.getDate();
  const members=await prisma.member.findMany({where:{active:true,deletedAt:null},select:{id:true,firstName:true,lastName:true,dateOfBirth:true,anniversary:true}});
  const today=members.filter(m=>{
   const b=m.dateOfBirth && (m.dateOfBirth.getUTCMonth()+1===month && m.dateOfBirth.getUTCDate()===day);
   const a=m.anniversary && (m.anniversary.getUTCMonth()+1===month && m.anniversary.getUTCDate()===day);
   return b||a;
  }).map(m=>({member:m,type:m.dateOfBirth&&(m.dateOfBirth.getUTCMonth()+1===month&&m.dateOfBirth.getUTCDate()===day)?'BIRTHDAY':'ANNIVERSARY'}));
  res.json(today);
 }catch(e){next(e)}
});

router.get('/upcoming',requireAuth,requireRoles('SUPER_ADMIN','ADMIN','PASTORAL'),async(req,res,next)=>{
 try{
  const now=new Date(), end=new Date(now);end.setDate(end.getDate()+30);
  const members=await prisma.member.findMany({where:{active:true,deletedAt:null},select:{id:true,firstName:true,lastName:true,dateOfBirth:true,anniversary:true}});
  const events=[];
  for(const m of members){
   for(const [type,d] of [['BIRTHDAY',m.dateOfBirth],['ANNIVERSARY',m.anniversary]]) if(d){
    let x=new Date(now.getFullYear(),d.getUTCMonth(),d.getUTCDate());
    if(x<now)x.setFullYear(x.getFullYear()+1);
    if(x<=end)events.push({member:m,type,date:x});
   }
  }
  res.json(events.sort((a,b)=>a.date-b.date));
 }catch(e){next(e)}
});
module.exports=router;
