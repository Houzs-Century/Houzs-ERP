#!/usr/bin/env node
/* diag-variant-fabric-code — which fabric code does OUR variant key actually
 * carry, and does the cutover-lot fill agree with it?
 *
 * WHY THIS EXISTS. The cutover-lot variant fill decodes the book's receipt text
 * ("Col:PC151-01 / Divan:8" / M'gap:12"") into our key, and its plan run
 * produced `fabriccode=pc151-01`. The Stock Breakdown screen the owner pointed
 * at renders `BF-01 (PC151-01)` — an internal code with the supplier's in
 * parentheses. Those two readings cannot both be what the key holds, and the
 * difference is not cosmetic: stock buckets by (warehouse, item, variant_key),
 * so a lot keyed `pc151-01` sitting next to order lines keyed `bf-01` is stock
 * the system cannot see as the same thing.
 *
 * I could argue it either way from the source — `bedframeVariants` sets
 * `fabricCode` from `colour_id`, and the fill uses the SAME resolver the cutover
 * importers used, so by construction they must agree. That is reasoning, not
 * evidence, and CLAUDE.md is explicit that reading the code is not an
 * observation about production. This reads the rows.
 *
 * READ-ONLY: SELECTs only, no DDL, no writes, no transaction. Every legitimate
 * answer exits 0 — the answer is the output, not the exit code.
 *
 * RE-RUN: read-only, so a second run changes nothing and reports the same
 * unless the data moved.
 *
 * Env: DATABASE_URL (required)   COMPANY_ID (default 1)
 */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`company ${CO}`);

  /* 1. What the fabric library holds for the codes the book's bedframe receipts
        actually name. If `PC151-01` is itself a colour_id, the fill's output IS
        the library's own answer; if it only exists as a supplier code (which
        lives in fabric_trackings, not here), it is not. */
  const fc = await sql`
    SELECT c.fabric_id, c.colour_id, c.label, t.supplier_code
      FROM scm.fabric_colours c
      LEFT JOIN scm.fabric_trackings t
             ON upper(t.fabric_code) = upper(c.colour_id) AND t.company_id = c.company_id
     WHERE c.company_id = ${CO}
       AND (upper(c.colour_id) LIKE 'PC151%' OR upper(c.colour_id) LIKE 'BF-0%'
            OR upper(coalesce(t.supplier_code, '')) LIKE 'PC151%')
     ORDER BY c.colour_id
     LIMIT 60`;
  log(`\n=== fabric_colours rows in the PC151 / BF family: ${fc.length} ===`);
  for (const r of fc) {
    log(`  fabric_id=${String(r.fabric_id).padEnd(16)} colour_id=${String(r.colour_id).padEnd(14)}`
      + ` supplier=${String(r.supplier_code ?? '-').padEnd(14)} label=${r.label}`);
  }

  /* 2. What our OWN bedframe rows carry today. This is the number that decides
        it: a lot must key the way the document lines beside it key. */
  const soKeys = await sql`
    SELECT split_part(part, '=', 2) AS code, count(*)::int AS n
      FROM (
        SELECT unnest(string_to_array(i.variant_key, '|')) AS part
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = ${CO} AND coalesce(i.variant_key, '') <> ''
      ) x
     WHERE part LIKE 'fabriccode=%'
     GROUP BY 1 ORDER BY n DESC LIMIT 25`;
  log('\n=== fabriccode= values on our SALES ORDER lines (top 25) ===');
  for (const r of soKeys) log(`  ${String(r.n).padStart(6)}  ${r.code}`);

  const lotKeys = await sql`
    SELECT split_part(part, '=', 2) AS code, count(*)::int AS n
      FROM (
        SELECT unnest(string_to_array(l.variant_key, '|')) AS part
          FROM scm.inventory_lots l
         WHERE l.company_id = ${CO} AND coalesce(l.variant_key, '') <> ''
      ) x
     WHERE part LIKE 'fabriccode=%'
     GROUP BY 1 ORDER BY n DESC LIMIT 25`;
  log('\n=== fabriccode= values on our STOCK LOTS (top 25) ===');
  for (const r of lotKeys) log(`  ${String(r.n).padStart(6)}  ${r.code}`);

  /* 3. A whole live key from each side, so the SHAPE is on screen and not
        inferred from the fragments above. */
  const soSample = await sql`
    SELECT i.doc_no, i.item_code, i.variant_key
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.variant_key LIKE '%gap=%'
     ORDER BY i.id DESC LIMIT 6`;
  log('\n=== live bedframe keys on sales-order lines ===');
  for (const r of soSample) log(`  ${r.doc_no}  ${String(r.item_code).padEnd(24)} ${r.variant_key}`);

  const lotSample = await sql`
    SELECT item_code, variant_key, qty_remaining
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND variant_key LIKE '%gap=%'
     ORDER BY id DESC LIMIT 6`;
  log('\n=== live bedframe keys on stock lots ===');
  for (const r of lotSample) log(`  ${String(r.item_code).padEnd(24)} ${r.variant_key}`);

  /* 4. The direct question: do the two populations share a vocabulary? */
  const [overlap] = await sql`
    WITH so AS (
      SELECT DISTINCT split_part(part, '=', 2) AS code
        FROM (SELECT unnest(string_to_array(i.variant_key, '|')) AS part
                FROM scm.mfg_sales_order_items i
                JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
               WHERE h.company_id = ${CO} AND coalesce(i.variant_key, '') <> '') a
       WHERE part LIKE 'fabriccode=%'),
    lot AS (
      SELECT DISTINCT split_part(part, '=', 2) AS code
        FROM (SELECT unnest(string_to_array(l.variant_key, '|')) AS part
                FROM scm.inventory_lots l
               WHERE l.company_id = ${CO} AND coalesce(l.variant_key, '') <> '') b
       WHERE part LIKE 'fabriccode=%')
    SELECT (SELECT count(*) FROM so)::int AS so_codes,
           (SELECT count(*) FROM lot)::int AS lot_codes,
           (SELECT count(*) FROM so JOIN lot USING (code))::int AS shared`;
  log('\n=== vocabulary ===');
  log(`  distinct fabric codes on order lines: ${overlap.so_codes}`);
  log(`  distinct fabric codes on stock lots:  ${overlap.lot_codes}`);
  log(`  shared by both:                       ${overlap.shared}`);

  await sql.end();
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
