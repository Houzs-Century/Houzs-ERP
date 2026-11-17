#!/usr/bin/env node
/* Give existing service cases the Postcode / City / State of the Sales Order
   they were raised against (owner 2026-11-17: the case holds its address in the
   SO's shape). Migration 20261117T2200_assr_case_address.sql created the 1:1
   table empty; new cases and every SO No. correction fill it from the SO. This
   fills the old ones.

   WHAT IT COPIES. For each case with NO assr_case_address row, the linked ERP
   order (scm.mfg_sales_orders, exact doc_no first, then linked_ac_docno — the
   same match Delivery Planning and the delivery sheet already use) lends its
   postcode / city / customer_state. Only the three new fields are written; the
   case's address LINES (assr_cases.addr1..addr4) are never touched, so nothing
   anyone typed is lost.

   WHAT IT REFUSES, printed per case, written for none:
     - no linked order, or the order has none of the three values;
     - the case's own lines name a postcode the order does not have ("a service
       address is not always the delivery address", delivery-sheet-assr-feed.ts):
       the order's town would describe another place.

   MODE=plan (default) prints every case it would fill and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", inserts one row per
   case (ON CONFLICT DO NOTHING, so a row an operator saved meanwhile wins), and
   re-reads every written case on a FRESH connection, asserting its row now holds
   exactly the order's values.

   Optional LIMIT=<n> caps one run.

   RE-RUN: inert. Keyed on "no assr_case_address row yet"; a filled case drops
   out, and a refused case stays refused until its address changes. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const LIMIT = Math.max(1, Math.min(100000, Number(process.env.LIMIT || 100000)));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const tidy = (v) => {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s ? s : null;
};

/** The values to write, or why the case is refused. Pure. */
function decide(r) {
  const postcode = tidy(r.so_postcode), city = tidy(r.so_city), state = tidy(r.so_state);
  if (!r.so_doc_no) return { ok: false, why: 'no linked order' };
  if (!postcode && !city && !state) return { ok: false, why: `order ${r.so_doc_no} has no postcode / city / state` };
  const named = [r.addr1, r.addr2, r.addr3, r.addr4].flatMap((v) => (tidy(v) ?? '').match(/\b\d{5,6}\b/g) ?? []);
  if (named.length && (!postcode || !named.includes(postcode))) {
    return { ok: false, why: `the case's lines name postcode ${named.join('/')}, the order ${postcode ?? 'none'}` };
  }
  return { ok: true, postcode, city, state };
}

const CANDIDATES = `
  SELECT c.id::text AS id, c.assr_no, c.doc_no, c.addr1, c.addr2, c.addr3, c.addr4,
         so.doc_no AS so_doc_no, so.postcode AS so_postcode, so.city AS so_city, so.customer_state AS so_state
    FROM public.assr_cases c
    LEFT JOIN LATERAL (
         SELECT o.doc_no, o.postcode, o.city, o.customer_state
           FROM scm.mfg_sales_orders o
          WHERE o.doc_no = c.doc_no OR o.linked_ac_docno = c.doc_no
          ORDER BY (o.doc_no = c.doc_no) DESC
          LIMIT 1) so ON TRUE
   WHERE NOT EXISTS (SELECT 1 FROM public.assr_case_address a WHERE a.assr_id = c.id)
   ORDER BY c.id
   LIMIT ${LIMIT}`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} limit=${LIMIT}`);
  const rows = await sql.unsafe(CANDIDATES);
  const fill = [], refuse = [];
  for (const r of rows) {
    const d = decide(r);
    if (d.ok) fill.push({ ...r, ...d });
    else refuse.push({ ...r, why: d.why });
  }
  note(`\n=== CASES WITH NO POSTCODE / CITY / STATE YET: ${rows.length} ===`);
  for (const r of fill) note(`  ${r.assr_no} (${r.doc_no}) <- ${r.so_doc_no}: ${r.postcode ?? '-'} / ${r.city ?? '-'} / ${r.state ?? '-'}`);
  for (const r of refuse) note(`  ${r.assr_no} (${r.doc_no}) REFUSED — ${r.why}`);
  note(`\n  to fill: ${fill.length}   refused: ${refuse.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== FILLING ${fill.length} CASE(S) ===`);
  const written = [];
  for (const r of fill) {
    const back = await sql.unsafe(
      `INSERT INTO public.assr_case_address (assr_id, postcode, city, state)
       VALUES ($1::bigint, $2, $3, $4)
       ON CONFLICT (assr_id) DO NOTHING
       RETURNING assr_id::text AS id`, [r.id, r.postcode, r.city, r.state]);
    if (back.length) written.push(r);
    note(`  ${back.length ? 'OK  ' : 'SKIP (saved meanwhile)'} ${r.assr_no}`);
  }
  note(`  written: ${written.length} of ${fill.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let wrong = 0;
    for (const r of written) {
      const [row] = await check.unsafe(
        `SELECT postcode, city, state FROM public.assr_case_address WHERE assr_id = $1::bigint`, [r.id]);
      const same = row && row.postcode === r.postcode && row.city === r.city && row.state === r.state;
      if (!same) { wrong += 1; bad(`  ${r.assr_no}: reads ${JSON.stringify(row ?? null)}, expected ${r.postcode}/${r.city}/${r.state}`); }
    }
    note(`  ${written.length - wrong} of ${written.length} written case(s) read back exactly the order's postcode / city / state`);
    if (wrong) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
