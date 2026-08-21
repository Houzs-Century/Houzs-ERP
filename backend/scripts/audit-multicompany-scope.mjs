#!/usr/bin/env node
// Read-only SCHEMA audit. Owner 2026-07-23: "如果开第三个、第四个、第五个公司,
// 这些又要怎么去分呢? 你也是要完善掉这整个的东西。" This introspects the per-company
// schemas and answers ONE question per table: will it hold when company 3/4/5
// is added, or is it a landmine? Three verdicts:
//
//   SCOPED-OK    — has company_id AND every UNIQUE key includes company_id.
//                  A new company reuses codes freely. Scales cleanly.
//   LANDMINE     — has company_id BUT a UNIQUE key is GLOBAL (no company_id).
//                  Company N reusing that value (account_code, a doc number,
//                  a product code) collides. This is exactly why 2990's GL
//                  couldn't import without a "2990-" prefix hack. Each of
//                  these needs UNIQUE(company_id, key) before company 3.
//   NO-COMPANY   — no company_id column at all. Either intentionally SHARED
//                  (currencies, my_localities, series) or an un-scoped gap the
//                  owner must classify.
//
//
// BOTH SCHEMAS SINCE 2026-08-21, and that is not tidiness. This audited `scm`
// only, so it could not see the table that produced the brand-letterhead
// defect: `public.project_brands`. Its report was then quoted as if it covered
// the multi-company surface, and the PUBLIC-schema half of that surface is
// real — projects / venues / brands / announcements / calendar events / ASSR
// service cases all live in `public` and all carry company_id (migs 0083 and
// 0093). A per-schema blind spot in an audit reads exactly like a clean result.
//
// `public` also holds the genuinely GLOBAL tables — users, roles, permissions,
// companies itself — so its NO-COMPANY list is long BY DESIGN and is not a
// defect list. Read it as "classify these", never as "fix these".
//
// No data is read beyond information_schema / pg_catalog. No writes.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function auditSchema(schema) {
  // Every base table in the schema + whether it carries company_id.
  const tables = await dst`
    SELECT t.table_name,
           EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema=${schema} AND c.table_name=t.table_name
                      AND c.column_name='company_id') AS has_cid
      FROM information_schema.tables t
     WHERE t.table_schema=${schema} AND t.table_type='BASE TABLE'
     ORDER BY t.table_name`;

  // Every UNIQUE / PK constraint + its columns, per table.
  const uniq = await dst`
    SELECT cl.relname AS table_name, c.conname, c.contype,
           array_agg(a.attname ORDER BY k.ord) AS cols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=cl.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=k.attnum
     WHERE n.nspname=${schema} AND c.contype IN ('u','p')
     GROUP BY cl.relname, c.conname, c.contype`;
  // Also unique INDEXES (many uniques are created as indexes, not constraints).
  const uidx = await dst`
    SELECT t.relname AS table_name, i.relname AS idxname,
           array_agg(a.attname ORDER BY k.ord) AS cols
      FROM pg_index ix
      JOIN pg_class i ON i.oid=ix.indexrelid
      JOIN pg_class t ON t.oid=ix.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
     WHERE n.nspname=${schema} AND ix.indisunique AND a.attnum > 0
     GROUP BY t.relname, i.relname`;

  const byTable = new Map();
  for (const r of [...uniq, ...uidx]) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push({ name: r.conname ?? r.idxname, cols: r.cols });
  }

  const landmines = [], scoped = [], noCompany = [];
  for (const t of tables) {
    const keys = byTable.get(t.table_name) ?? [];
    if (!t.has_cid) { noCompany.push(t.table_name); continue; }
    // A key is "safe" if it includes company_id OR is a surrogate PK on (id).
    const businessKeys = keys.filter((k) => {
      const cols = k.cols.map((c) => c.toLowerCase());
      if (cols.length === 1 && (cols[0] === 'id')) return false;      // surrogate PK — fine
      if (cols.includes('company_id')) return false;                   // already per-company
      return true;                                                     // GLOBAL business key
    });
    if (businessKeys.length > 0) {
      landmines.push({ table: t.table_name, keys: businessKeys.map((k) => `${k.name}(${k.cols.join(',')})`) });
    } else {
      scoped.push(t.table_name);
    }
  }

  notice(`=== ${schema}.* tables: ${tables.length} total ===`);
  notice("");
  notice(`### LANDMINE — per-company table with a GLOBAL unique key (breaks at company N): ${landmines.length}`);
  for (const l of landmines) notice(`  ${schema}.${l.table}: ${l.keys.join('  ')}`);
  notice("");
  notice(`### SCOPED-OK — has company_id, all uniques per-company or surrogate: ${scoped.length}`);
  notice(`  ${scoped.join(', ')}`);
  notice("");
  notice(`### NO-COMPANY — no company_id (shared, or an unscoped gap): ${noCompany.length}`);
  notice(`  ${noCompany.join(', ')}`);
  notice("");
}

async function main() {
  await auditSchema('scm');
  notice("");
  notice("");
  await auditSchema('public');
  notice("");
  notice("=== READ THIS ===");
  notice("LANDMINE is the list to fix BEFORE opening company 3: each needs its");
  notice("global UNIQUE(<key>) rebuilt as UNIQUE(company_id, <key>) — and any FK");
  notice("that points at <key> made composite. accounts.account_code is the one");
  notice("that already forced the '2990-' doc-number prefix hack.");
  notice("NO-COMPANY: cross-check against docs/MULTICOMPANY-MODULE-MAP.md — the");
  notice("ones listed SHARED there (currencies / my_localities / series / staff /");
  notice("chart-of-accounts-if-shared) are intentional; anything else is a gap.");
  notice("");
  notice("PUBLIC's NO-COMPANY list is LONG BY DESIGN — users, roles, permissions");
  notice("and companies itself are global on purpose. What to look for there is a");
  notice("table the ROUTES treat as per-company: project_cost_rates is keyed by a");
  notice("brand NAME, and brand names are NOT unique across companies.");
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("AUDIT_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
