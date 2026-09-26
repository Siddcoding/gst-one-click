const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ─── LIST HISTORY (with stats) ─────────────────────────
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, file_name, file_ext, invoice_count, gst_period, status, created_at
    FROM conversions WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);

  const stats = db.prepare(`
    SELECT COUNT(*) as totalFiles,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
           SUM(invoice_count) as totalInvoices
    FROM conversions WHERE user_id = ?
  `).get(req.user.id);

  res.json({
    history: rows.map(r => ({
      id: r.id,
      fileName: r.file_name,
      fileExt: r.file_ext,
      invoiceCount: r.invoice_count,
      gstPeriod: r.gst_period,
      status: r.status,
      createdAt: r.created_at,
    })),
    stats: {
      totalFiles: stats.totalFiles || 0,
      successCount: stats.successCount || 0,
      totalInvoices: stats.totalInvoices || 0,
    },
  });
});

// ─── GET ONE (full JSON for re-download) ───────────────
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM conversions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Conversion not found.' });
  res.json({
    id: row.id,
    fileName: row.file_name,
    fileExt: row.file_ext,
    invoiceCount: row.invoice_count,
    gstPeriod: row.gst_period,
    status: row.status,
    createdAt: row.created_at,
    json: JSON.parse(row.result_json),
  });
});

// ─── DELETE ─────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM conversions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Conversion not found.' });
  res.json({ success: true });
});

module.exports = router;
