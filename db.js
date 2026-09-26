const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// On platforms with a persistent volume (like Fly.io), set DATA_DIR to a
// path inside that volume, e.g. /app/data. Defaults to the local ./data
// folder for plain VPS/local use.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'gst_oneclick.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    gstin TEXT,
    business_name TEXT,
    state_code TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    signup_ip TEXT,
    signup_device TEXT,
    last_login_at TEXT,
    last_login_ip TEXT,
    last_login_device TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_ext TEXT NOT NULL,
    invoice_count INTEGER NOT NULL DEFAULT 0,
    gst_period TEXT,
    status TEXT NOT NULL DEFAULT 'success',
    result_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversions_user ON conversions(user_id);
  CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_resets(user_id);
`);

// Lightweight migrations: add columns if this DB predates them
try {
  db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN locked_until TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN account_id TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN signup_ip TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN signup_device TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_login_ip TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_login_device TEXT`);
} catch (e) {
  // Column already exists — safe to ignore
}

// Backfill account_id for any existing users created before this feature
// (e.g. from a database that predates this column).
const usersMissingAccountId = db.prepare('SELECT id FROM users WHERE account_id IS NULL').all();
const backfillStmt = db.prepare('UPDATE users SET account_id = ? WHERE id = ?');
usersMissingAccountId.forEach(u => {
  backfillStmt.run(`MFS-${String(u.id).padStart(6, '0')}`, u.id);
});

module.exports = db;
