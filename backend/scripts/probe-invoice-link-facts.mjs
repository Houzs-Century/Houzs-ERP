#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. NAMES THE ROWS BEHIND THE FIVE WRONG INVOICE LINKS, AND TESTS THE
// TWO THINGS docs/bugs/0672 LEFT AS COUNTS AND AS UNKNOWN.
//
// WHERE THIS COMES FROM. probe-link-identity.mjs (runs 34137796488 at 23:22 and
// 34139187692 at 23:37 local, 2026-09-07, both `success`) counted, on the two
// invoice chains, links that are FILLED, do NOT dangle, and name a DIFFERENT
// PRODUCT:
//
//     sales_invoice_items.do_item_id      2 wrong of 182 linked of 182 rows
//     purchase_invoice_items.grn_item_id  3 wrong of 198 linked of 198 rows
//
// A COUNT CANNOT BE REPAIRED. Before a row is changed somebody has to be able
// to say WHICH invoice, WHICH source document, WHICH lines, what the two sides
// each say, and whether a correct parent even exists to re-point to. That is
// this file. It writes nothing.
//
// WHY THE MONEY MATTERS ON BOTH CHAINS, and it is not the invoice's face value:
//   * `sales_invoice_items.do_item_id` is the term `invoiced` in
//     remaining = delivered - invoiced - returned (lib/do-line-remaining.ts),
//     the cap every DO -> Sales Invoice write path is checked against
//     (migration 0303 says so in its own header). A wrong link spends one DO
//     line's remaining allowance on a different product's line: the wrong line
//     reads over-invoiced and the right line reads never-invoiced.
//   * `purchase_invoice_items.grn_item_id` is how a supplier invoice's money
//     reaches the LOT it paid for (lib/recost.ts aggregates PI lines BY
//     grn_item_id and re-costs that receipt), and `grn_items.invoiced_qty` is a
//     stored counter on the same key. A wrong link books one receipt's cost
//     onto another receipt's stock.
//
// THREE MORE QUESTIONS, all of them things 0672 could not settle:
//
//   C  THE 12 COLOUR DISAGREEMENTS. 0672 measured them through
//      `coalesce(variants->>'colourId', variants->>'colourLabel',
//      variants->>'colourCode')` — a COALESCE across three DIFFERENT
//      vocabularies. import-ac-outstanding-so.mjs writes colourId+colourLabel
//      together at :304 and colourLabel ALONE at :317, so a row from the second
//      path compared against a row from the first compares a colour ID against
//      a human label and disagrees BY CONSTRUCTION. This section prints all
//      three fields on both sides and resolves each through scm.fabric_colours,
//      so "different colour" can be told apart from "different field".
//   D  THE SHARED AutoCount LINE KEY. 296 sales-order and 98 purchase-order
//      DtlKeys are carried by more than one ERP row. 0672's discriminator
//      ("do they name different products?") answered 295/296 and 98/98 and was
//      worthless, because a sofa's compartments DO name different products
//      (MODEL-1S, MODEL-CNR). The right test is whether each group is ONE model
//      decomposed into compartments: one model text, and every suffix a known
//      compartment (services/autocount-sofa-collapse.ts is the module that
//      expects exactly this shape). Groups that fail are candidate collisions.
//   E  WHETHER A CORRECT PARENT EXISTS. For each wrong link, every line of the
//      parent document and of the document the invoice HEADER names, with the
//      claim each already carries. A repair is only safe when it is FORCED.
//
// PRIVACY. This repository and its Actions logs are PUBLIC. Document numbers
// and item codes ARE printed — the repair cannot be reviewed without them, and
// docs/bugs/0672 already publishes both. Quantities and line money are printed
// for the five wrong rows ONLY, because the money consequence is the question
// being asked. NO customer or supplier NAME is printed anywhere.
//
// NOTHING IS WRITTEN. SELECTs only. No DDL, no transaction, no temp table.
//
//   DATABASE_URL   required
//
// RE-RUN: idempotent and side-effect free. Safe to run any number of times.
// After a repair it should report zero wrong links; that is its second job.
// ----------------------------------------------------------------------------
import postgres from 'postgres';
import { decomposeGroup } from './lib/sofa-compartment-suffixes.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(2);
}
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Same normalisation as so-link-item-identity.ts and normItemCode: trimmed,
   upper-cased, inner whitespace collapsed. Anything looser hides a real
   mismatch; anything stricter reports formatting as a wrong product. */
const NORM = (e) => `upper(regexp_replace(btrim(coalesce(${e}, '')), '\\s+', ' ', 'g'))`;
const norm = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

const money = (sen) => (sen == null ? '(null)' : (Number(sen) / 100).toFixed(2));

/* ---------------------------------------------------------------- A + B + E */

async function wrongLinks() {
  log('=== A. SALES INVOICE -> DELIVERY ORDER: the line named is a different product ===');
  log('');
  const si = await sql.unsafe(`
    SELECT si.invoice_number     AS inv_no,
           si.status::text       AS inv_status,
           si.delivery_order_id  AS header_do_id,
           hdo.do_number         AS header_do_no,
           sii.id                AS line_id,
           sii.line_no           AS line_no,
           sii.item_code         AS inv_code,
           sii.qty               AS inv_qty,
           sii.unit_price_sen    AS inv_unit_sen,
           sii.line_total_sen    AS inv_total_sen,
           doi.line_no           AS parent_line_no,
           doi.item_code         AS parent_code,
           doi.qty               AS parent_qty,
           pdo.id                AS parent_doc_id,
           pdo.do_number         AS parent_doc_no,
           pdo.status::text      AS parent_status
      FROM scm.sales_invoice_items   sii
      JOIN scm.sales_invoices        si  ON si.id  = sii.sales_invoice_id
      JOIN scm.delivery_order_items  doi ON doi.id = sii.do_item_id
      JOIN scm.delivery_orders       pdo ON pdo.id = doi.delivery_order_id
      LEFT JOIN scm.delivery_orders  hdo ON hdo.id = si.delivery_order_id
     WHERE ${NORM('sii.item_code')} <> ${NORM('doi.item_code')}
     ORDER BY si.invoice_number, sii.line_no`);
  log(`${si.length} sales-invoice line(s) name a delivery line for a different product.`);
  log('');
  for (const r of si) {
    log(`  INVOICE ${r.inv_no} [${r.inv_status}] line ${r.line_no ?? '?'}`);
    log(`     invoice line says : ${r.inv_code}  qty ${r.inv_qty}  unit ${money(r.inv_unit_sen)}  total ${money(r.inv_total_sen)}`);
    log(`     it points at      : ${r.parent_doc_no} [${r.parent_status}] line ${r.parent_line_no ?? '?'} = ${r.parent_code}  qty ${r.parent_qty}`);
    log(`     invoice HEADER names: ${r.header_do_no ?? '(none)'}${r.header_do_id && r.header_do_id !== r.parent_doc_id ? '   <-- NOT the document the line points at' : ''}`);
    await candidates('DO', r.parent_doc_id, r.header_do_id, r.inv_code, r.line_id);
    log('');
  }

  log('=== B. PURCHASE INVOICE -> GOODS RECEIPT: the line named is a different product ===');
  log('');
  const pi = await sql.unsafe(`
    SELECT pi.invoice_number  AS inv_no,
           pi.status::text    AS inv_status,
           pi.currency::text  AS inv_currency,
           pi.grn_id          AS header_grn_id,
           hg.grn_number      AS header_grn_no,
           pii.id             AS line_id,
           pii.item_code      AS inv_code,
           pii.qty            AS inv_qty,
           pii.unit_price_sen AS inv_unit_sen,
           pii.line_total_sen AS inv_total_sen,
           gi.item_code       AS parent_code,
           gi.qty_received    AS parent_qty_recv,
           gi.qty_accepted    AS parent_qty_acc,
           gi.invoiced_qty    AS parent_invoiced_qty,
           gi.unit_cost_sen   AS parent_unit_cost_sen,
           g.id               AS parent_doc_id,
           g.grn_number       AS parent_doc_no,
           g.status::text     AS parent_status
      FROM scm.purchase_invoice_items pii
      JOIN scm.purchase_invoices      pi ON pi.id = pii.purchase_invoice_id
      JOIN scm.grn_items              gi ON gi.id = pii.grn_item_id
      JOIN scm.grns                   g  ON g.id  = gi.grn_id
      LEFT JOIN scm.grns              hg ON hg.id = pi.grn_id
     WHERE ${NORM('pii.item_code')} <> ${NORM('gi.item_code')}
     ORDER BY pi.invoice_number`);
  log(`${pi.length} purchase-invoice line(s) name a goods-receipt line for a different product.`);
  log('');
  for (const r of pi) {
    log(`  PURCHASE INVOICE ${r.inv_no} [${r.inv_status}] currency ${r.inv_currency}`);
    log(`     invoice line says : ${r.inv_code}  qty ${r.inv_qty}  unit ${money(r.inv_unit_sen)}  total ${money(r.inv_total_sen)}`);
    log(`     it points at      : ${r.parent_doc_no} [${r.parent_status}] = ${r.parent_code}  received ${r.parent_qty_recv} accepted ${r.parent_qty_acc}  invoiced_qty ${r.parent_invoiced_qty}  unit_cost ${money(r.parent_unit_cost_sen)}`);
    log(`     invoice HEADER names: ${r.header_grn_no ?? '(none)'}${r.header_grn_id && r.header_grn_id !== r.parent_doc_id ? '   <-- NOT the document the line points at' : ''}`);
    await candidates('GR', r.parent_doc_id, r.header_grn_id, r.inv_code, r.line_id);
    log('');
  }
}

/* Every line of the parent document — and of the document the invoice header
   names, when different — with the claim each already carries. This is what
   decides whether a repair is FORCED or must be refused. */
async function candidates(kind, parentDocId, headerDocId, wantCode, excludeLineId) {
  const docs = [...new Set([parentDocId, headerDocId].filter(Boolean))];
  for (const docId of docs) {
    const rows = kind === 'DO'
      ? await sql.unsafe(`
          SELECT d.do_number AS doc_no, i.line_no, i.item_code, i.qty,
                 (SELECT count(*)::int FROM scm.sales_invoice_items s
                   WHERE s.do_item_id = i.id AND s.id <> $2) AS other_claims
            FROM scm.delivery_order_items i
            JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
           WHERE i.delivery_order_id = $1
           ORDER BY i.line_no NULLS LAST, i.item_code`, [docId, excludeLineId])
      : await sql.unsafe(`
          SELECT g.grn_number AS doc_no, NULL::int AS line_no, i.item_code, i.qty_accepted AS qty,
                 (SELECT count(*)::int FROM scm.purchase_invoice_items p
                   WHERE p.grn_item_id = i.id AND p.id <> $2) AS other_claims
            FROM scm.grn_items i
            JOIN scm.grns g ON g.id = i.grn_id
           WHERE i.grn_id = $1
           ORDER BY i.item_code`, [docId, excludeLineId]);
    const want = norm(wantCode);
    const hits = rows.filter((x) => norm(x.item_code) === want);
    const free = hits.filter((x) => x.other_claims === 0);
    log(`     lines on ${rows[0]?.doc_no ?? docId} (${rows.length}): ${rows.map((x) => `${x.item_code} x${x.qty}${x.other_claims ? `[claimed x${x.other_claims}]` : ''}`).join(', ')}`);
    log(`        matching "${wantCode}": ${hits.length}; unclaimed by another invoice line: ${free.length} -> ${free.length === 1 ? 'REPAIR WOULD BE FORCED' : 'NOT forced'}`);
  }
}

/* ------------------------------------------------------------------------ C */

const EDGES = [
  ['DO->SO', 'delivery_order_items', 'so_item_id', 'mfg_sales_order_items', 'delivery_orders', 'delivery_order_id', 'id', 'do_number'],
  ['GR->PO', 'grn_items', 'purchase_order_item_id', 'purchase_order_items', 'grns', 'grn_id', 'id', 'grn_number'],
  ['PO->SO', 'purchase_order_items', 'so_item_id', 'mfg_sales_order_items', 'purchase_orders', 'purchase_order_id', 'id', 'po_number'],
  ['SI->DO', 'sales_invoice_items', 'do_item_id', 'delivery_order_items', 'sales_invoices', 'sales_invoice_id', 'id', 'invoice_number'],
  ['PI->GR', 'purchase_invoice_items', 'grn_item_id', 'grn_items', 'purchase_invoices', 'purchase_invoice_id', 'id', 'invoice_number'],
];

const COALESCED = (a) => `upper(btrim(coalesce(${a}.variants->>'colourId', ${a}.variants->>'colourLabel', ${a}.variants->>'colourCode', '')))`;

async function colours() {
  log('=== C. THE 12 COLOUR DISAGREEMENTS — a different COLOUR, or a different FIELD? ===');
  log('');
  log('   0672 compared coalesce(colourId, colourLabel, colourCode). Those are three');
  log('   different vocabularies. A row carrying only a LABEL compared against a row');
  log('   carrying an ID disagrees by construction, and that is not a wrong colour.');
  log('');
  let total = 0; let fieldMix = 0; let artefact = 0; let real = 0;
  for (const [name, child, col, parent, head, fk, pk, docCol] of EDGES) {
    let rows;
    try {
      rows = await sql.unsafe(`
        SELECT h.${docCol}                AS doc_no,
               h.company_id               AS company_id,
               c.item_code                AS child_code,
               p.item_code                AS parent_code,
               c.variants->>'colourId'    AS c_id,
               c.variants->>'colourLabel' AS c_label,
               c.variants->>'colourCode'  AS c_code,
               p.variants->>'colourId'    AS p_id,
               p.variants->>'colourLabel' AS p_label,
               p.variants->>'colourCode'  AS p_code
          FROM scm.${child} c
          JOIN scm.${parent} p ON p.id = c.${col}
          JOIN scm.${head}   h ON h.${pk} = c.${fk}
         WHERE ${COALESCED('c')} <> '' AND ${COALESCED('p')} <> ''
           AND ${COALESCED('c')} <> ${COALESCED('p')}
         ORDER BY h.${docCol}`);
    } catch (err) {
      log(`   ${name} — NOT COUNTABLE: ${String(err.message).slice(0, 120)}`);
      continue;
    }
    if (!rows.length) { log(`   ${name} — no disagreement`); continue; }
    log(`   ${name}: ${rows.length} row(s)`);
    for (const r of rows) {
      total += 1;
      const cField = r.c_id ? 'colourId' : r.c_label ? 'colourLabel' : 'colourCode';
      const pField = r.p_id ? 'colourId' : r.p_label ? 'colourLabel' : 'colourCode';
      if (cField !== pField) fieldMix += 1;
      const cR = await resolveColour(r.company_id, r.c_id, r.c_label ?? r.c_code);
      const pR = await resolveColour(r.company_id, r.p_id, r.p_label ?? r.p_code);
      const same = Boolean(
        (cR.colourId && pR.colourId && norm(cR.colourId) === norm(pR.colourId))
        || (cR.label && pR.label && norm(cR.label) === norm(pR.label)),
      );
      if (same) artefact += 1; else real += 1;
      log(`      ${r.doc_no}  ${r.child_code} -> ${r.parent_code}`);
      log(`         child : id=${r.c_id ?? '-'} label=${r.c_label ?? '-'} code=${r.c_code ?? '-'}  (resolves to ${cR.colourId ?? '?'} / ${cR.label ?? '?'})`);
      log(`         parent: id=${r.p_id ?? '-'} label=${r.p_label ?? '-'} code=${r.p_code ?? '-'}  (resolves to ${pR.colourId ?? '?'} / ${pR.label ?? '?'})`);
      log(`         fields compared: ${cField} vs ${pField}${cField !== pField ? '  <-- DIFFERENT FIELDS, the comparison itself is invalid' : ''}`);
      log(`         VERDICT: ${same ? 'SAME COLOUR — checker artefact' : 'genuinely different colour'}`);
    }
  }
  log('');
  log(`   TOTAL ${total} disagreeing rows: ${fieldMix} compare two DIFFERENT variant fields;`);
  log(`   ${artefact} resolve to the SAME colour (artefact); ${real} are a genuinely different colour.`);
}

/* Resolve either vocabulary to {colourId, label} so a label on one side and an
   id on the other can still be compared AS COLOURS. `active` is deliberately
   NOT filtered: a superseded row is exactly the case this has to be able to
   see (docs/bugs/0669, and the renumbered fabric library of 2026-09-02). */
async function resolveColour(companyId, id, label) {
  if (id) {
    const hit = await sql`SELECT colour_id, label FROM scm.fabric_colours
                           WHERE colour_id = ${String(id)} AND company_id = ${companyId} LIMIT 1`;
    return { by: 'id', colourId: String(id), label: hit[0]?.label ?? null };
  }
  if (label) {
    const hit = await sql`SELECT colour_id, label FROM scm.fabric_colours
                           WHERE upper(btrim(label)) = ${norm(label)} AND company_id = ${companyId} LIMIT 1`;
    return { by: 'label', colourId: hit[0]?.colour_id ?? null, label: String(label) };
  }
  return { by: 'none', colourId: null, label: null };
}

/* ------------------------------------------------------------------------ D */

async function sharedKeys() {
  log('=== D. THE SHARED AutoCount LINE KEY — sofa decomposition, or a collision? ===');
  log('');
  const TABLES = [
    ['mfg_sales_order_items', 'mfg_sales_orders', 'doc_no', 'doc_no'],
    ['purchase_order_items', 'purchase_orders', 'purchase_order_id', 'id'],
  ];
  for (const [line, head, fk, pk] of TABLES) {
    const groups = await sql.unsafe(`
      SELECT c.linked_ac_dtlkey                       AS dtlkey,
             count(*)::int                            AS n,
             array_agg(c.item_code ORDER BY c.item_code) AS codes,
             count(DISTINCT h.company_id)::int        AS companies
        FROM scm.${line} c
        JOIN scm.${head} h ON h.${pk} = c.${fk}
       WHERE c.linked_ac_dtlkey IS NOT NULL
       GROUP BY c.linked_ac_dtlkey
      HAVING count(*) > 1`);
    let ok = 0; const bad = [];
    for (const g of groups) {
      const v = decomposeGroup(g.codes);
      if (v.ok) ok += 1; else bad.push({ ...g, why: v.why });
    }
    log(`   ${line}: ${groups.length} DtlKeys carried by more than one row`);
    log(`      ${ok} of ${groups.length} are ONE model decomposed into DISTINCT compartments — by design (autocount-sofa-collapse.ts)`);
    log(`      ${bad.length} of ${groups.length} are NOT, and are candidate collisions:`);
    for (const b of bad.slice(0, 40)) {
      log(`         DtlKey ${b.dtlkey}: ${b.n} rows, ${b.companies} company(ies) — ${b.why}`);
      log(`            ${b.codes.join(', ')}`);
    }
    if (bad.length > 40) log(`         ... and ${bad.length - 40} more not printed`);
  }
}

async function main() {
  await wrongLinks();
  log('');
  await colours();
  log('');
  await sharedKeys();
  log('');
  log('WHAT THIS DOES NOT ANSWER. It compares OUR two sides only. A pair that agrees');
  log('with itself can still BOTH disagree with AutoCount; that needs the book, which');
  log('is check-ac-erp-reconcile\'s job, not this one\'s. And a link that was never');
  log('written is a COVERAGE question this file cannot see.');
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
