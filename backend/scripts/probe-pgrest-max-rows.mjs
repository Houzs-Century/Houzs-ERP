#!/usr/bin/env node
/* What LIMIT does PostgREST actually put on this project's reads? Read-only.

   WHY. routes/mrp.ts's demand read asks for `.limit(5000)` and throws when the
   returned length REACHES 5000. Everything about the "MRP plans over a slice"
   diagnosis turns on ONE unmeasured number: PostgREST's db-max-rows.
     · max-rows <= 1000  -> the read comes back short, the guard is silent, and
       the plan is computed over a fraction of demand;
     · max-rows absent   -> the read returns exactly 5000, the guard FIRES, and
       GET /mrp is a 500 for everybody — a different bug with a different fix.

   pg_stat_statements CANNOT answer this with rows/calls: PostgREST wraps every
   read in `WITH pgrst_source AS (...) SELECT ... json_agg(...) FROM ...`, which
   returns exactly ONE row no matter how many records it carried. (That is why
   every pgrst_source entry reads 1.0 rows/call — it is not evidence of a cap.)

   What CAN answer it is the generated SQL text. PostgREST writes the effective
   limit into pgrst_source as a real LIMIT clause, so:
     · an app read with NO .limit() that still shows a LIMIT  => max-rows is on
     · that clause's value (when it is not normalised away)   => the ceiling
   Query text is truncated to track_activity_query_size, so this prints the
   SHORT statements in full and reports that setting.

   node scripts/probe-pgrest-max-rows.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const guard = async (label, fn) => {
  try { return await fn(); } catch (e) { note(`  ${label}: QUERY FAILED: ${e.message}`); return null; }
};

async function main() {
  note(`\n${'='.repeat(74)}`);
  note(`=== What LIMIT does PostgREST generate on this project? ===`);

  await guard('settings', async () => {
    const rows = await sql`
      SELECT name, setting FROM pg_settings
       WHERE name IN ('track_activity_query_size','pg_stat_statements.track','server_version')`;
    for (const r of rows) note(`  ${r.name} = ${r.setting}`);
  });

  const schema = await guard('locate', async () => {
    const [r] = await sql`
      SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pg_stat_statements'`;
    return r?.s ?? null;
  });
  if (!schema) { note('  pg_stat_statements not installed — stopping'); await sql.end({ timeout: 5 }); return; }

  /* ── 1. Every LIMIT clause PostgREST has generated, with its frequency ────
     Pull the text after the LAST 'LIMIT ' in each pgrst_source statement. A
     normalised constant shows as $n; a surviving literal shows the number. */
  note(`\n--- 1. LIMIT clauses inside PostgREST-generated statements ---`);
  await guard('limits', async () => {
    const rows = await sql`
      SELECT substring(query from 'LIMIT ([^ )]+)') AS lim, count(*)::bigint AS statements, sum(calls)::bigint AS calls
        FROM ${sql(schema)}.pg_stat_statements
       WHERE query LIKE '%pgrst_source%' AND query LIKE '%LIMIT %'
       GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 30`;
    if (!rows.length) { note('    (no pgrst_source statement contains a LIMIT at all)'); return; }
    note(`    LIMIT value | distinct statements | total calls`);
    for (const r of rows) note(`    ${String(r.lim).padStart(11)} | ${String(r.statements).padStart(19)} | ${r.calls}`);
  });
  await guard('nolimit', async () => {
    const [r] = await sql`
      SELECT count(*)::bigint AS n, sum(calls)::bigint AS calls
        FROM ${sql(schema)}.pg_stat_statements
       WHERE query LIKE '%pgrst_source%' AND query NOT LIKE '%LIMIT %'`;
    note(`    pgrst_source statements with NO LIMIT anywhere in the stored text: ${r.n} (${r.calls} calls)`);
    note(`    (stored text is truncated to track_activity_query_size, so a long`);
    note(`     statement can lose its tail — read this together with section 2.)`);
  });

  /* ── 2. SHORT PostgREST reads printed IN FULL ────────────────────────────
     Short enough that truncation cannot have eaten the LIMIT, so whatever
     appears here is the whole generated statement. */
  note(`\n--- 2. short pgrst_source statements, printed in full ---`);
  await guard('short', async () => {
    const rows = await sql`
      SELECT calls, length(query) AS len, query
        FROM ${sql(schema)}.pg_stat_statements
       WHERE query LIKE 'WITH pgrst_source%' AND length(query) < 600
       ORDER BY calls DESC LIMIT 8`;
    if (!rows.length) note('    (none under 600 chars)');
    for (const r of rows) {
      note(`\n    calls=${r.calls} len=${r.len}`);
      note(`    ${String(r.query).replace(/\s+/g, ' ')}`);
    }
  });

  /* ── 3. The MRP demand read specifically ─────────────────────────────── */
  note(`\n--- 3. the MRP demand read (mfg_sales_order_items + the so embed) ---`);
  await guard('mrp', async () => {
    const rows = await sql`
      SELECT calls, length(query) AS len, right(query, 320) AS tail
        FROM ${sql(schema)}.pg_stat_statements
       WHERE query LIKE '%pgrst_source%'
         AND query LIKE '%mfg_sales_order_items%'
         AND query LIKE '%mfg_sales_orders%'
       ORDER BY calls DESC LIMIT 10`;
    if (!rows.length) note('    (no PostgREST statement joins items to orders — MRP may not have run since the last stats reset)');
    for (const r of rows) note(`    calls=${String(r.calls).padStart(6)} len=${r.len}  ...TAIL: ${String(r.tail).replace(/\s+/g, ' ')}`);
  });

  /* ── 4. What the biggest non-PostgREST readers return ────────────────────
     Section C of probe-mrp-cap-verify found statements averaging ~13,900 rows
     per call. Name them, so nobody mistakes a direct-pg full scan for proof
     that PostgREST hands back 13,900 rows. */
  note(`\n--- 4. highest rows-per-call statements, named ---`);
  await guard('top', async () => {
    const rows = await sql`
      SELECT calls, rows, round(rows::numeric / greatest(calls,1),0) AS rpc,
             (query LIKE '%pgrst_source%') AS via_postgrest,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 150) AS q
        FROM ${sql(schema)}.pg_stat_statements
       WHERE calls > 0
       ORDER BY rows::numeric / greatest(calls,1) DESC LIMIT 12`;
    for (const r of rows) {
      note(`    ${String(r.rpc).padStart(7)} rows/call  calls=${String(r.calls).padStart(6)}  postgrest=${r.via_postgrest}`);
      note(`        ${r.q}`);
    }
  });

  /* ── 5. Sanity: does ANY pgrst_source statement carry a literal ceiling ── */
  note(`\n--- 5. distinct literal LIMIT numbers in PostgREST statements ---`);
  await guard('literal', async () => {
    const rows = await sql`
      SELECT DISTINCT substring(query from 'LIMIT ([0-9]+)') AS lim
        FROM ${sql(schema)}.pg_stat_statements
       WHERE query LIKE '%pgrst_source%' AND query ~ 'LIMIT [0-9]+'`;
    if (!rows.length) note('    (every LIMIT was normalised to a $n placeholder)');
    for (const r of rows) note(`    LIMIT ${r.lim}`);
  });

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
