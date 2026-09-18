#!/usr/bin/env node
/* diag-variant-fabric-code — which fabric code does OUR variant key actually
 * carry, do a sofa's compartments agree with each other, and does the
 * cutover-lot fill agree with all of it?
 *
 * WHY THIS EXISTS. Two live questions, one query.
 *
 * 1. The cutover-lot variant fill decodes the book's receipt text
 *    ("Col:PC151-01 / Divan:8" / M'gap:12"") into `fabriccode=pc151-01`. The
 *    Stock Breakdown screen the owner pointed at renders `BF-01 (PC151-01)` —
 *    an internal code with a supplier's in parentheses. Stock buckets by
 *    (warehouse, item, variant_key), so a lot keyed one way beside order lines
 *    keyed the other is stock the system cannot see as the same thing. The
 *    source argues it either way; CLAUDE.md is explicit that reading the code
 *    is not an observation about production, so this reads the rows.
 *
 * 2. Owner, 2026-09-09, on HC-SO-010120 (`9058: 1A(LHF) + CNR + 2A(RHF)`):
 *    「第一个 item 不是应该跟第三、第四个 item 全部一样的吗？」 — the first
 *    compartment shows a fabric and a special list, the other two show only
 *    SEAT 30. One sofa is one line in the book and several rows here, and the
 *    cutover importer writes the SAME attribute bag onto every compartment, so
 *    they should agree. This prints all three rows' raw `variants` so the
 *    difference is visible instead of described.
 *
 * A NOTE ON WHERE THE KEY LIVES, because the first version of this script got
 * it wrong and failed with `column i.variant_key does not exist`: a stock LOT
 * stores `variant_key`; a document LINE stores the `variants` jsonb and its key
 * is computed on read. So the two sides are compared by computing the document
 * side here with the real `computeVariantKey`, which is why this runs under tsx.
 *
 * READ-ONLY: SELECTs only, no DDL, no writes, no transaction. Every legitimate
 * answer exits 0 — the answer is the output, not the exit code.
 *
 * RE-RUN: read-only, so a second run changes nothing and reports the same
 * unless the data moved.
 *
 * Env: DATABASE_URL (required)   COMPANY_ID (default 1)   DOC (default HC-SO-010120)
 */
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const DOC = process.env.DOC || 'HC-SO-010120';
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`company ${CO}   document under question: ${DOC}`);

  /* 1. The fabric library for the codes the book's bedframe receipts name. */
  const fc = await sql`
    SELECT c.fabric_id, c.colour_id, c.label, t.supplier_code
      FROM scm.fabric_colours c
      LEFT JOIN scm.fabric_trackings t
             ON upper(t.fabric_code) = upper(c.colour_id) AND t.company_id = c.company_id
     WHERE c.company_id = ${CO}
       AND (upper(c.colour_id) LIKE 'PC151%' OR upper(c.colour_id) LIKE 'BF-0%'
            OR upper(coalesce(t.supplier_code, '')) LIKE 'PC151%')
     ORDER BY c.colour_id LIMIT 40`;
  log(`\n=== fabric_colours in the PC151 / BF family: ${fc.length} ===`);
  for (const r of fc) {
    log(`  fabric_id=${String(r.fabric_id).padEnd(16)} colour_id=${String(r.colour_id).padEnd(14)}`
      + ` supplier=${String(r.supplier_code ?? '-').padEnd(14)} label=${r.label}`);
  }

  /* 2. What our own bedframe ORDER LINES key to. The key is computed, not
        stored, so it is computed here with the real function. */
  const soRows = await sql`
    SELECT i.item_code, i.item_group, i.variants
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND lower(coalesce(i.item_group, '')) = 'bedframe'
       AND i.variants IS NOT NULL
     ORDER BY i.id DESC LIMIT 4000`;
  const soFabric = new Map();
  let soKeyed = 0;
  for (const r of soRows) {
    const key = computeVariantKey(r.item_group, r.variants);
    if (!key) continue;
    soKeyed += 1;
    for (const part of key.split('|')) {
      if (!part.startsWith('fabriccode=')) continue;
      const code = part.slice('fabriccode='.length);
      soFabric.set(code, (soFabric.get(code) ?? 0) + 1);
    }
  }
  log(`\n=== fabriccode= on our BEDFRAME order lines (${soKeyed} keyed of ${soRows.length} read) ===`);
  for (const [c, n] of [...soFabric].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    log(`  ${String(n).padStart(6)}  ${c}`);
  }

  /* 3. What the STOCK LOTS carry, which is the column the fill writes. */
  const lotKeys = await sql`
    SELECT split_part(part, '=', 2) AS code, count(*)::int AS n
      FROM (SELECT unnest(string_to_array(l.variant_key, '|')) AS part
              FROM scm.inventory_lots l
             WHERE l.company_id = ${CO} AND coalesce(l.variant_key, '') <> '') x
     WHERE part LIKE 'fabriccode=%'
     GROUP BY 1 ORDER BY n DESC LIMIT 20`;
  log('\n=== fabriccode= on our STOCK LOTS ===');
  for (const r of lotKeys) log(`  ${String(r.n).padStart(6)}  ${r.code}`);

  const lotSample = await sql`
    SELECT item_code, variant_key FROM scm.inventory_lots
     WHERE company_id = ${CO} AND variant_key LIKE '%gap=%'
     ORDER BY id DESC LIMIT 6`;
  log('\n=== live bedframe keys on stock lots ===');
  for (const r of lotSample) log(`  ${String(r.item_code).padEnd(24)} ${r.variant_key}`);

  /* 4. THE OWNER'S SOFA. Every compartment of one sofa, with its raw variants
        and the key each one computes to. */
  const sofa = await sql`
    SELECT i.id, i.line_no, i.item_code, i.item_group, i.qty, i.linked_ac_dtlkey,
           i.variants, i.description2
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.doc_no = ${DOC}
     ORDER BY i.line_no, i.id`;
  log(`\n=== ${DOC}: ${sofa.length} line(s) ===`);
  for (const r of sofa) {
    log(`  line ${String(r.line_no).padStart(3)}  ${String(r.item_code).padEnd(20)}`
      + ` grp=${String(r.item_group ?? '-').padEnd(9)} qty=${r.qty} dtlkey=${r.linked_ac_dtlkey ?? '-'}`);
    log(`      key      : ${computeVariantKey(r.item_group, r.variants) || '(empty)'}`);
    log(`      variants : ${JSON.stringify(r.variants)}`);
    if (r.description2) log(`      desc2    : ${String(r.description2).slice(0, 120)}`);
  }

  /* 5. HOW COMMON IS THAT SHAPE? A sofa whose compartments share one book line
        but do NOT share one key is stock that cannot be allocated as a set. */
  const split = await sql`
    SELECT i.doc_no, i.linked_ac_dtlkey::text AS dtlkey,
           count(*)::int AS rows,
           count(DISTINCT coalesce(i.variants->>'fabricCode', ''))::int AS fabrics,
           count(DISTINCT coalesce(i.variants->>'colourLabel', ''))::int AS colours
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND lower(coalesce(i.item_group, '')) = 'sofa'
       AND i.linked_ac_dtlkey IS NOT NULL AND coalesce(i.cancelled, false) = false
     GROUP BY 1, 2
    HAVING count(*) > 1 AND count(DISTINCT coalesce(i.variants->>'fabricCode', '')) > 1
     ORDER BY 1 LIMIT 40`;
  const [splitCount] = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT i.doc_no, i.linked_ac_dtlkey
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND lower(coalesce(i.item_group, '')) = 'sofa'
         AND i.linked_ac_dtlkey IS NOT NULL AND coalesce(i.cancelled, false) = false
       GROUP BY 1, 2
      HAVING count(*) > 1 AND count(DISTINCT coalesce(i.variants->>'fabricCode', '')) > 1) z`;
  log(`\n=== sofas whose compartments DISAGREE on the fabric: ${splitCount.n} ===`);
  for (const r of split) {
    log(`  ${r.doc_no}  book line ${r.dtlkey}  ${r.rows} row(s), ${r.fabrics} different fabric value(s), ${r.colours} colour label(s)`);
  }

  await sql.end();
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
