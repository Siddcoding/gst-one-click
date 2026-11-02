const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'gst_oneclick.db');
// On platforms with a single persistent volume (like Fly.io), point BACKUP_DIR
// at a folder inside that same volume via env var. Defaults to a local folder
// for plain VPS/local use.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = 30;

function runBackup() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('[backup] No database file found yet — nothing to back up.');
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `gst_oneclick-${timestamp}.db`);

  fs.copyFileSync(DB_PATH, dest);
  console.log(`[backup] Saved: ${dest}`);

  pruneOldBackups();
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('gst_oneclick-') && f.endsWith('.db'));

  files.forEach(f => {
    const filePath = path.join(BACKUP_DIR, f);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      console.log(`[backup] Removed old backup (>${RETENTION_DAYS} days): ${f}`);
    }
  });
}

// Allow running directly: `node scripts/backup.js`
if (require.main === module) {
  runBackup();
}

module.exports = { runBackup };
