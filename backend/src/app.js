require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const auth = require('./modules/auth/auth.routes');
const members = require('./modules/members/members.routes');
const attendance = require('./modules/attendance/attendance.routes');
const finance = require('./modules/finance/finance.routes');
const celebrations = require('./modules/celebrations/celebrations.routes');
const reminders = require('./modules/reminders/reminders.routes');
const health = require('./modules/health/health.routes');
const error = require('./middleware/error');

const app = express();

app.use(helmet({
  contentSecurityPolicy: false // Allows self-contained HTML resources & external CDNs
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : true,
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// Global API rate limiter (300 requests / minute)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(globalLimiter);

// Dedicated security rate limiter for authentication endpoints (15 attempts / 15 minutes)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.get(['/', '/api', '/api/v1', '/v1'], (req, res) => res.json({ name: 'Church Management API', version: '1.0.0', status: 'operational' }));

app.use(['/api/v1/health', '/v1/health'], health);
app.use(['/api/v1/auth/login', '/v1/auth/login'], authLimiter);
app.use(['/api/v1/auth', '/v1/auth'], auth);
app.use(['/api/v1/members', '/v1/members'], members);
app.use(['/api/v1/attendance', '/v1/attendance'], attendance);
app.use(['/api/v1/finance', '/v1/finance'], finance);
app.use(['/api/v1/celebrations', '/v1/celebrations'], celebrations);
app.use(['/api/v1/reminders', '/v1/reminders'], reminders);

app.use(error);

module.exports = app;
