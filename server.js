require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const convertRoutes = require('./routes/convert');
const historyRoutes = require('./routes/history');
const { runBackup } = require('./scripts/backup');

const app = express();

// Required on Render/Fly.io/any reverse-proxy host so req.ip reflects the
// real visitor's address instead of the proxy's internal IP — this matters
// for both rate limiting and the account login-metadata feature.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Copy .env.example to .env and set it before starting.');
  process.exit(1);
}

// ─── SECURITY HEADERS ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // the frontend loads fonts/scripts from CDNs; keep this off unless you lock down a strict CSP
}));

// ─── CORS ──────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // reflect request origin (fine for same-origin/local use)
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// ─── RATE LIMITING ─────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/api/', apiLimiter);

// ─── API ROUTES ────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/convert', convertRoutes);
app.use('/api/history', historyRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'GST OneClick API' }));

// ─── FRONTEND ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Verify-email and reset-password links from emails land on the same
// single-page app; index.html reads ?token= from the URL and shows the
// right screen automatically.
app.get(['/verify-email', '/reset-password'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── ERROR HANDLING ────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error.' });
});

// ─── AUTOMATED DAILY BACKUP ─────────────────────────────
// Runs once on startup, then every 24 hours, as a convenience safety net.
// For production use, ALSO set up a real OS-level cron job (see README) —
// this in-process timer only runs while the server itself is running, and
// won't catch you if the server has been down for a while.
runBackup();
setInterval(runBackup, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════════╗');
  console.log('  ║   GST OneClick is running                       ║');
  console.log(`  ║   Open: http://localhost:${PORT}                    ║`);
  console.log('  ╚════════════════════════════════════════════════╝');
  console.log('');
});
