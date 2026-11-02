const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');

const router = express.Router();

const APP_URL = process.env.APP_URL || 'http://localhost:4000';
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(u) {
  return {
    id: u.id,
    accountId: u.account_id,
    name: u.name,
    email: u.email,
    gstin: u.gstin,
    businessName: u.business_name,
    stateCode: u.state_code,
    emailVerified: !!u.email_verified,
    memberSince: u.created_at,
    lastLoginAt: u.last_login_at,
    lastLoginIp: u.last_login_ip,
    lastLoginDevice: u.last_login_device,
  };
}

// Very lightweight device/browser label from the User-Agent header — good
// enough for "you're signed in from Chrome on Windows" style display,
// without pulling in a full UA-parsing dependency.
function describeDevice(userAgent) {
  const ua = userAgent || '';
  let browser = 'Unknown browser';
  if (/edg/i.test(ua)) browser = 'Edge';
  else if (/chrome/i.test(ua)) browser = 'Chrome';
  else if (/firefox/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';

  let os = 'Unknown device';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad/i.test(ua)) os = 'iOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

function getClientIp(req) {
  // req.ip respects Express's "trust proxy" setting, which server.js
  // enables — important on Render/Fly/any reverse-proxy host, or every
  // account would otherwise record the proxy's IP instead of the real one.
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function makeToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// Requires 8+ chars, at least one uppercase, one lowercase, one digit, and
// one special character — meaningfully stronger than a bare length check.
const STRONG_PASSWORD_MSG = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.';
function isStrongPassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 8
    && /[A-Z]/.test(pw)
    && /[a-z]/.test(pw)
    && /[0-9]/.test(pw)
    && /[^A-Za-z0-9]/.test(pw);
}

async function sendVerificationEmail(user) {
  const { raw, hash } = makeToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  db.prepare('INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(user.id, hash, expiresAt);

  const link = `${APP_URL}/verify-email?token=${raw}`;
  await sendMail({
    to: user.email,
    subject: 'Verify your GST OneClick account',
    text: `Hi ${user.name},\n\nPlease verify your email by opening this link:\n${link}\n\nThis link expires in 24 hours.\n\n— M Fintech Solutions`,
    html: `<p>Hi ${user.name},</p><p>Please verify your email by clicking below:</p><p><a href="${link}">Verify my email</a></p><p>This link expires in 24 hours.</p><p>— M Fintech Solutions</p>`,
  });
}

// ─── SIGNUP ───────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, gstin } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: STRONG_PASSWORD_MSG });
    }
    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin.toUpperCase().trim())) {
      return res.status(400).json({ error: 'GSTIN format looks invalid. It should be 15 characters, e.g. 22AAAAA0000A1Z5.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const signupIp = getClientIp(req);
    const signupDevice = describeDevice(req.headers['user-agent']);

    const info = db.prepare(
      'INSERT INTO users (name, email, password_hash, gstin, signup_ip, signup_device) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name.trim(), email.toLowerCase().trim(), passwordHash, (gstin || '').toUpperCase().trim(), signupIp, signupDevice);

    // Account ID is derived from the row id so it's guaranteed unique
    // without a separate counter table — format: MFS-000123
    const accountId = `MFS-${String(info.lastInsertRowid).padStart(6, '0')}`;
    db.prepare('UPDATE users SET account_id = ? WHERE id = ?').run(accountId, info.lastInsertRowid);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    sendVerificationEmail(user).catch(err => console.error('Verification email error:', err.message));

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account.' });
  }
});

// ─── LOGIN ────────────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Per-account lockout — blocks credential-stuffing against one specific
    // account even from many different IPs, which the IP-based rate limiter
    // alone wouldn't catch.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Too many failed attempts. This account is locked for ${minutesLeft} more minute(s).` });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
        db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(lockedUntil, user.id);
        return res.status(423).json({ error: 'Too many failed attempts. This account is locked for 15 minutes.' });
      }
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Successful login — clear any prior failed attempts / lock, and
    // record when/where this login happened for the account's own records.
    const loginIp = getClientIp(req);
    const loginDevice = describeDevice(req.headers['user-agent']);
    db.prepare(`
      UPDATE users
      SET failed_attempts = 0, locked_until = NULL,
          last_login_at = datetime('now'), last_login_ip = ?, last_login_device = ?
      WHERE id = ?
    `).run(loginIp, loginDevice, user.id);

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const token = signToken(updatedUser);
    res.json({ token, user: publicUser(updatedUser) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong signing you in.' });
  }
});

// ─── EMAIL VERIFICATION ────────────────────────────────
router.post('/verify-email', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing verification token.' });

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const record = db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?').get(hash);

    if (!record) return res.status(400).json({ error: 'This verification link is invalid.' });
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This verification link has expired. Please request a new one.' });
    }

    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(record.user_id);
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(record.user_id);

    res.json({ success: true, message: 'Email verified successfully.' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Something went wrong verifying your email.' });
  }
});

router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.email_verified) return res.status(400).json({ error: 'Your email is already verified.' });

    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(user.id);
    await sendVerificationEmail(user);
    res.json({ success: true, message: 'Verification email sent.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: err.message || 'Could not resend verification email.' });
  }
});

// ─── FORGOT PASSWORD ────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  // Always respond with the same generic message whether or not the
  // account exists — this prevents attackers from using this endpoint
  // to discover which emails are registered.
  const genericResponse = { success: true, message: 'If an account exists for that email, a reset link has been sent.' };

  try {
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) return res.json(genericResponse);

    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

    const { raw, hash } = makeToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(user.id, hash, expiresAt);

    const link = `${APP_URL}/reset-password?token=${raw}`;
    await sendMail({
      to: user.email,
      subject: 'Reset your GST OneClick password',
      text: `Hi ${user.name},\n\nOpen this link to reset your password:\n${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.\n\n— M Fintech Solutions`,
      html: `<p>Hi ${user.name},</p><p>Click below to reset your password:</p><p><a href="${link}">Reset my password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p><p>— M Fintech Solutions</p>`,
    });

    res.json(genericResponse);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(genericResponse);
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ error: STRONG_PASSWORD_MSG });
    }

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const record = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hash);

    if (!record || record.used) return res.status(400).json({ error: 'This reset link is invalid or already used.' });
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, record.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(record.id);

    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Something went wrong resetting your password.' });
  }
});

// ─── GET PROFILE ──────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(user) });
});

// ─── UPDATE PROFILE / SETTINGS ────────────────────────
router.put('/me', requireAuth, (req, res) => {
  const { gstin, businessName, stateCode } = req.body;
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin.toUpperCase().trim())) {
    return res.status(400).json({ error: 'GSTIN format looks invalid. It should be 15 characters, e.g. 22AAAAA0000A1Z5.' });
  }
  db.prepare(
    'UPDATE users SET gstin = ?, business_name = ?, state_code = ? WHERE id = ?'
  ).run(
    (gstin || '').toUpperCase().trim(),
    (businessName || '').trim(),
    (stateCode || '').trim(),
    req.user.id
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

module.exports = router;
