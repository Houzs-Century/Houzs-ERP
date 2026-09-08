#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. What does the ERP hold for the sofa lines the ACCOUNT BOOK cannot
// answer?
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The AutoCount reconcile ends 110 migrated sales orders with the verdict
// `sofa build not verifiable`: the line is KEYED, both sides agree on colour,
// size and money, but the book's own Desc2 never states how the sofa is put
// together — `Size:24"/Col:BO315-7 Peach/Bottom wrap nylon/Seater depth +1"` is
// a whole build text with no build in it. The reconcile is right to refuse: it
// cannot compare a build the book does not state.
//
// The DRAWING on the order slip states it, and the owner reads those. Before
// anyone can PROPOSE a build from a drawing, the proposal has to be set against
// what the ERP is holding today — otherwise a "proposal" that changes nothing
// and a proposal that rebuilds the sofa look identical on the page.
//
// This script answers exactly that and nothing else: for each AutoCount DtlKey
// given, the ERP compartment pieces of that one book line, whether the order is
// proceeded, and whether the line carries a photograph.
//
// IT WRITES NOTHING. SELECTs only, no DDL, no transaction — the CLAUDE.md rule
// for anything that reads production.
//
// ── PRIVACY ─────────────────────────────────────────────────────────────────
// This repository and its Actions logs are PUBLIC. Printed: document numbers,
// AutoCount line keys, and sofa COMPARTMENT CODES (`8030-2A(LHF)` — a Houzs
// product code, which check-ac-erp-reconcile.mjs already prints on this same
// population). NOT printed: customer, address, colour, price, or any amount.
//
//   DATABASE_URL   required
//   COMPANY        default 1 (AED_HOUZS)
//   DTLKEYS        comma/space/newline separated AutoCount DtlKeys, or
//   DTLKEYS_FILE   a file holding them (one per line; `#` comments allowed)
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import postgres from 'postgres';
import fs from 'node:fs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const CO = Number(process.env.COMPANY ?? 1);
const log = (m = '') => console.log(m);

function wantedKeys() {
  const raw = process.env.DTLKEYS_FILE
    ? fs.readFileSync(process.env.DTLKEYS_FILE, 'utf8')
    : (process.env.DTLKEYS ?? '');
  return [...new Set(
    raw.split('\n').map((l) => l.replace(/#.*/, '')).join(' ')
      .split(/[\s,]+/).filter((t) => /^\d+$/.test(t)),
  )];
}

const keys = wantedKeys();
if (!keys.length) { console.error('DTLKEYS or DTLKEYS_FILE required (AutoCount DtlKeys)'); process.exit(2); }

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

/* The compartment half of a sofa SKU. `{model}-{comp}` is the shape the cutover
   writes (backend/scripts/lib/parse-sofa.mjs); a code that is not in that shape
   is printed WHOLE rather than guessed at. */
const compOf = (code) => {
  const s = String(code ?? '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(i + 1) : s;
};
const modelOf = (code) => {
  const s = String(code ?? '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
};

try {
  const rows = await sql`
    SELECT h.doc_no                                   AS erp_no,
           h.linked_ac_docno                          AS ac_no,
           UPPER(COALESCE(h.status::text, ''))        AS status,
           (h.proceeded_at IS NOT NULL)               AS proceeded,
           i.linked_ac_dtlkey::text                   AS dtl,
           i.line_no,
           i.item_code,
           i.item_group,
           i.qty::float8                              AS qty,
           i.cancelled,
           COALESCE(array_length(i.photo_urls, 1), 0) AS pics
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND i.linked_ac_dtlkey IS NOT NULL
       AND i.linked_ac_dtlkey::text = ANY(${keys})
     ORDER BY h.doc_no, i.line_no`;

  const byDtl = new Map();
  for (const r of rows) {
    if (!byDtl.has(r.dtl)) byDtl.set(r.dtl, []);
    byDtl.get(r.dtl).push(r);
  }

  log(`asked about ${keys.length} AutoCount line key(s); ${byDtl.size} of them resolve to an ERP sales-order line on company ${CO}.`);
  log('');
  log('dtlKey | ERP doc | book doc | status | proceeded | photos | model | pieces the ERP holds for this ONE book line');
  for (const k of keys) {
    const g = byDtl.get(k);
    if (!g) { log(`${k} | (no ERP line carries this AutoCount line key)`); continue; }
    const live = g.filter((r) => !r.cancelled);
    const h = g[0];
    const model = [...new Set(live.map((r) => modelOf(r.item_code)))].join('/') || '-';
    /* A MULTISET, printed sorted, because the owner's rule is that order does
       not decide a build — two lists differing only in order are the same sofa. */
    const pieces = live.map((r) => compOf(r.item_code) + (r.qty !== 1 ? ` x${r.qty}` : '')).sort().join(' + ') || '(none live)';
    const dead = g.length - live.length;
    log(`${k} | ${h.erp_no} | ${h.ac_no ?? '-'} | ${h.status} | ${h.proceeded ? 'yes' : 'no'} | ${live.reduce((s, r) => s + r.pics, 0)} | ${model} | ${pieces}${dead ? `   (+${dead} cancelled line(s))` : ''}`);
  }

  const missing = keys.filter((k) => !byDtl.has(k));
  log('');
  log(`resolved ${byDtl.size}; unresolved ${missing.length}${missing.length ? `: ${missing.join(' ')}` : ''}`);
} finally {
  await sql.end({ timeout: 5 });
}
