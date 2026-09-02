#!/usr/bin/env node
/* check-fabric-owner.mjs -- READ-ONLY. Locate fabric codes/series across
   companies: which company_id owns each, whether it is active or retired
   (retired rows are hidden from the fabric list yet still occupy the global
   code, which is what makes a Houzs import 409 "belongs to another organisation"
   while the owner sees nothing in the other company's list).

   Pass SERIES="CASSNYE,COVE,HM001,..." (comma-separated). One SELECT set, no
   writes, no DDL, no transaction. Exit 0 for every legitimate answer.
   RE-RUN: idempotent, reads only. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const series = (process.env.SERIES || '').split(',').map((s) => s.trim()).filter(Boolean);
const codes = (process.env.CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const companies = await sql`SELECT id::text AS id, code, name FROM public.companies ORDER BY id`;
  const cmap = new Map(companies.map((r) => [String(r.id), r.code]));
  note('companies: ' + companies.map((r) => `${r.id}=${r.code}(${r.name})`).join('  '));

  if (!series.length && !codes.length) {
    note('no SERIES or CODES input.');
    await sql.end({ timeout: 5 });
    return;
  }

  const whereSeries = series.length ? sql`series = ANY(${series})` : sql`false`;
  const whereCodes = codes.length ? sql`id = ANY(${codes})` : sql`false`;

  // fabric_trackings: the table the import's 409 check reads.
  // (no created_at column on this table -- group by company + active only)
  const grp = await sql`
    SELECT company_id::text AS cid, is_active, count(*)::int AS n
      FROM scm.fabric_trackings
     WHERE ${whereSeries} OR ${whereCodes}
     GROUP BY company_id, is_active
     ORDER BY company_id, is_active`;
  note(`\n=== fabric_trackings -- where these fabrics live (series=[${series.join(',')}]) ===`);
  if (!grp.length) note('  NONE found in fabric_trackings. The codes are not here at all.');
  for (const r of grp) {
    note(`  company ${r.cid} (${cmap.get(r.cid) || 'UNKNOWN/orphan'})  active=${r.is_active}  count=${r.n}`);
  }

  const sample = await sql`
    SELECT id, series, company_id::text AS cid, is_active
      FROM scm.fabric_trackings
     WHERE ${whereSeries} OR ${whereCodes}
     ORDER BY company_id, id LIMIT 40`;
  note(`\n=== sample rows (up to 40) ===`);
  for (const r of sample) {
    note(`  ${String(r.id).padEnd(14)} series=${String(r.series ?? '').padEnd(10)} company ${r.cid}(${cmap.get(r.cid) || '?'})  active=${r.is_active}`);
  }

  // selling library mirrors, best-effort
  for (const tbl of ['fabric_library', 'fabric_colours']) {
    try {
      const rows = await sql`
        SELECT company_id::text AS cid, count(*)::int AS n
          FROM scm.${sql(tbl)}
         WHERE series = ANY(${series.length ? series : [' ']})
         GROUP BY company_id ORDER BY company_id`;
      note(`\n=== ${tbl} (by company, series match) ===`);
      if (!rows.length) note('  (none)');
      for (const r of rows) note(`  company ${r.cid}(${cmap.get(r.cid) || '?'})  count=${r.n}`);
    } catch (e) { note(`  ${tbl}: skipped (${e.message})`); }
  }

  note('\n=== READ-ONLY complete. Nothing was written. ===');
  await sql.end({ timeout: 5 });
}
main().catch((e) => { console.log(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : `ERROR ${e.message}`); process.exit(1); });
