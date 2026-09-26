const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only CSV, XLSX or XLS files are allowed.'), ok);
  },
});

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// The exact header names used by the official GST portal "GSTR-1 Offline
// Utility" export, sheet "b2b,sez,de". We match on these directly instead
// of asking the user to map columns — this is a fixed, government-defined
// format, so auto-detection is reliable.
const EXPECTED_HEADERS = [
  'gstin/uin of recipient',
  'receiver name',
  'invoice number',
  'invoice date',
  'invoice value',
  'place of supply',
  'reverse charge',
  'invoice type',
  'rate',
  'taxable value',
];

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

// Finds the header row within the first N rows of a sheet by looking for
// a row that contains most of the expected official column names.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const normalized = rows[i].map(normalizeHeader);
    const matches = EXPECTED_HEADERS.filter(h => normalized.includes(h));
    if (matches.length >= 8) {
      return { headerRowIndex: i, headers: rows[i] };
    }
  }
  return null;
}

function mapInvoiceType(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v.includes('sez') && v.includes('without')) return 'SEWOP';
  if (v.includes('sez')) return 'SEWP';
  if (v.includes('deemed')) return 'DE';
  return 'R'; // Regular B2B and anything unrecognized defaults to Regular
}

// ─── PARSE + BUILD in one step — no manual mapping required ───
router.post('/auto', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const supplierGstin = (user.gstin || '').toUpperCase().trim();
    if (!supplierGstin || !GSTIN_REGEX.test(supplierGstin)) {
      return res.status(400).json({ error: 'Your business GSTIN is missing or invalid. Please set a valid GSTIN in Settings before converting.' });
    }
    const supplierState = supplierGstin.substring(0, 2);

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let rows2d = [];

    if (ext === 'csv') {
      const text = req.file.buffer.toString('utf-8');
      const parsed = Papa.parse(text, { header: false, skipEmptyLines: true });
      rows2d = parsed.data;
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      // Prefer a sheet literally named like the official template; otherwise use the first sheet.
      const sheetName = workbook.SheetNames.find(n => /b2b/i.test(n)) || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows2d = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    }

    if (!rows2d.length) return res.status(400).json({ error: 'The file appears empty.' });

    const found = findHeaderRow(rows2d);
    if (!found) {
      return res.status(400).json({
        error: 'This file doesn\'t match the expected GST invoice format. Please upload the standard GSTR-1 offline utility export (sheet "b2b,sez,de"), or a CSV with the same column headers.',
      });
    }

    const headerMap = {}; // normalized header -> column index
    found.headers.forEach((h, i) => { headerMap[normalizeHeader(h)] = i; });

    const dataRows = rows2d
      .slice(found.headerRowIndex + 1)
      .filter(r => r.some(c => String(c).trim() !== ''));

    if (!dataRows.length) {
      return res.status(400).json({ error: 'No invoice rows found below the header row.' });
    }

    const col = (row, name) => {
      const idx = headerMap[name];
      return idx !== undefined ? row[idx] : '';
    };

    const invalidRows = [];
    const invoiceMap = new Map(); // "ctin|inum" -> invoice object

    dataRows.forEach((row, idx) => {
      const ctin = String(col(row, 'gstin/uin of recipient') || '').toUpperCase().trim();
      const inum = String(col(row, 'invoice number') || '').trim();
      const rawDate = col(row, 'invoice date');
      const val = parseFloat(col(row, 'invoice value')) || 0;
      const posRaw = String(col(row, 'place of supply') || '').trim();
      const pos = posRaw.split('-')[0].trim().padStart(2, '0').slice(0, 2);
      const rchrg = String(col(row, 'reverse charge') || 'N').toUpperCase().trim() === 'Y' ? 'Y' : 'N';
      const invTyp = mapInvoiceType(col(row, 'invoice type'));
      const rate = parseFloat(col(row, 'rate')) || 0;
      const txval = parseFloat(col(row, 'taxable value')) || 0;
      const csamt = parseFloat(col(row, 'cess amount')) || 0;

      if (!ctin || !inum) return; // skip blank/summary rows

      if (!GSTIN_REGEX.test(ctin)) {
        invalidRows.push({ row: found.headerRowIndex + 2 + idx, gstin: ctin });
        return;
      }

      // Determine IGST vs CGST+SGST based on whether the place of supply
      // matches the supplier's own state — this is the real rule GST uses,
      // rather than trusting separate IGST/CGST columns that this template
      // doesn't actually provide.
      const isInterState = pos !== supplierState;
      const taxAmount = (txval * rate) / 100;
      const iamt = isInterState ? +taxAmount.toFixed(2) : 0;
      const camt = isInterState ? 0 : +(taxAmount / 2).toFixed(2);
      const samt = isInterState ? 0 : +(taxAmount / 2).toFixed(2);

      const key = `${ctin}|${inum}`;
      if (!invoiceMap.has(key)) {
        invoiceMap.set(key, {
          inum,
          idt: rawDate,
          val,
          pos,
          rchrg,
          inv_typ: invTyp,
          ctin,
          nm: String(col(row, 'receiver name') || '').trim(),
          itms: [],
        });
      }
      const invoice = invoiceMap.get(key);
      invoice.itms.push({
        num: invoice.itms.length + 1,
        itm_det: { txval, rt: rate, iamt, camt, samt, csamt },
      });
    });

    if (invalidRows.length) {
      return res.status(400).json({
        error: `${invalidRows.length} row(s) have an invalid customer GSTIN. Please fix these in your file and re-upload.`,
        invalidRows: invalidRows.slice(0, 10),
      });
    }

    const invoices = Array.from(invoiceMap.values());
    if (!invoices.length) {
      return res.status(400).json({ error: 'No valid invoices could be read from this file.' });
    }

    // Group invoices by customer GSTIN for the b2b JSON structure
    const byCustomer = new Map();
    invoices.forEach(inv => {
      if (!byCustomer.has(inv.ctin)) byCustomer.set(inv.ctin, []);
      const { ctin, ...invWithoutCtin } = inv;
      byCustomer.get(inv.ctin).push(invWithoutCtin);
    });

    const now = new Date();
    const fp = String(now.getMonth() + 1).padStart(2, '0') + now.getFullYear();
    const grandTotal = invoices.reduce(
      (s, inv) => s + inv.itms.reduce((s2, it) => s2 + it.itm_det.txval, 0), 0
    );

    const gstJson = {
      gstin: supplierGstin,
      fp,
      gt: +grandTotal.toFixed(2),
      cur_gt: +grandTotal.toFixed(2),
      b2b: Array.from(byCustomer.entries()).map(([ctin, inv]) => ({ ctin, inv })),
    };

    const info = db.prepare(`
      INSERT INTO conversions (user_id, file_name, file_ext, invoice_count, gst_period, status, result_json)
      VALUES (?, ?, ?, ?, ?, 'success', ?)
    `).run(req.user.id, req.file.originalname, ext, invoices.length, fp, JSON.stringify(gstJson));

    res.status(201).json({
      id: info.lastInsertRowid,
      json: gstJson,
      invoiceCount: invoices.length,
      fileName: req.file.originalname,
    });
  } catch (err) {
    console.error('Auto-convert error:', err);
    res.status(500).json({ error: 'Something went wrong converting this file. Please check the format and try again.' });
  }
});

module.exports = router;
