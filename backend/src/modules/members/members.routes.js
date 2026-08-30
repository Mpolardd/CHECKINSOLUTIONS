const router=require('express').Router();
const {z}=require('zod');
const prisma=require('../../config/prisma');
const {requireAuth,requireRoles}=require('../../middleware/auth');

const memberSchema=z.object({
  firstName:z.string().min(1),lastName:z.string().min(1),
  email:z.string().email().optional().or(z.literal('')),
  phone:z.string().optional(),dateOfBirth:z.string().datetime().optional(),
  anniversary:z.string().datetime().optional(),householdId:z.string().optional()
});

router.get('/',requireAuth,async(req,res,next)=>{
  try{
    const q=String(req.query.q||'').trim();
    const where={active:true,deletedAt:null};
    if(q) where.OR=[
      {firstName:{contains:q,mode:'insensitive'}},
      {lastName:{contains:q,mode:'insensitive'}},
      {phone:{contains:q}},
      {email:{contains:q,mode:'insensitive'}}
    ];
    const rows=await prisma.member.findMany({where,take:50,orderBy:{lastName:'asc'}});
    res.json(rows);
  }catch(e){next(e)}
});

router.post('/',requireAuth,requireRoles('SUPER_ADMIN','ADMIN','REGISTRATION'),async(req,res,next)=>{
 try{
  const b=memberSchema.parse(req.body);
  const m=await prisma.member.create({data:{
    ...b,email:b.email||null,
    dateOfBirth:b.dateOfBirth?new Date(b.dateOfBirth):null,
    anniversary:b.anniversary?new Date(b.anniversary):null
  }});
  res.status(201).json(m);
 }catch(e){next(e)}
});

router.get('/:id',requireAuth,async(req,res,next)=>{
 try{
  const m=await prisma.member.findUnique({where:{id:req.params.id},include:{household:true,attendance:{take:20,orderBy:{checkedInAt:'desc'}}}});
  if(!m)return res.status(404).json({error:'Member not found'});
  res.json(m);
 }catch(e){next(e)}
});

module.exports=router;
