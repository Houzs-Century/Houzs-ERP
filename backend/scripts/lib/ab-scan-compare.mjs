// Field comparison for the scan-model A/B (scripts/ab-scan-model.mjs). Pure, so a test can pin it.

const FIELDS = [
  ['customerName', 'text'],
  ['phone', 'phone'],
  ['deliveryDate', 'date'],
  ['slipDate', 'date'],
  ['totalRm', 'money'],
  ['depositRm', 'money'],
  ['customerSoRef', 'text'],
  ['postcode', 'text'],
];

const text = (v) => (v == null ? null : String(v).toLowerCase().replace(/\s+/g, ' ').trim() || null);
const phone = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d ? d.slice(-9) : null;
};
const date = (v) => {
  const m = String(v ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};
const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const NORM = { text, phone, date, money };

function pick(o, field) {
  if (field === 'phone') return Array.isArray(o?.phones) ? o.phones[0] : null;
  return o?.[field];
}

/** Compare one model read with the operator-confirmed slip. A field the truth leaves empty is not scored. */
export function compareSlip(read, truth) {
  const out = {};
  for (const [field, kind] of FIELDS) {
    const t = NORM[kind](pick(truth, field));
    if (t == null) continue;
    const r = NORM[kind](pick(read, field));
    out[field] = kind === 'money' ? r != null && Math.abs(r - t) < 0.5 : r === t;
  }
  const tl = Array.isArray(truth?.lines) ? truth.lines.length : null;
  if (tl != null) out.lineCount = (Array.isArray(read?.lines) ? read.lines.length : -1) === tl;
  return out;
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Roll per-sample results up: accuracy per field, overall, and latency. */
export function summarise(results) {
  const per = {};
  let ok = 0;
  let all = 0;
  for (const r of results) for (const [f, hit] of Object.entries(r.cmp)) {
    per[f] ??= { ok: 0, n: 0 };
    per[f].n += 1;
    all += 1;
    if (hit) { per[f].ok += 1; ok += 1; }
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    calls: results.length,
    overall: all ? ok / all : null,
    perField: Object.fromEntries(Object.entries(per).map(([f, v]) => [f, `${v.ok}/${v.n}`])),
    ms: { median: percentile(ms, 50), p90: percentile(ms, 90), mean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null },
  };
}
