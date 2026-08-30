const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {z} = require('zod');
const prisma = require('../../config/prisma');

const loginSchema = z.object({email:z.string().email(), password:z.string().min(8)});

function accessToken(user) {
  return jwt.sign({sub:user.id, role:user.role, memberId:user.memberId || null},
    process.env.JWT_ACCESS_SECRET, {expiresIn:`${process.env.ACCESS_TOKEN_MINUTES || 15}m`});
}
async function refreshToken(user) {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.refreshToken.create({
    data:{userId:user.id, tokenHash,
      expiresAt:new Date(Date.now()+Number(process.env.REFRESH_TOKEN_DAYS||30)*86400000)}
  });
  return raw;
}

router.post('/login', async (req,res,next)=>{
  try {
    const body=loginSchema.parse(req.body);
    const user=await prisma.user.findUnique({where:{email:body.email.toLowerCase()}});
    if(!user || !(await bcrypt.compare(body.password,user.passwordHash)))
      return res.status(401).json({error:'Invalid email or password'});
    res.json({accessToken:accessToken(user), refreshToken:await refreshToken(user),
      user:{id:user.id,email:user.email,role:user.role,memberId:user.memberId}});
  } catch(e){next(e)}
});

router.post('/refresh', async (req,res,next)=>{
  try {
    const raw=req.body?.refreshToken;
    if(!raw) return res.status(400).json({error:'refreshToken required'});
    const hash=crypto.createHash('sha256').update(raw).digest('hex');
    const row=await prisma.refreshToken.findUnique({where:{tokenHash:hash},include:{user:true}});
    if(!row || row.revokedAt || row.expiresAt < new Date()) return res.status(401).json({error:'Invalid refresh token'});
    await prisma.refreshToken.update({where:{id:row.id},data:{revokedAt:new Date()}});
    res.json({accessToken:accessToken(row.user),refreshToken:await refreshToken(row.user)});
  } catch(e){next(e)}
});

router.post('/logout', async(req,res,next)=>{
  try {
    const raw=req.body?.refreshToken;
    if(raw){const hash=crypto.createHash('sha256').update(raw).digest('hex');
      await prisma.refreshToken.updateMany({where:{tokenHash:hash},data:{revokedAt:new Date()}});
    }
    res.json({success:true});
  } catch(e){next(e)}
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
    res.json({ valid: true, user });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
});

module.exports=router;
