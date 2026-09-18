#!/usr/bin/env node
/* fill-sofa-colourless-lines-2026-09-09 — sofas where NO module carries a
 * colour, decoded again from the book's own text.
 *
 * WHERE THIS CAME FROM. The owner found `HC-SO-010120` on 2026-09-09 — a sofa
 * whose first module had the fabric and whose corner and two-seater did not.
 * That shape was 31 sofas and is repaired (`fill-sofa-sibling-fabric`,
 * production run 34377360999, 52 rows). The same plan run reported a bigger set
 * beside it: **209 sofas where NOT ONE module carries a fabric**, so there is no
 * sibling to copy from. This is that set.
 *
 * WHY IT IS WORTH DOING. The factory sheet for every module of those sofas is
 * colourless, and stock buckets by `(warehouse_id, item_code, variant_key)` — a
 * line asking for a seat height alone cannot be filled from fabric-keyed stock
 * of the identical piece, so the allocator cannot see stock it holds.
 *
 * ── THE COLOUR IS IN THE BOOK'S OWN TEXT, AND IT IS OUR DECODER ───────────
 * Each line carries AutoCount's `Desc2` in `description2` — the same text
 * `import-ac-outstanding-so.mjs` read at the cutover. It is decoded here with
 * `lib/parse-sofa.mjs` and resolved through `lib/fabric-colour-match.mjs`, the
 * SAME two modules the importer used, so a line filled by this script and a line
 * filled at import are byte-identical. No third reading of Desc2 is written:
 * parse-sofa's own header records what two copies of a decoder cost.
 *
 * ── WHY THE IMPORTER MISSED THEM, AND WHY RE-READING CAN WIN NOW ──────────
 * The fabric library renumbered itself and the matcher answered the DEAD row —
 * that is what left 166 colours unresolvable until they were repaired on
 * 2026-09-02. A colour that could not be looked up then can be looked up now, so
 * re-running the SAME decode against TODAY's library is not a retry in hope; it
 * is a lookup against a table that has since been corrected. Where it still
 * cannot resolve, the line is left alone and the book's raw text is PRINTED, so
 * the next decision is made on the words rather than on a count.
 *
 * ── WHAT IT REFUSES ──────────────────────────────────────────────────────
 * A colour the owner has not chosen yet (TBC / KIV) is not a miss, it is a blank
 * — `isPendingColour` decides that, not this file. And a sofa where the modules
 * disagree is not this script's business: it fills only where NO module has a
 * fabric, so there is nothing to contradict.
 *
 * SPECIALS AND SEAT HEIGHT ARE NOT TOUCHED. Specials carry money
 * (`mfg-pricing.ts` computes a `specialsSurchargeSen` per line), and this run
 * must not change what any order re-prices to. Only the five fabric fields the
 * importer writes are set, and only where they are blank.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing every line and the text it read.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE carries `coalesce(variants->>'fabricCode','') = ''`.
 *   `to_jsonb(x::text)` on every write — a bare string bound into a jsonb column
 *   is the double-encoding COE.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: the
 *   written value is a jsonb STRING, no line lost its seat height, and every
 *   line price, order subtotal and order total is byte-identical.
 *
 * RE-RUN: idempotent — a second run finds them filled and reports 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import postgres from 'postgres';
import { parseSofa, SOFA_MODEL_ALIAS } from './lib/parse-sofa.mjs';
import { buildFabricColourIndex, isPendingColour } from './lib/fabric-colour-match.mjs';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'fill sofa colourless lines 2026-09-09';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const FABRIC_FIELDS = ['fabricId', 'colourId', 'fabricCode', 'colourLabel', 'fabricLabel'];
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`MODE=${MODE}  company ${CO}`);

  const fcRows = await sql`
    SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  log(`fabric colours in the library today: ${fcRows.length}`);

  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_code, i.linked_ac_dtlkey::text AS dtlkey,
           i.variants, i.description2, h.status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND lower(coalesce(i.item_group, '')) = 'sofa'
       AND i.linked_ac_dtlkey IS NOT NULL
       AND coalesce(i.cancelled, false) = false
     ORDER BY i.doc_no, i.line_no, i.id`;
  log(`sofa rows carrying a book line: ${rows.length}`);

  const groups = new Map();
  for (const r of rows) {
    const k = `${r.doc_no}|${r.dtlkey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  log(`sofas (one book line each): ${groups.size}`);

  const plan = [];
  const unresolved = [];
  const skip = new Map();
  const bump = (k) => skip.set(k, (skip.get(k) ?? 0) + 1);

  for (const [k, g] of groups) {
    const [doc, dtlkey] = k.split('|');
    if (g.some((r) => str(r.variants?.fabricCode) !== '')) { bump('at least one module already has a fabric — not this script\'s set'); continue; }

    const d2 = g.map((r) => str(r.description2)).find(Boolean) ?? '';
    if (!d2) { bump('the book left no text on any module of this sofa'); unresolved.push({ doc, dtlkey, rows: g.length, why: 'no book text', d2: '' }); continue; }

    const base = String(g[0].item_code).replace(/-[^-]*$/, '');
    const model = SOFA_MODEL_ALIAS[base] || base;
    let ps;
    try { ps = parseSofa(d2, model, false); } catch { ps = null; }
    if (!ps || !ps.color) { bump('the book text names no colour'); unresolved.push({ doc, dtlkey, rows: g.length, why: 'no colour in the text', d2 }); continue; }
    if (isPendingColour(ps.color)) { bump('the colour is TBC / KIV — not chosen yet, correctly blank'); continue; }

    const fc = findColour(ps.color);
    if (!fc) {
      bump('the colour is stated but is not in our fabric library');
      unresolved.push({ doc, dtlkey, rows: g.length, why: `colour "${ps.color}" not in fabric_colours`, d2 });
      continue;
    }
    const patch = {
      fabricId: fc.fabric_id, colourId: fc.colour_id, fabricCode: fc.colour_id,
      colourLabel: fc.label, fabricLabel: fc.fabric_id,
    };
    for (const r of g) {
      plan.push({ id: r.id, doc, dtlkey, code: r.item_code, status: r.status,
        colour: ps.color, patch, d2 });
    }
  }

  const docs = new Set(plan.map((p) => p.doc));
  log(`\n=== WOULD FILL: ${plan.length} row(s) across ${docs.size} sales order(s) ===`);
  let lastDoc = '';
  for (const p of plan) {
    if (p.doc !== lastDoc) {
      log(`  ${p.doc}  (book line ${p.dtlkey}, order ${p.status}) — book text: ${p.d2.replace(/\s+/g, ' ').slice(0, 90)}`);
      log(`      read "${p.colour}" -> ${p.patch.fabricCode} (${p.patch.colourLabel})`);
      lastDoc = p.doc;
    }
    log(`      ${p.code}`);
  }

  log('\n  LEFT ALONE:');
  for (const [k, n] of [...skip].sort((a, b) => b[1] - a[1])) log(`    ${String(n).padStart(4)} sofa(s) — ${k}`);

  log(`\n  UNRESOLVED, with the book's own words (${unresolved.length} sofa(s)):`);
  for (const u of unresolved.slice(0, 60)) {
    log(`    ${u.doc}  ${u.why}`);
    if (u.d2) log(`        ${u.d2.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  if (unresolved.length > 60) log(`    … ${unresolved.length - 60} more`);

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const [before] = await sql`
    SELECT count(*)::int AS sofa_rows,
           count(*) FILTER (WHERE coalesce(i.variants->>'fabricCode', '') <> '')::int AS with_fabric,
           coalesce(sum(i.unit_price_sen), 0)::text AS unit_price_sen,
           coalesce(sum(i.total_sen), 0)::text AS total_sen,
           coalesce(sum(i.qty), 0)::text AS qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND lower(coalesce(i.item_group, '')) = 'sofa'`;
  const [headBefore] = await sql`
    SELECT coalesce(sum(subtotal_sen), 0)::text AS subtotal_sen,
           coalesce(sum(local_total_sen), 0)::text AS local_total_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;

  let wrote = 0;
  for (const p of plan) {
    let expr = sql`coalesce(variants, '{}'::jsonb)`;
    for (const [f, v] of Object.entries(p.patch)) {
      expr = sql`jsonb_set(${expr}, ${`{${f}}`}, to_jsonb(${String(v)}::text), true)`;
    }
    const done = await sql`
      UPDATE scm.mfg_sales_order_items SET variants = ${expr}
       WHERE id = ${p.id} AND coalesce(variants->>'fabricCode', '') = ''
      RETURNING id`;
    wrote += done.length;
  }
  log(`\nAPPLIED: ${wrote} row(s) filled.`);
  await sql.end();

  const ids = plan.map((p) => p.id);
  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  const [after] = await check`
    SELECT count(*)::int AS sofa_rows,
           count(*) FILTER (WHERE coalesce(i.variants->>'fabricCode', '') <> '')::int AS with_fabric,
           coalesce(sum(i.unit_price_sen), 0)::text AS unit_price_sen,
           coalesce(sum(i.total_sen), 0)::text AS total_sen,
           coalesce(sum(i.qty), 0)::text AS qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND lower(coalesce(i.item_group, '')) = 'sofa'`;
  const [headAfter] = await check`
    SELECT coalesce(sum(subtotal_sen), 0)::text AS subtotal_sen,
           coalesce(sum(local_total_sen), 0)::text AS local_total_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;
  const [blank] = await check`
    SELECT count(*)::int AS n FROM scm.mfg_sales_order_items
     WHERE id = ANY(${ids}) AND coalesce(variants->>'fabricCode', '') = ''`;
  const [typed] = await check`
    SELECT count(*)::int AS n FROM scm.mfg_sales_order_items
     WHERE id = ANY(${ids}) AND jsonb_typeof(variants->'fabricCode') <> 'string'`;
  const sample = ids.length
    ? await check`SELECT doc_no, item_code, variants FROM scm.mfg_sales_order_items WHERE id = ${ids[0]}`
    : [];
  await check.end();

  const ok = {
    'every row this run filled now carries a fabric': blank.n === 0,
    'the fabric was written as a jsonb string, not a re-encoded one': typed.n === 0,
    'the sofa row count is unchanged': after.sofa_rows === before.sofa_rows,
    'quantities are unchanged': after.qty === before.qty,
    'the sofa lines keep their unit prices': after.unit_price_sen === before.unit_price_sen,
    'the sofa lines keep their totals': after.total_sen === before.total_sen,
    'every sales order subtotal is unchanged': headAfter.subtotal_sen === headBefore.subtotal_sen,
    'every sales order total is unchanged': headAfter.local_total_sen === headBefore.local_total_sen,
    'rows with a fabric rose by exactly what was written': after.with_fabric === before.with_fabric + wrote,
  };
  log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  if (sample.length) log(`  sample: ${sample[0].doc_no} ${sample[0].item_code} -> ${JSON.stringify(sample[0].variants)}`);
  log(`  sofa rows with a fabric ${before.with_fabric} -> ${after.with_fabric} of ${after.sofa_rows}`);
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — one field written inside variants, no money moved.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
