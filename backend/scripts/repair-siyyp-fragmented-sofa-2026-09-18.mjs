#!/usr/bin/env node
/* ONE order's sofa was stored FRAGMENTED, so its purchase-order PDF drew only
   the L piece and captioned it from a stale summary. Re-attach the keyless
   modules to the geometry so all three draw, and correct the stale summary.
   Owner 2026-09-18, PO 2990-PO-2609-030 / SO 2990-SO-2608-040 (Option C).

   THE SHAPE (proven read-only against prod anogrigyjbduyzclzjgn, 2026-09-18).
   The SIYYP sofa is three lines, and only ONE carries POS build geometry:

     line  item_code           buildKey  x/y/summary
     0/1   SIYYP-L(LHF)        build-1   x0 y0, summary "L(LHF) + 2A(RHF) ..."
     1/2   SIYYP-1A(P)(RHF)    (none)    none
     3/3   SIYYP-1NA           (none)    none

   purchase-order-pdf.ts groups sofa cells by variants.summary and only draws a
   line that carries x/y. The two keyless lines carry neither, so they never
   join the L's group and never draw; the L's own stale summary ("2A(RHF)",
   which is on no line) becomes the caption. This is the only order on prod with
   a base model split across a keyed build line and keyless lines (3 SOs matched
   a looser query; the other two are `2S + HEADREST` and draw correctly).

   THE REPAIR (Option C-durable, owner-confirmed). For BOTH the SO items and the
   copied PO items, on the two keyless sofa lines MERGE the geometry a
   left-to-right default layout gives them (buildDefaultSofaCells, the same code
   the PDF reconstructs with), and set the SAME corrected summary on all three
   so they form one group. The correct summary's COMPOSITION and the drawing
   order follow the CURRENT line order (owner left the old SKU ordering as-is:
   L(LHF) + 1A(P)(RHF) + 1NA). buildKey is NOT added or changed — the SO display
   fold needs it, so leaving it keeps the SO listing at three lines and touches
   no pricing / DO-picking path (those key on buildKey / cells). line_no is NOT
   changed. Every non-geometry field (fabric, colour, leg, seat) is preserved.

   RESEQUENCE=1 (default off) instead orders the drawing + summary by handedness
   (L(LHF) -> 1NA -> 1A(P)(RHF)); it is held pending the owner's answer on
   whether to also correct THIS one order's sequence, and it does NOT touch
   line_no either (the SKU line order is the owner's separate, declined change).

   MODE=plan (default) prints every row's before/after and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one row at a
   time with $::text::jsonb (never a serializer near a jsonb bind — the
   double-encoding lesson, docs/jsonb-double-encoding-coe.md), and re-reads on a
   fresh connection asserting the SHAPE: every sofa line carries x/y, they share
   one summary, and none still names 2A(RHF).

   RE-RUN: idempotent. A row already carrying the target geometry + summary is
   reported unchanged and rewritten to the identical object. */
import postgres from 'postgres';
import { buildDefaultSofaCells, findModule } from '../src/scm/shared/sofa-build.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const RESEQUENCE = process.env.RESEQUENCE === '1';
const SO_DOC = process.env.SO_DOC || '2990-SO-2608-040';
const PO_DOC = process.env.PO_DOC || '2990-PO-2609-030';
const DEPTH = process.env.DEPTH || '24';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** Module code = the SOFA_MODULES suffix an item_code ends with (longest match). */
const KNOWN = [
  '1A(P)(LHF)', '1A(P)(RHF)', '1A(R)(LHF)', '1A(R)(RHF)', '1A(L)(LHF)', '1A(L)(RHF)',
  '1A(LHF)', '1A(RHF)', '1B(LHF)', '1B(RHF)', '2A(LHF)', '2A(RHF)', '2B(LHF)', '2B(RHF)',
  'L(LHF)', 'L(RHF)', '1NA(P)', '1NA(R)', '1NA(L)', '1NA', '2NA',
  '1S(P)', '1S(R)', '1S(L)', '1S', '2S', '3S', 'CNR', 'Console', 'STOOL',
].sort((a, b) => b.length - a.length);
const moduleOf = (itemCode) => KNOWN.find((id) => (itemCode ?? '').endsWith(id)) ?? null;

/** Split a summary into [composition, ...tail] on " · ". */
const summaryTail = (summary) => {
  const parts = String(summary ?? '').split('·').map((s) => s.trim());
  return parts.slice(1).filter(Boolean); // everything after the composition
};

/** Compute the target variants for each row of one group (pure). */
function planGroup(rows) {
  const known = rows.filter((r) => r.module && findModule(r.module));
  const unknown = rows.filter((r) => !(r.module && findModule(r.module)));
  // Drawing / composition order: current line order, or handedness when RESEQUENCE.
  const ordered = RESEQUENCE
    ? [...known].sort((a, b) => hand(a.module) - hand(b.module) || 0)
    : known;
  const composition = ordered.map((r) => r.module).join(' + ');
  // Tail from whichever line already carries a summary (they all get the same).
  const lead = rows.find((r) => String(JSON.parse(r.raw).summary ?? '').trim() !== '');
  const tail = summaryTail(lead ? JSON.parse(lead.raw).summary : '');
  const newSummary = [composition, ...tail].join(' · ');
  // Geometry from the same default layout the PDF reconstructs with.
  const cells = buildDefaultSofaCells(ordered.map((r) => ({ moduleId: r.module })), DEPTH);
  const geoByModule = new Map(cells.map((c) => [c.moduleId, c]));
  const out = [];
  for (const r of ordered) {
    const c = geoByModule.get(r.module);
    const target = { ...r.variants, summary: newSummary };
    if (c) { target.x = c.x; target.y = c.y; target.rot = c.rot; target.cellIndex = c.cellIndex; }
    out.push({ row: r, target, note: 'geometry + summary' });
  }
  for (const r of unknown) out.push({ row: r, target: null, note: `SKIPPED — ${r.module ? 'no spec' : 'unrecognised code'} (${r.item_code})` });
  return out;
}

/** Handedness rank for RESEQUENCE only. */
const hand = (id) => {
  const u = String(id).toUpperCase();
  if (u.includes('(LHF)')) return 0;
  if (u.includes('(RHF)')) return 2;
  return 1;
};

const shortJson = (o) => JSON.stringify(o).slice(0, 260);

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} reseq=${RESEQUENCE} depth=${DEPTH}`);
  note(`SO=${SO_DOC} PO=${PO_DOC}`);

  const groups = [
    { label: 'SO', table: 'mfg_sales_order_items', docVal: SO_DOC },
    { label: 'PO', table: 'purchase_order_items', docVal: PO_DOC },
  ];

  const writes = [];
  for (const g of groups) {
    // The SO items reference the header by doc_no (a text column, not a fk id);
    // the PO items reference it by purchase_order_id. Read each accordingly.
    let rows;
    if (g.label === 'SO') {
      const r = await sql.unsafe(
        `SELECT id::text AS id, item_code, line_no, company_id, variants::text AS raw
           FROM scm.mfg_sales_order_items
          WHERE doc_no = $1 AND item_group = 'sofa'
          ORDER BY line_no NULLS FIRST, created_at, id`, [g.docVal]);
      rows = r.map((x) => ({ ...x, variants: JSON.parse(x.raw), module: moduleOf(x.item_code) }));
    } else {
      const r = await sql.unsafe(
        `SELECT pi.id::text AS id, pi.item_code, pi.line_no, pi.company_id, pi.variants::text AS raw
           FROM scm.purchase_order_items pi
           JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
          WHERE p.po_number = $1 AND pi.item_group = 'sofa'
          ORDER BY pi.line_no NULLS FIRST, pi.created_at, pi.id`, [g.docVal]);
      rows = r.map((x) => ({ ...x, variants: JSON.parse(x.raw), module: moduleOf(x.item_code) }));
    }

    note(`\n=== ${g.label} ${g.docVal} — ${rows.length} sofa line(s) ===`);
    if (rows.length === 0) { bad(`  no sofa lines found for ${g.label} ${g.docVal}`); continue; }

    const plan = planGroup(rows);
    for (const p of plan) {
      const idLabel = `${p.row.item_code} (line ${p.row.line_no ?? 'NULL'}, ${p.row.id})`;
      if (!p.target) { note(`  ${idLabel}: ${p.note}`); continue; }
      const changed = JSON.stringify(p.row.variants) !== JSON.stringify(p.target);
      note(`  ${idLabel}: ${changed ? 'CHANGE' : 'already correct'}`);
      note(`      before: ${shortJson(p.row.variants)}`);
      note(`      after:  ${shortJson(p.target)}`);
      if (changed) writes.push({ table: g.table, ...p });
    }
  }

  note(`\n  rows to change: ${writes.length}`);
  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (writes.length === 0) { note(`\nNothing to write.`); await sql.end({ timeout: 5 }); return; }

  note(`\n=== WRITING ${writes.length} ROW(S) ===`);
  let wrote = 0;
  for (const w of writes) {
    const back = await sql.unsafe(
      `UPDATE scm.${w.table} SET variants = $2::text::jsonb
        WHERE id = $1 AND company_id = $3
       RETURNING id::text AS id`, [w.row.id, JSON.stringify(w.target), w.row.company_id]);
    wrote += back.length;
    note(`  ${back.length ? 'OK ' : 'SKIP'} ${w.table} ${w.row.item_code} ${w.row.id}`);
  }
  note(`  written: ${wrote} of ${writes.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION (shape, not count) ===`);
    for (const [label, table, join, val] of [
      ['SO', 'mfg_sales_order_items', '', SO_DOC],
      ['PO', 'purchase_order_items', 'JOIN scm.purchase_orders p ON p.id = i.purchase_order_id', PO_DOC],
    ]) {
      const where = table === 'purchase_order_items' ? 'p.po_number = $1' : 'i.doc_no = $1';
      const rows = await check.unsafe(
        `SELECT i.item_code,
                (i.variants ? 'x') AS has_x,
                (i.variants ? 'y') AS has_y,
                i.variants->>'summary' AS summary
           FROM scm.${table} i ${join}
          WHERE ${where} AND i.item_group = 'sofa'
          ORDER BY i.line_no NULLS FIRST, i.created_at, i.id`, [val]);
      const summaries = new Set(rows.map((r) => r.summary));
      const missingGeo = rows.filter((r) => !r.has_x || !r.has_y).map((r) => r.item_code);
      const stale = rows.filter((r) => String(r.summary ?? '').includes('2A(RHF)')).map((r) => r.item_code);
      note(`  ${label} ${val}: ${rows.length} sofa line(s); distinct summaries=${summaries.size}; missing geometry=[${missingGeo.join(', ') || 'none'}]; still-names-2A(RHF)=[${stale.join(', ') || 'none'}]`);
      if (missingGeo.length) bad(`  ${label}: ${missingGeo.length} sofa line(s) still carry no geometry`);
      if (stale.length) bad(`  ${label}: ${stale.length} sofa line(s) still name 2A(RHF)`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
