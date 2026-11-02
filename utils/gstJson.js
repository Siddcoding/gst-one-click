// Serialises a GSTR-1 object the same way the reference portal JSON is
// written: compact, and money fields that carry paise always shown with two
// decimals (3982.20, 358.40) while whole-rupee values stay plain (45536, 0).
// JSON.stringify would print 3982.2 — numerically the same, but this keeps the
// file byte-for-byte consistent with what the GST portal / Tally produce.

const AMOUNT_KEYS = new Set(['val', 'txval', 'iamt', 'camt', 'samt', 'csamt']);

function fmtAmount(n) {
  if (typeof n !== 'number' || !isFinite(n)) return JSON.stringify(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function toPortalJSON(value, key) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(v => toPortalJSON(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const parts = [];
    for (const k of Object.keys(value)) {
      if (value[k] === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + toPortalJSON(value[k], k));
    }
    return '{' + parts.join(',') + '}';
  }
  if (typeof value === 'number' && AMOUNT_KEYS.has(key)) return fmtAmount(value);
  return JSON.stringify(value);
}

module.exports = { toPortalJSON };
