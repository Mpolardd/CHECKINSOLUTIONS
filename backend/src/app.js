require('dotenv').config();
const express=require('express');
const helmet=require('helmet');
const cors=require('cors');
const rateLimit=require('express-rate-limit');
const morgan=require('morgan');

const auth=require('./modules/auth/auth.routes');
const members=require('./modules/members/members.routes');
const attendance=require('./modules/attendance/attendance.routes');
const finance=require('./modules/finance/finance.routes');
const celebrations=require('./modules/celebrations/celebrations.routes');
const reminders=require('./modules/reminders/reminders.routes');
const health=require('./modules/health/health.routes');
const error=require('./middleware/error');

const app=express();
app.use(helmet());
app.use(cors({origin:process.env.CORS_ORIGIN?.split(',')||true,credentials:true}));
app.use(express.json({limit:'1mb'}));
app.use(morgan('combined'));
app.use(rateLimit({windowMs:60*1000,max:300,standardHeaders:true,legacyHeaders:false}));

app.get('/',(req,res)=>res.json({name:'Church Management API',version:'1.0.0'}));
app.use('/api/v1/health',health);
app.use('/api/v1/auth',auth);
app.use('/api/v1/members',members);
app.use('/api/v1/attendance',attendance);
app.use('/api/v1/finance',finance);
app.use('/api/v1/celebrations',celebrations);
app.use('/api/v1/reminders',reminders);
app.use(error);
module.exports=app;
