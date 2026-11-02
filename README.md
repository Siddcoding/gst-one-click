# GST OneClick — Complete App (Backend + Frontend)

Real Node/Express/SQLite backend and full frontend served together from one
server. Includes authentication, email verification, password reset,
automated backups, and hard GSTIN validation — the full production-ready set.

## Quick start (local, in VS Code)

```bash
npm install
npm start
```

Open **http://localhost:4000**. A working `.env` with local dev defaults is
already included — nothing to configure for local testing.

**Email in local dev:** no SMTP is configured by default, so verification and
password-reset emails are printed to your terminal instead of actually sent.
Just copy the link that gets logged and open it in your browser to test the
flow end-to-end.

## What's included

- **Auth:** signup/login, bcrypt password hashing, JWT sessions (7-day expiry)
- **Email verification:** every new signup gets a verification email (or
  logged link locally); a banner reminds unverified users, with a resend option
- **Password reset:** "Forgot password?" on the login screen → emailed link →
  set new password. Reset links expire after 1 hour and can only be used once
- **Hard GSTIN validation:** malformed customer or business GSTINs now block
  conversion entirely with a clear error, rather than silently warning
- **Automated backups:** the database is backed up automatically on startup
  and every 24 hours to `backups/`, with 30-day auto-pruning. You can also run
  `npm run backup` manually any time
- **Security headers:** Helmet is applied for standard HTTP security headers
- **Rate limiting:** login, signup, and forgot-password endpoints are rate
  limited against brute-force attempts
- **Terms of Service & Privacy Policy:** static pages at `/terms.html` and
  `/privacy.html`, linked from signup and the login screen footer

## Setting up real email (required before going live)

Local dev logs email links to the terminal — fine for testing, not for real
users. To send real emails, edit `.env` and fill in SMTP settings:

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM="GST OneClick <no-reply@yourdomain.com>"
APP_URL=https://yourdomain.com
```

Easiest options:
- **Gmail SMTP** (fine for low volume): host `smtp.gmail.com`, port `587`,
  and an **App Password** (not your normal Gmail password — generate one in
  your Google Account security settings)
- **Transactional email providers** (better for real production volume):
  SendGrid, Mailgun, Resend, Postmark — each gives you SMTP credentials to
  paste in directly

Restart the server after changing `.env`.

## Automated backups — what's covered and what isn't

The app backs itself up automatically while it's running (on startup + every
24 hours). This is a convenience safety net, but it has one gap: **it only
runs while the Node process is running.** For real production use, also set
up an OS-level cron job on your server so backups happen independently of
the app's uptime:

```bash
crontab -e
```
Add a line to run it daily at 2 AM:
```
0 2 * * * cd /path/to/gst-oneclick-app && /usr/bin/node scripts/backup.js >> /path/to/gst-oneclick-app/backups/backup.log 2>&1
```

For real safety, also copy the `backups/` folder somewhere **off the same
server** periodically (e.g. to S3, another machine, Google Drive) — a backup
that lives on the same disk as the original doesn't protect you if that disk
fails.

## Deploying for free, live on the internet

Three options, depending on what you need:

- **`RENDER_DEPLOY.md`** — fastest to set up, closest to "1-click." Good
  for quick testing. **No persistent storage** — database resets on
  redeploy/sleep, so don't use this for real users yet.
- **`FLY_DEPLOY.md`** — Fly.io, still quick, and includes a real
  persistent disk so data survives restarts.
- **`ORACLE_DEPLOY.md`** — Oracle Cloud "Always Free", a real permanent
  virtual server, same PM2 + Nginx setup as a paid VPS
- **`DIGITALOCEAN_DEPLOY.md`** — a real, private, dedicated VPS with your
  own domain (~$6/month) — the recommended setup for a company product.

## Deploying to a VPS for public/live access

Same code, running on a remote server instead of your laptop:

1. Upload the whole project folder to your VPS (`scp -r` or your host's file
   manager)
2. Install Node.js 18+ on the server
3. `npm install`
4. Edit `.env`:
   - Generate a real `JWT_SECRET`:
     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```
   - Set `APP_URL` to your real domain (used in email links)
   - Set `CORS_ORIGIN` to your real domain
   - Fill in real SMTP settings (see above)
5. Run it permanently with PM2:
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name gst-oneclick
   pm2 save
   pm2 startup
   ```
6. Put Nginx + free HTTPS in front of it:
   ```nginx
   server {
       listen 80;
       server_name yourdomain.com;
       location / {
           proxy_pass http://localhost:4000;
           proxy_set_header Host $host;
       }
   }
   ```
   ```bash
   sudo certbot --nginx -d yourdomain.com
   ```

**HTTPS is not optional for real use** — without it, login credentials and
uploaded invoice data travel unencrypted.

## Honest going-live checklist

Everything below is now in place:
- [x] Hashed passwords + JWT auth
- [x] Email verification
- [x] Password reset
- [x] Hard GSTIN validation (blocks bad data instead of warning)
- [x] Strong password requirements (8+ chars, upper/lower/number/symbol)
- [x] Per-account lockout after 5 failed logins (15-minute lock)
- [x] Automated backups + pruning
- [x] Security headers (Helmet)
- [x] Rate limiting on auth endpoints
- [x] Terms of Service & Privacy Policy pages

Still on you before real client data flows through this:
- [ ] **Get a lawyer to review** `terms.html` / `privacy.html` — these are
      solid starting templates, not vetted legal documents
- [ ] **Set up real SMTP** — without it, users only see logged links in your
      terminal, not real emails
- [ ] **Enable HTTPS** on your actual deployment (see above)
- [ ] **Off-server backup copies** — the in-app backup protects against
      accidental deletion, not disk failure
- [ ] Consider a GSP (GST Suvidha Provider) license if you ever want to
      submit directly to the GST portal via API instead of manual upload —
      this is a government licensing process, not something code can shortcut

## Project structure

```
gst-oneclick-app/
├── server.js               # Express entry point — API + frontend + backup scheduler
├── db.js                   # SQLite schema (users, conversions, tokens)
├── middleware/auth.js       # JWT verification
├── utils/mailer.js          # Email sending (or console fallback if no SMTP)
├── scripts/backup.js        # Database backup + pruning logic
├── routes/
│   ├── auth.js               # signup, login, verify-email, forgot/reset password
│   ├── convert.js            # file upload, parsing, GST JSON generation
│   └── history.js            # conversion history CRUD
├── public/
│   ├── index.html             # entire frontend (single-page app)
│   ├── terms.html             # Terms of Service
│   └── privacy.html           # Privacy Policy
├── data/                    # SQLite database (auto-created)
├── backups/                 # Automatic daily backups (auto-created)
├── .env                     # Local config — working dev defaults included
└── .vscode/                 # F5 debug config for VS Code
```

## API reference

| Method | Endpoint                     | Auth | Purpose                              |
|--------|-------------------------------|------|----------------------------------------|
| POST   | /api/auth/signup               | No   | Create account, sends verification email |
| POST   | /api/auth/login                | No   | Sign in, returns JWT                    |
| GET    | /api/auth/me                    | Yes  | Get current user profile                |
| PUT    | /api/auth/me                    | Yes  | Update GSTIN / business profile          |
| POST   | /api/auth/verify-email          | No   | Verify email using emailed token         |
| POST   | /api/auth/resend-verification   | Yes  | Resend verification email                |
| POST   | /api/auth/forgot-password       | No   | Request password reset email             |
| POST   | /api/auth/reset-password        | No   | Set new password using emailed token     |
| POST   | /api/convert/parse              | Yes  | Upload file, get parsed rows             |
| POST   | /api/convert/build              | Yes  | Build GST JSON, saves to history         |
| GET    | /api/history                     | Yes  | List all past conversions + stats        |
| GET    | /api/history/:id                  | Yes  | Get full JSON for one conversion         |
| DELETE | /api/history/:id                  | Yes  | Delete a conversion                       |
| GET    | /api/health                       | No   | Health check                             |

All authenticated requests need header: `Authorization: Bearer <token>`
(the frontend handles this automatically once you're signed in).
