const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { toPortalJSON } = require('../utils/gstJson');

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
const FP_REGEX = /^(0[1-9]|1[0-2])\d{4}$/;

// Tax rates accepted by the GST portal (same list the official offline tool
// ships in public/data/rate.json).
const VALID_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

// GSTIN check digit (mod-36 Luhn variant used by GSTN). The portal rejects a
// GSTIN whose 15th character doesn't match.
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinChecksumOk(gstin) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(gstin[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}
function isValidGstin(g) { return GSTIN_REGEX.test(g) && gstinChecksumOk(g); }

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/,/g, '').replace(/[₹\s]/g, '');
  // Tally sometimes prints negatives as "(123.00)" or with a trailing "Cr"/"Dr"
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, '').replace(/(cr|dr)$/i, ''));
  return isNaN(n) ? 0 : (neg ? -n : n);
}

// ─── Dates ────────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Returns {d, m, y} or null. Handles Excel serials, Date objects and the text
// formats Tally / the offline tool produce (01-04-2026, 1/4/26, 1-Apr-26, 2026-04-01).
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return { d: v.getDate(), m: v.getMonth() + 1, y: v.getFullYear() };
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    return p && p.y > 1900 ? { d: p.d, m: p.m, y: p.y } : null;
  }
  const s = String(v).trim();
  let m;
  const fixYear = y => (y < 100 ? 2000 + y : y);
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    return valid({ y: +m[1], m: +m[2], d: +m[3] });
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    return valid({ d: +m[1], m: +m[2], y: fixYear(+m[3]) }); // Indian dd-mm-yyyy
  }
  if ((m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/,]*(\d{2,4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? valid({ d: +m[1], m: mon, y: fixYear(+m[3]) }) : null;
  }
  return null;

  function valid(o) {
    return o.m >= 1 && o.m <= 12 && o.d >= 1 && o.d <= 31 && o.y > 2000 ? o : null;
  }
}
const fmtIdt = p => `${String(p.d).padStart(2, '0')}-${String(p.m).padStart(2, '0')}-${p.y}`; // dd-mm-yyyy
const fmtFp = p => `${String(p.m).padStart(2, '0')}${p.y}`; // MMYYYY

// ─── Column detection ─────────────────────────────────────
// Supports two layouts:
//   1. Tally "Sales Register" export (Date, Buyer, Voucher No., GSTIN/UIN,
//      Gross Total, Value, CGST, SGST, IGST …) — tax amounts are read as-is.
//   2. The GST Offline Tool template, sheet "b2b,sez,de" — tax is calculated
//      from Rate × Taxable Value, exactly like the official tool does.
const norm = h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');

const ALIASES = {
  ctin: ['gstin/uin of recipient', 'gstin/uin', 'gstin', 'gstin of recipient', 'party gstin', 'buyer gstin', 'customer gstin', 'gst no', 'gst no.'],
  name: ['receiver name', 'buyer', 'party name', 'customer name', 'particulars'],
  inum: ['invoice number', 'invoice no', 'invoice no.', 'voucher no.', 'voucher no', 'bill no', 'bill no.'],
  date: ['invoice date', 'date', 'voucher date', 'bill date'],
  val: ['invoice value', 'gross total', 'total value', 'total'],
  txval: ['taxable value', 'value', 'assessable value', 'taxable amount'],
  pos: ['place of supply', 'pos'],
  rchrg: ['reverse charge'],
  invType: ['invoice type'],
  rate: ['rate', 'tax rate', 'gst rate'],
  diff: ['applicable % of tax rate'],
  etin: ['e-commerce gstin'],
  vchType: ['voucher type'],
  roundOff: ['round off', 'rounding off', 'round-off'],
};

function detectColumns(headerRow) {
  const h = headerRow.map(norm);
  const cols = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const i = h.indexOf(n);
      if (i !== -1) { cols[field] = i; break; }
    }
  }
  // Tax ledgers can be named "CGST", "Output CGST @9%", "Central Tax Amount" …
  // Collect every matching column so multi-ledger registers still add up.
  const find = re => h.map((x, i) => (re.test(x) && !/rate|%\s*of/.test(x) ? i : -1)).filter(i => i !== -1);
  cols.cgst = find(/\bcgst\b|central tax/);
  cols.sgst = find(/\bsgst\b|\butgst\b|state\/ut tax|state tax/);
  cols.igst = find(/\bigst\b|integrated tax/);
  cols.cess = find(/\bcess\b/);
  // Sales ledger columns — fallback for taxable value when there's no "Value" column.
  cols.sales = h.map((x, i) => (/^sales\b|sales account|sales @/.test(x) ? i : -1)).filter(i => i !== -1);
  return cols;
}

function scoreHeader(cols) {
  let s = 0;
  if (cols.ctin !== undefined) s += 3;
  if (cols.inum !== undefined) s += 3;
  if (cols.date !== undefined) s += 2;
  if (cols.val !== undefined) s += 1;
  if (cols.txval !== undefined || cols.sales.length) s += 1;
  if (cols.rate !== undefined || cols.cgst.length || cols.igst.length) s += 1;
  return s;
}

// Finds the best header row across all sheets (first 25 rows of each).
function locateTable(sheets) {
  let best = null;
  for (const { name, rows } of sheets) {
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      const cols = detectColumns(rows[i]);
      const score = scoreHeader(cols);
      if (score >= 9 && (!best || score > best.score)) best = { sheet: name, rows, headerRowIndex: i, cols, score };
    }
  }
  return best;
}

// Invoice-type labels used by the official offline tool (getInvType in returns.fct.js).
function mapInvoiceType(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v.includes('regular')) return 'R';
  if (v.includes('sez') && v.includes('without')) return 'SEWOP';
  if (v.includes('sez')) return 'SEWP';
  if (v.includes('deemed')) return 'DE';
  if (v.includes('attracting igst') || v.includes('section 7')) return 'CBW';
  return 'R';
}

function snapRate(r) {
  let best = VALID_RATES[0];
  for (const v of VALID_RATES) if (Math.abs(v - r) < Math.abs(best - r)) best = v;
  return best;
}

// ─── Main conversion (exported for tests) ─────────────────
function convertRows(sheets, supplierGstin, opts = {}) {
  const supplierState = supplierGstin.substring(0, 2);
  const table = locateTable(sheets);
  if (!table) {
    const e = new Error('Could not find an invoice table in this file. Upload a Tally "Sales Register" export (with Date, Voucher No., GSTIN/UIN, Gross Total, Value, CGST/SGST/IGST columns) or the GST Offline Tool "b2b,sez,de" sheet.');
    e.status = 400;
    throw e;
  }

  const { cols, rows, headerRowIndex } = table;
  const get = (row, f) => (cols[f] !== undefined ? row[cols[f]] : '');
  const sum = (row, list) => list.reduce((s, i) => s + num(row[i]), 0);
  const hasTaxCols = cols.cgst.length + cols.sgst.length + cols.igst.length > 0;

  const warnings = [];
  const invalidRows = [];
  const skippedB2C = { count: 0, taxable: 0 };
  const skippedNoInum = [];
  const skippedOther = [];
  const invoiceMap = new Map(); // "ctin|inum" → invoice
  const monthCount = new Map();

  rows.slice(headerRowIndex + 1).forEach((row, idx) => {
    const excelRow = headerRowIndex + 2 + idx;
    if (!row.some(c => String(c).trim() !== '')) return;

    const nameRaw = String(get(row, 'name') || '').trim();
    if (row.some(c => /^(grand )?total$/i.test(String(c).trim()))) return; // register footer

    const vchType = String(get(row, 'vchType') || '').trim();
    if (vchType && !/sale|invoice|tax/i.test(vchType)) {
      skippedOther.push(`Row ${excelRow}: voucher type "${vchType}"`);
      return;
    }

    const dateP = parseDate(get(row, 'date'));
    const ctin = String(get(row, 'ctin') || '').toUpperCase().replace(/\s/g, '');
    const inum = String(get(row, 'inum') ?? '').trim();

    // Taxable value
    let txval;
    if (cols.txval !== undefined) txval = num(get(row, 'txval'));
    else if (cols.sales.length) txval = sum(row, cols.sales);
    else txval = num(get(row, 'val')) - sum(row, cols.cgst) - sum(row, cols.sgst) - sum(row, cols.igst) - sum(row, cols.cess) - num(get(row, 'roundOff'));
    txval = round2(txval);

    if (!dateP && !ctin && !inum) return; // stray text row

    if (!ctin) { // unregistered buyer → B2C, not part of the b2b table
      skippedB2C.count++;
      skippedB2C.taxable += txval;
      return;
    }
    if (!isValidGstin(ctin)) { invalidRows.push({ row: excelRow, gstin: ctin }); return; }
    if (!inum) { skippedNoInum.push(`Row ${excelRow} (${nameRaw || ctin})`); return; }
    if (!dateP) { invalidRows.push({ row: excelRow, gstin: ctin, reason: 'invalid invoice date' }); return; }
    if (inum.length > 16 || !/^[A-Za-z0-9/-]+$/.test(inum)) {
      warnings.push(`Invoice "${inum}" (row ${excelRow}): GST portal allows max 16 characters using only letters, digits, "/" and "-".`);
    }

    // Place of supply: explicit column, else the buyer's state code.
    const posRaw = String(get(row, 'pos') || '').trim();
    const pos = posRaw ? posRaw.split('-')[0].trim().padStart(2, '0').slice(0, 2) : ctin.slice(0, 2);

    const rchrgRaw = String(get(row, 'rchrg') || 'N').trim().toUpperCase();
    const rchrg = rchrgRaw === 'Y' || rchrgRaw === 'YES' ? 'Y' : 'N';
    const invTyp = mapInvoiceType(get(row, 'invType'));
    const diffRaw = num(get(row, 'diff'));
    const diff = diffRaw === 65 ? 0.65 : null;
    const etin = String(get(row, 'etin') || '').trim().toUpperCase();

    let iamt, camt, samt, csamt, rt;
    if (hasTaxCols) {
      // Sales Register: trust the tax amounts posted in the books.
      iamt = round2(sum(row, cols.igst));
      camt = round2(sum(row, cols.cgst));
      samt = round2(sum(row, cols.sgst));
      csamt = round2(sum(row, cols.cess));
      if (cols.rate !== undefined && String(get(row, 'rate')).trim() !== '') {
        rt = num(get(row, 'rate'));
      } else {
        const eff = txval ? ((iamt + camt + samt) / txval) * 100 / (diff || 1) : 0;
        rt = snapRate(eff);
        if (Math.abs(eff - rt) > 0.05) {
          warnings.push(`Invoice ${inum}: effective tax rate ${eff.toFixed(2)}% isn't a standard GST rate — used ${rt}%. Check whether this invoice has items at more than one rate.`);
        }
      }
    } else {
      // Offline-tool template: compute tax from rate (same formula as the official tool).
      rt = num(get(row, 'rate'));
      const f = diff || 1;
      const inter = pos !== supplierState || ['SEWP', 'SEWOP', 'CBW'].includes(invTyp);
      const zero = invTyp === 'SEWOP';
      iamt = inter && !zero ? round2(txval * rt * 0.01 * f) : 0;
      camt = !inter ? round2(txval * rt * 0.005 * f) : 0;
      samt = camt;
      csamt = zero ? 0 : round2(sum(row, cols.cess));
    }
    if (!VALID_RATES.includes(rt)) warnings.push(`Invoice ${inum}: rate ${rt}% is not accepted by the GST portal.`);

    const key = `${ctin}|${inum}`;
    if (!invoiceMap.has(key)) {
      const inv = {
        inum,
        idt: fmtIdt(dateP),
        val: round2(num(get(row, 'val'))),
        pos,
        rchrg,
      };
      if (diff) inv.diff_percent = diff;
      if (etin) inv.etin = etin;
      inv.inv_typ = invTyp;
      inv.itms = [];
      invoiceMap.set(key, { ctin, inv, _month: dateP });
      const mk = fmtFp(dateP);
      monthCount.set(mk, (monthCount.get(mk) || 0) + 1);
    }
    const { inv } = invoiceMap.get(key);
    // One item per rate per invoice (the portal keys items on rate).
    const existing = inv.itms.find(it => it.itm_det.rt === rt);
    if (existing) {
      const d = existing.itm_det;
      d.txval = round2(d.txval + txval); d.iamt = round2(d.iamt + iamt);
      d.camt = round2(d.camt + camt); d.samt = round2(d.samt + samt); d.csamt = round2(d.csamt + csamt);
    } else {
      inv.itms.push({ num: inv.itms.length + 1, itm_det: { txval, rt, iamt, camt, samt, csamt } });
    }
  });

  if (invalidRows.length) {
    const e = new Error(`${invalidRows.length} row(s) have an invalid customer GSTIN or invoice date. Please fix these in your file and re-upload.`);
    e.status = 400;
    e.invalidRows = invalidRows.slice(0, 10);
    throw e;
  }

  const entries = Array.from(invoiceMap.values());
  if (!entries.length) {
    const e = new Error('No B2B invoices (rows with a customer GSTIN and invoice number) were found in this file.');
    e.status = 400;
    throw e;
  }

  // Duplicate invoice numbers across customers are rejected by the portal.
  const seen = new Map();
  entries.forEach(({ ctin, inv }) => {
    if (seen.has(inv.inum) && seen.get(inv.inum) !== ctin) warnings.push(`Invoice number ${inv.inum} is used for more than one customer — the portal will reject the duplicate.`);
    seen.set(inv.inum, ctin);
  });

  // Return period: user-supplied, else the month most invoices fall in.
  let fp = opts.fp && FP_REGEX.test(opts.fp) ? opts.fp : null;
  if (!fp) fp = [...monthCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const outside = entries.filter(e => fmtFp(e._month) !== fp).length;
  if (outside) warnings.push(`${outside} invoice(s) are dated outside the return period ${fp.slice(0, 2)}/${fp.slice(2)}. That's expected for quarterly (QRMP) filers; otherwise check the dates.`);

  if (skippedB2C.count) warnings.push(`${skippedB2C.count} sale(s) to unregistered buyers (no GSTIN, taxable ₹${round2(skippedB2C.taxable).toFixed(2)}) were left out — those belong in the B2CS table, not B2B.`);
  if (skippedNoInum.length) warnings.push(`${skippedNoInum.length} B2B row(s) skipped because the voucher/invoice number is blank: ${skippedNoInum.slice(0, 5).join(', ')}${skippedNoInum.length > 5 ? '…' : ''}`);
  if (skippedOther.length) warnings.push(`${skippedOther.length} non-sales voucher(s) skipped: ${skippedOther.slice(0, 3).join(', ')}${skippedOther.length > 3 ? '…' : ''}`);

  // Group by customer, preserving first-seen order (same as the reference JSON).
  const byCustomer = new Map();
  entries.forEach(({ ctin, inv }) => {
    if (!byCustomer.has(ctin)) byCustomer.set(ctin, []);
    byCustomer.get(ctin).push(inv);
  });

  // Exact GSTR-1 structure accepted by the portal: gstin, fp, b2b.
  // (No "nm", "gt" or "cur_gt" — those aren't part of the portal schema.)
  const gstJson = {
    gstin: supplierGstin,
    fp,
    b2b: Array.from(byCustomer.entries()).map(([ctin, inv]) => ({ ctin, inv })),
  };

  const totalTaxable = round2(entries.reduce((s, e) => s + e.inv.itms.reduce((a, it) => a + it.itm_det.txval, 0), 0));
  return {
    json: gstJson,
    invoiceCount: entries.length,
    fp,
    warnings,
    summary: { customers: byCustomer.size, invoices: entries.length, totalTaxable, sheet: table.sheet },
  };
}

function readSheets(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (ext === 'csv') {
    const text = file.buffer.toString('utf-8').replace(/^﻿/, '');
    const parsed = Papa.parse(text, { header: false, skipEmptyLines: true });
    return { ext, sheets: [{ name: 'csv', rows: parsed.data }] };
  }
  // raw:true keeps real dates as Excel serial numbers so we can format them
  // ourselves as dd-mm-yyyy (raw:false gave locale strings like "4/1/26").
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  const sheets = wb.SheetNames.map(name => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }),
  }));
  return { ext, sheets };
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

    const reqFp = String(req.body.fp || '').trim();
    if (reqFp && !FP_REGEX.test(reqFp)) {
      return res.status(400).json({ error: 'Return period must be in MMYYYY format, e.g. 042026.' });
    }

    const { ext, sheets } = readSheets(req.file);
    if (!sheets.some(s => s.rows.length)) return res.status(400).json({ error: 'The file appears empty.' });

    const result = convertRows(sheets, supplierGstin, { fp: reqFp });
    const jsonText = toPortalJSON(result.json);

    const info = db.prepare(`
      INSERT INTO conversions (user_id, file_name, file_ext, invoice_count, gst_period, status, result_json)
      VALUES (?, ?, ?, ?, ?, 'success', ?)
    `).run(req.user.id, req.file.originalname, ext, result.invoiceCount, result.fp, jsonText);

    res.status(201).json({
      id: info.lastInsertRowid,
      json: result.json,
      jsonText,
      invoiceCount: result.invoiceCount,
      fp: result.fp,
      warnings: result.warnings,
      summary: result.summary,
      fileName: req.file.originalname,
    });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message, invalidRows: err.invalidRows });
    }
    console.error('Auto-convert error:', err);
    res.status(500).json({ error: 'Something went wrong converting this file. Please check the format and try again.' });
  }
});

module.exports = router;
module.exports.convertRows = convertRows;
module.exports.readSheets = readSheets;
module.exports.isValidGstin = isValidGstin;
