#!/usr/bin/env node
/* check-report-money.mjs — READ-ONLY. Does what a money REPORT shows agree with
   the same figure recomputed from the underlying documents?

   Every section is a comparison, never a formula reading: the left column is
   what the report's own SQL/JS produces, the right column is an independent
   recompute from the source rows, and the section prints the DELTA, the row
   count and the worst single row. A section that finds nothing prints "agrees"
   — a report proven sound is a result.

   Writes nothing: SELECT only, no DDL, no transaction. Exits 0 for every
   legitimate answer (including "the relation does not exist" — that IS the
   answer for that section).

   SECTION=all|schema|raterate|aging|... node scripts/check-report-money.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const SECTION = (process.env.SECTION || 'all').trim().toLowerCase();
const LIMIT = Math.min(200, Number(process.env.LIMIT || 20));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;
const hr = (t) => note('\n' + '='.repeat(76) + '\n=== ' + t + '\n' + '='.repeat(76));

async function tryQ(label, fn, fallback = []) {
  try { return await fn(); } catch (e) {
    note(`  !! ${label} failed: ${e.code ?? ''} ${e.message}`);
    return fallback;
  }
}
const want = (s) => SECTION === 'all' || SECTION === s;

// ── 0. schema census — read the LIVE catalog, never a migration file ────────
async function schemaCensus() {
  hr('0. schema census (live catalog — pg_class / information_schema / pg_matviews)');

  const rateCols = await tryQ('project_cost_rates cols', () => sql`
    SELECT table_schema, column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'project_cost_rates'
     ORDER BY table_schema, ordinal_position`);
  note('project_cost_rates columns:');
  for (const c of rateCols) note(`   ${c.table_schema}.${c.column_name} :: ${c.data_type}`);
  if (!rateCols.length) note('   (relation not found)');

  const rateIdx = await tryQ('project_cost_rates indexes', () => sql`
    SELECT n.nspname AS schema, c.relname AS tbl, i.relname AS idx,
           ix.indisunique AS uniq, pg_get_indexdef(ix.indexrelid) AS def
      FROM pg_index ix
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'project_cost_rates'`);
  note('project_cost_rates indexes:');
  for (const r of rateIdx) note(`   ${r.schema}.${r.idx} unique=${r.uniq} :: ${r.def}`);
  if (!rateIdx.length) note('   (none)');

  const mvs = await tryQ('matviews', () => sql`
    SELECT schemaname, matviewname FROM pg_matviews ORDER BY 1,2`);
  note(`materialized views (${mvs.length}): ${mvs.map((m) => `${m.schemaname}.${m.matviewname}`).join(', ') || '(none)'}`);

  const senCols = await tryQ('sen/centi census', () => sql`
    SELECT count(*) FILTER (WHERE column_name LIKE '%\\_sen') AS sen,
           count(*) FILTER (WHERE column_name LIKE '%centi%') AS centi
      FROM information_schema.columns
     WHERE table_schema IN ('scm','public','connect')`);
  note(`money column census: *_sen=${senCols[0]?.sen} *centi*=${senCols[0]?.centi}`);
}

// ── 1. the Fair P&L rate card: is it company-scoped? ────────────────────────
async function rateCard() {
  hr('1. Fair P&L rate card (project_cost_rates) — brand-name keyed, company-blind?');

  const rows = await tryQ('rate rows', () => sql`
    SELECT * FROM project_cost_rates ORDER BY brand`);
  note(`rate rows: ${rows.length}`);
  for (const r of rows) note('   ' + JSON.stringify(r));

  // Duplicate brand keys — `WHERE brand = ?` + .first() picks an ARBITRARY row.
  const dupes = await tryQ('dupe brand keys', () => sql`
    SELECT brand, count(*)::int AS n FROM project_cost_rates
     GROUP BY brand HAVING count(*) > 1 ORDER BY 2 DESC`);
  note(`brands with MORE THAN ONE rate row (arbitrary pick): ${dupes.length}`);
  for (const d of dupes) note(`   brand=${JSON.stringify(d.brand)} rows=${d.n}`);

  // Case/whitespace collisions: the lookup is exact `brand = ?`, so
  // 'Bedframe' vs 'bedframe' is a MISS (no card => zero overhead), and two
  // spellings both matching one card is a silent share.
  const brandUse = await tryQ('project brands by company', () => sql`
    SELECT p.company_id, p.brand, count(*)::int AS projects
      FROM projects p
     WHERE p.brand IS NOT NULL AND btrim(p.brand) <> ''
     GROUP BY 1,2 ORDER BY 2,1`);
  note('\nprojects.brand usage by company:');
  for (const b of brandUse) note(`   company=${b.company_id} brand=${JSON.stringify(b.brand)} projects=${b.projects}`);

  const shared = await tryQ('brands shared across companies', () => sql`
    SELECT brand, count(DISTINCT company_id)::int AS companies,
           array_agg(DISTINCT company_id ORDER BY company_id) AS cos,
           count(*)::int AS projects
      FROM projects
     WHERE brand IS NOT NULL AND btrim(brand) <> ''
     GROUP BY brand HAVING count(DISTINCT company_id) > 1
     ORDER BY 2 DESC, 1`);
  note(`\nbrand names used by MORE THAN ONE company: ${shared.length}`);
  for (const s of shared) note(`   brand=${JSON.stringify(s.brand)} companies=${JSON.stringify(s.cos)} projects=${s.projects}`);
}

// ── 2. the auto cost lines the rate engine wrote vs what the rate says now ──
async function autoLines() {
  hr('2. project_finance_lines auto rows vs the rate card recomputed from source');

  // Recompute each project's auto lines the way projectCostRates.ts would, and
  // compare with the row that is actually stored (what /finance/by-project and
  // the Financial Snapshot SUM).
  const recomputed = await tryQ('auto-line recompute', () => sql`
    WITH base AS (
      SELECT p.id, p.company_id, btrim(p.brand) AS brand, p.archived_at,
             COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.category='sales'), 0) AS sales,
             COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost'
                 AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')), 0) AS cogs
        FROM projects p
        LEFT JOIN project_finance_lines l
               ON l.project_id = p.id AND l.archived_at IS NULL AND l.auto_source IS NULL
       GROUP BY p.id, p.company_id, p.brand, p.archived_at
    ), withrate AS (
      SELECT b.*, r.transport_pct, r.merchandise_pct, r.commission_normal_pct,
             r.commission_boost_pct, r.boost_min_gp_pct, r.boost_min_sales
        FROM base b LEFT JOIN project_cost_rates r ON r.brand = b.brand
    ), calc AS (
      SELECT w.*,
        CASE WHEN w.sales > 0 THEN ((w.sales - w.cogs) / w.sales) * 100 ELSE 0 END AS gp_pct
        FROM withrate w
    ), pick AS (
      SELECT c.*,
        CASE WHEN c.commission_boost_pct IS NOT NULL
              AND (c.boost_min_gp_pct IS NULL OR c.gp_pct >= c.boost_min_gp_pct)
              AND (c.boost_min_sales IS NULL OR c.sales >= c.boost_min_sales)
             THEN c.commission_boost_pct ELSE c.commission_normal_pct END AS comm_pct
        FROM calc c
    )
    SELECT id, company_id, brand, archived_at IS NOT NULL AS archived, sales, cogs,
           transport_pct IS NULL AS no_rate,
           round((sales * transport_pct / 100)::numeric, 2) AS want_transport,
           round((sales * merchandise_pct / 100)::numeric, 2) AS want_merchandise,
           round((sales * comm_pct / 100)::numeric, 2) AS want_commission
      FROM pick`);

  const stored = await tryQ('stored auto rows', () => sql`
    SELECT project_id,
           COALESCE(SUM(amount) FILTER (WHERE auto_source='auto:transport'), 0) AS got_transport,
           COALESCE(SUM(amount) FILTER (WHERE auto_source='auto:merchandise'), 0) AS got_merchandise,
           COALESCE(SUM(amount) FILTER (WHERE auto_source='auto:commission'), 0) AS got_commission,
           count(*)::int AS n
      FROM project_finance_lines
     WHERE auto_source IS NOT NULL AND archived_at IS NULL
     GROUP BY project_id`);
  const byId = new Map(stored.map((s) => [Number(s.project_id), s]));

  let bad = 0, worst = null, totalDelta = 0, noRate = 0;
  for (const r of recomputed) {
    if (r.archived) continue;
    const s = byId.get(Number(r.id)) || { got_transport: 0, got_merchandise: 0, got_commission: 0, n: 0 };
    if (r.no_rate) { noRate += 1; }
    const wt = Number(r.no_rate || Number(r.sales) <= 0 ? 0 : r.want_transport ?? 0);
    const wm = Number(r.no_rate || Number(r.sales) <= 0 ? 0 : r.want_merchandise ?? 0);
    const wc = Number(r.no_rate || Number(r.sales) <= 0 ? 0 : r.want_commission ?? 0);
    const d = Math.abs(Number(s.got_transport) - wt) + Math.abs(Number(s.got_merchandise) - wm) + Math.abs(Number(s.got_commission) - wc);
    if (d > 0.011) {
      bad += 1; totalDelta += d;
      if (!worst || d > worst.d) worst = { d, id: r.id, co: r.company_id, brand: r.brand, sales: r.sales, want: [wt, wm, wc], got: [Number(s.got_transport), Number(s.got_merchandise), Number(s.got_commission)] };
    }
  }
  note(`projects examined: ${recomputed.filter((r) => !r.archived).length}; without a rate card: ${noRate}`);
  note(`projects whose STORED auto cost lines disagree with the rate card recomputed: ${bad}`);
  note(`total absolute disagreement: RM ${totalDelta.toFixed(2)}`);
  if (worst) note(`worst row: project ${worst.id} (company ${worst.co}, brand ${JSON.stringify(worst.brand)}, sales ${worst.sales}) want=${JSON.stringify(worst.want)} got=${JSON.stringify(worst.got)} delta=RM ${worst.d.toFixed(2)}`);
  if (!bad) note('AGREES — every live project\'s auto cost lines match the rate card.');
}

async function main() {
  note(`check-report-money — section=${SECTION} — READ ONLY`);
  if (want('schema')) await schemaCensus();
  if (want('raterate') || want('ratecard')) await rateCard();
  if (want('autolines')) await autoLines();
  await sql.end({ timeout: 5 });
}

main().catch((e) => { console.error(e); process.exit(1); });
