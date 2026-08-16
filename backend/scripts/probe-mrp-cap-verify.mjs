#!/usr/bin/env node
/* INDEPENDENT re-verification of the "MRP demand read is truncated" claim.
   Read-only: every statement here is a SELECT.

   The claim under test (routes/mrp.ts:466-479): the demand read ends
   `.order('id').limit(5000)` with a guard that throws only when the returned
   length REACHES 5000, so a PostgREST row ceiling BELOW 5000 truncates the plan
   invisibly. probe-mrp-read-caps.mjs measured the MATCHING row count and one
   line's rank with a JOIN. This probe re-derives both a DIFFERENT way (EXISTS +
   a count-of-smaller-ids, no join), so a join fan-out cannot be the reason the
   numbers look alarming, and then asks the ONE question that probe could not:

     HOW MANY ROWS DOES PostgREST ACTUALLY HAND BACK for that read?

   pg_stat_statements records calls and total rows returned per normalised
   statement. rows/calls for the MRP demand read is the live ceiling, measured
   rather than assumed — it decides between the two branches the diagnosis left
   open (a <=1000 ceiling => silent slice; a >=5000 ceiling => the guard fires
   and GET /mrp 500s for everyone). Also dumps any `pgrst.*` role settings, in
   case this project configures db-max-rows through the database.

   DOC="HC-SO-2608-003" CODE="JAGER-(K)" node scripts/probe-mrp-cap-verify.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOC = (process.env.DOC || '').trim();
if (!DOC) { console.error('need DOC="HC-SO-2608-003"'); process.exit(2); }
const CODE = (process.env.CODE || '').trim() || null;
const CO = Number(process.env.COMPANY || 1);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* shared/so-terminal-states.ts, in its declared order. Printed so a drift
   between this probe and the route is visible rather than assumed. */
const SO_DONE = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'];

const guard = async (label, fn) => {
  try { return await fn(); }
  catch (e) { note(`  ${label}: QUERY FAILED: ${e.message}`); return null; }
};

async function main() {
  note(`\n${'='.repeat(74)}`);
  note(`=== INDEPENDENT re-verify, company ${CO} — DOC ${DOC}${CODE ? `, CODE ${CODE}` : ''} ===`);
  note(`  SO_DONE (from shared/so-terminal-states.ts): ${SO_DONE.join(',')}`);

  /* ── A. The matching count, WITHOUT a join ────────────────────────────────
     mfg_sales_orders.doc_no is the PRIMARY KEY (2990s-full-schema.sql:638), so
     the earlier probe's JOIN could not fan out — but prove it rather than
     assert it: an EXISTS can never duplicate a row, so if these two agree the
     13920 is not a join artefact. */
  note(`\n--- A. demand rows matching MRP's SQL-side filters (EXISTS form) ---`);
  await guard('A', async () => {
    const [r] = await sql`
      SELECT count(*)::bigint AS n
        FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO}::bigint
         AND i.cancelled = false
         AND EXISTS (SELECT 1 FROM scm.mfg_sales_orders s
                      WHERE s.doc_no = i.doc_no
                        AND NOT (s.status::text = ANY(${SO_DONE}::text[])))`;
    note(`  EXISTS form                    ${r.n}`);
  });
  await guard('A-join', async () => {
    const [r] = await sql`
      SELECT count(*)::bigint AS n
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
         AND NOT (s.status::text = ANY(${SO_DONE}::text[]))`;
    note(`  JOIN form (earlier probe)      ${r.n}`);
  });
  await guard('A-total', async () => {
    const [r] = await sql`
      SELECT count(*)::bigint AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO}::bigint`;
    note(`  ALL item rows for company      ${r.n}`);
  });
  await guard('A-status', async () => {
    const rows = await sql`
      SELECT coalesce(s.status::text,'(null)') AS status, count(*)::bigint AS n
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
       GROUP BY 1 ORDER BY 2 DESC`;
    note(`  status histogram of NON-cancelled item rows (which survive NOT IN):`);
    for (const r of rows) {
      note(`    ${String(r.status).padEnd(14)} ${String(r.n).padStart(7)}   ${SO_DONE.includes(r.status) ? 'excluded' : 'DEMAND'}`);
    }
  });

  /* ── B. The rank, WITHOUT row_number ──────────────────────────────────────
     rank under ORDER BY id == 1 + how many matching rows have a SMALLER id.
     Different formulation, same answer if the earlier probe was right. */
  note(`\n--- B. rank of each ${DOC} line under ORDER BY id (count-of-smaller-ids) ---`);
  await guard('B', async () => {
    const lines = await sql`
      SELECT i.id::text AS id, i.line_no, i.item_code, i.qty, i.cancelled,
             i.item_group, i.warehouse_id::text AS warehouse_id,
             i.line_delivery_date::text AS line_delivery_date, i.variants
        FROM scm.mfg_sales_order_items i
       WHERE i.doc_no = ${DOC} AND i.company_id = ${CO}::bigint
       ORDER BY i.line_no`;
    if (!lines.length) { note(`  (no line of ${DOC} in company ${CO})`); return; }
    for (const l of lines) {
      const [r] = await sql`
        SELECT count(*)::bigint AS smaller
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
         WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
           AND NOT (s.status::text = ANY(${SO_DONE}::text[]))
           AND i.id < ${l.id}::uuid`;
      const rank = Number(r.smaller) + 1;
      note(`  line ${l.line_no}  ${String(l.item_code).padEnd(24)} qty=${l.qty} grp=${l.item_group} cancelled=${l.cancelled}`);
      note(`      id=${l.id}  rank=${rank}   ${rank <= 1000 ? 'inside 1000' : 'OUTSIDE 1000'} / ${rank <= 5000 ? 'inside 5000' : 'OUTSIDE 5000'}`);
      note(`      line_delivery_date=${l.line_delivery_date}  wh=${l.warehouse_id}`);
    }
  });

  /* ── C. THE MEASUREMENT THE EARLIER PROBE DID NOT MAKE ────────────────────
     What PostgREST actually returns. rows/calls per normalised statement. */
  note(`\n--- C. pg_stat_statements — rows ACTUALLY returned per call ---`);
  const pss = await guard('C-locate', async () => {
    const [r] = await sql`
      SELECT n.nspname AS schema
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pg_stat_statements'`;
    return r ? r.schema : null;
  });
  if (!pss) note(`  pg_stat_statements is NOT installed — cannot measure the live ceiling this way.`);
  else {
    note(`  pg_stat_statements lives in schema "${pss}"`);
    await guard('C-rows', async () => {
      const rows = await sql`
        SELECT calls, rows, round(rows::numeric / greatest(calls,1), 1) AS rows_per_call,
               left(query, 220) AS q
          FROM ${sql(pss)}.pg_stat_statements
         WHERE query ILIKE '%mfg_sales_order_items%'
         ORDER BY calls DESC LIMIT 25`;
      if (!rows.length) { note(`    (no recorded statement mentions mfg_sales_order_items)`); return; }
      note(`    calls | total rows | ROWS PER CALL | query head`);
      for (const r of rows) note(`    ${String(r.calls).padStart(6)} | ${String(r.rows).padStart(10)} | ${String(r.rows_per_call).padStart(13)} | ${String(r.q).replace(/\s+/g, ' ').slice(0, 200)}`);
    });
    /* Any statement at all whose rows/calls pins to a round ceiling is the
       tell — if EVERY big read tops out at the same number, that number is the
       ceiling, whichever table it came from. */
    await guard('C-ceiling', async () => {
      const rows = await sql`
        SELECT round(rows::numeric / greatest(calls,1), 0) AS rpc, count(*)::bigint AS statements
          FROM ${sql(pss)}.pg_stat_statements
         WHERE calls > 0 AND rows::numeric / greatest(calls,1) >= 500
         GROUP BY 1 ORDER BY 1 DESC LIMIT 20`;
      note(`    distribution of rows-per-call >= 500 across ALL statements:`);
      if (!rows.length) note(`      (none — no statement averages 500+ rows)`);
      for (const r of rows) note(`      ${String(r.rpc).padStart(7)} rows/call  x ${r.statements} statement(s)`);
    });
    await guard('C-max', async () => {
      const [r] = await sql`
        SELECT max(rows::numeric / greatest(calls,1)) AS max_rpc,
               max(rows) AS max_rows_one_stmt
          FROM ${sql(pss)}.pg_stat_statements WHERE calls > 0`;
      note(`    highest rows-per-call anywhere: ${r.max_rpc}`);
    });
  }

  /* ── D. Is db-max-rows configured through the database? ───────────────── */
  note(`\n--- D. pgrst.* settings stored on database roles ---`);
  await guard('D', async () => {
    const rows = await sql`
      SELECT coalesce(r.rolname,'(all roles)') AS role, unnest(s.setconfig) AS setting
        FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole`;
    const hits = rows.filter((r) => String(r.setting).toLowerCase().startsWith('pgrst.'));
    if (!hits.length) note(`    (no pgrst.* role settings — db-max-rows is set outside the DB)`);
    for (const h of hits) note(`    ${h.role}: ${h.setting}`);
  });

  /* ── E. What the proposed FIX would hand the next read ──────────────────
     computeMrp feeds every demand doc_no into soDeliverableRemaining, which
     builds ONE `.in('doc_no', ...)` list (delivery-orders-mfg.ts:2195). Today
     that list is built from a truncated demand set; un-truncating demand makes
     it as large as this. */
  note(`\n--- E. distinct doc_nos in the FULL demand set (the .in() the fix would build) ---`);
  await guard('E', async () => {
    const [r] = await sql`
      SELECT count(DISTINCT i.doc_no)::bigint AS n, sum(length(i.doc_no))::bigint AS chars
        FROM (SELECT DISTINCT i.doc_no FROM scm.mfg_sales_order_items i
                JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
               WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
                 AND NOT (s.status::text = ANY(${SO_DONE}::text[]))) i`;
    note(`    distinct doc_nos: ${r.n}   raw chars: ${r.chars}  (URL-encoded quotes+commas add ~4/doc_no)`);
  });
  await guard('E-lines', async () => {
    const [r] = await sql`
      SELECT count(*)::bigint AS n
        FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
         AND i.doc_no IN (SELECT DISTINCT i2.doc_no FROM scm.mfg_sales_order_items i2
                            JOIN scm.mfg_sales_orders s ON s.doc_no = i2.doc_no
                           WHERE i2.company_id = ${CO}::bigint AND i2.cancelled = false
                             AND NOT (s.status::text = ANY(${SO_DONE}::text[])))`;
    note(`    rows soDeliverableRemaining would then page: ${r.n}`);
  });

  /* ── F. Does the named line survive MRP's OTHER gates? ──────────────────
     If something else drops it, the cap is not the whole story. */
  if (CODE) {
    note(`\n--- F. other gates on ${CODE} in ${DOC} ---`);
    await guard('F-prod', async () => {
      const rows = await sql`
        SELECT code, category, name FROM scm.mfg_products
         WHERE code = ${CODE} AND company_id = ${CO}::bigint`;
      if (!rows.length) note(`    mfg_products: NO ROW for ${CODE} in company ${CO} — category would be null`);
      for (const p of rows) note(`    mfg_products: category=${p.category} name=${p.name}`);
    });
    await guard('F-header', async () => {
      const [h] = await sql`
        SELECT status, so_date::text AS so_date, customer_delivery_date::text AS cdd,
               processing_date::text AS pd, customer_state, sales_location, company_id
          FROM scm.mfg_sales_orders WHERE doc_no = ${DOC}`;
      if (!h) { note(`    SO header MISSING`); return; }
      note(`    SO header: status=${h.status} company=${h.company_id} so_date=${h.so_date} cdd=${h.cdd} pd=${h.pd} state=${h.customer_state} loc=${h.sales_location}`);
    });
    await guard('F-spread', async () => {
      const [s] = await sql`
        WITH d AS (
          SELECT i.item_code, row_number() OVER (ORDER BY i.id) AS rn
            FROM scm.mfg_sales_order_items i
            JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
           WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
             AND NOT (s.status::text = ANY(${SO_DONE}::text[])))
        SELECT count(*)::bigint AS total,
               count(*) FILTER (WHERE rn <= 1000)::bigint AS w1000,
               count(*) FILTER (WHERE rn <= 5000)::bigint AS w5000
          FROM d WHERE item_code = ${CODE}`;
      note(`    live demand lines for ${CODE}: ${s.total}  inside 1000: ${s.w1000}  inside 5000: ${s.w5000}`);
    });
  }

  /* ── G. The sibling reads, re-counted ─────────────────────────────────── */
  note(`\n--- G. sibling reads with no .limit() at all ---`);
  for (const [label, q] of [
    ['inventory_balances', sql`SELECT count(*)::bigint AS n FROM scm.inventory_balances WHERE company_id = ${CO}::bigint`],
    ['mfg_products', sql`SELECT count(*)::bigint AS n FROM scm.mfg_products WHERE company_id = ${CO}::bigint`],
    ['supplier_material_bindings', sql`SELECT count(*)::bigint AS n FROM scm.supplier_material_bindings WHERE company_id = ${CO}::bigint AND material_kind = 'mfg_product'`],
  ]) {
    await guard(label, async () => { const [r] = await q; note(`  ${label.padEnd(28)} ${r.n}`); });
  }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
