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

   SECTION=all|schema|ratecard|autolines|pnl|aging node scripts/check-report-money.mjs */
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
const WANTED = new Set(SECTION.split(/[,+ ]+/).filter(Boolean));
const want = (s) => WANTED.has('all') || WANTED.has(s);

// ── 0. schema census — read the LIVE catalog, never a migration file ────────
async function schemaCensus() {
  hr('0. schema census (live catalog — pg_index / information_schema / pg_matviews)');

  const rateCols = await tryQ('project_cost_rates cols', () => sql`
    SELECT table_schema, column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'project_cost_rates'
     ORDER BY table_schema, ordinal_position`);
  note('project_cost_rates columns:');
  for (const c of rateCols) note(`   ${c.table_schema}.${c.column_name} :: ${c.data_type}`);
  if (!rateCols.length) note('   (relation not found)');

  const rateIdx = await tryQ('project_cost_rates indexes', () => sql`
    SELECT n.nspname AS schema, i.relname AS idx, ix.indisunique AS uniq,
           pg_get_indexdef(ix.indexrelid) AS def
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

  // The _centi -> _sen rename (mig 0305). A leftover *centi* column next to a
  // *_sen twin is exactly where a factor-of-100 hides, so name them.
  const centi = await tryQ('centi survivors', () => sql`
    SELECT c.table_schema, c.table_name, c.column_name, t.table_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.column_name LIKE '%centi%'
     ORDER BY 1,2,3`);
  note(`columns still named *centi*: ${centi.length}`);
  const byKind = {};
  for (const c of centi) {
    const k = `${c.table_schema}|${c.table_type}`;
    (byKind[k] ||= []).push(`${c.table_name}.${c.column_name}`);
  }
  for (const [k, v] of Object.entries(byKind)) note(`   ${k}: ${v.length} — e.g. ${v.slice(0, 6).join(', ')}`);

  const twins = await tryQ('centi/sen twins', () => sql`
    SELECT a.table_schema, a.table_name, a.column_name AS centi_col
      FROM information_schema.columns a
     WHERE a.column_name LIKE '%centi%'
       AND EXISTS (SELECT 1 FROM information_schema.columns b
                    WHERE b.table_schema = a.table_schema AND b.table_name = a.table_name
                      AND b.column_name = replace(a.column_name, 'centi', 'sen'))
     ORDER BY 1,2,3`);
  note(`*centi* columns that ALSO have a *_sen twin on the same relation (two homes for one number): ${twins.length}`);
  for (const t of twins.slice(0, 40)) note(`   ${t.table_schema}.${t.table_name}.${t.centi_col}`);
}

// ── 1. the Fair P&L rate card: is it company-scoped? ────────────────────────
async function rateCard() {
  hr('1. Fair P&L rate card (project_cost_rates) — brand-name keyed, company-blind?');

  const rows = await tryQ('rate rows', () => sql`SELECT * FROM project_cost_rates ORDER BY brand`);
  note(`rate rows: ${rows.length}`);
  for (const r of rows) note('   ' + JSON.stringify(r));

  const dupes = await tryQ('dupe brand keys', () => sql`
    SELECT brand, count(*)::int AS n FROM project_cost_rates
     GROUP BY brand HAVING count(*) > 1 ORDER BY 2 DESC`);
  note(`brands with MORE THAN ONE rate row (lookup would pick an arbitrary one): ${dupes.length}`);
  for (const d of dupes) note(`   brand=${JSON.stringify(d.brand)} rows=${d.n}`);

  const brandUse = await tryQ('project brands by company', () => sql`
    SELECT p.company_id, p.brand, count(*)::int AS projects
      FROM projects p
     WHERE p.brand IS NOT NULL AND btrim(p.brand) <> '' AND p.archived_at IS NULL
     GROUP BY 1,2 ORDER BY 2,1`);
  note('\nlive projects.brand usage by company:');
  for (const b of brandUse) note(`   company=${b.company_id} brand=${JSON.stringify(b.brand)} projects=${b.projects}`);

  const shared = await tryQ('brands shared across companies', () => sql`
    SELECT brand, array_agg(DISTINCT company_id ORDER BY company_id) AS cos, count(*)::int AS projects
      FROM projects
     WHERE brand IS NOT NULL AND btrim(brand) <> '' AND archived_at IS NULL
     GROUP BY brand HAVING count(DISTINCT company_id) > 1
     ORDER BY 1`);
  note(`\nbrand names used by MORE THAN ONE company (one rate card serves both): ${shared.length}`);
  for (const s of shared) note(`   brand=${JSON.stringify(s.brand)} companies=${JSON.stringify(s.cos)} projects=${s.projects}`);

  // How much money does the shared card actually drive on the MINORITY company?
  const bleed = await tryQ('minority-company overhead', () => sql`
    WITH shared AS (
      SELECT brand FROM projects
       WHERE brand IS NOT NULL AND btrim(brand) <> '' AND archived_at IS NULL
       GROUP BY brand HAVING count(DISTINCT company_id) > 1
    )
    SELECT p.id, p.company_id, p.code, p.brand,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.category='sales' AND l.auto_source IS NULL AND l.archived_at IS NULL), 0) AS sales,
           COALESCE(SUM(l.amount) FILTER (WHERE l.auto_source IS NOT NULL AND l.archived_at IS NULL), 0) AS auto_overhead
      FROM projects p
      JOIN shared s ON s.brand = p.brand
      LEFT JOIN project_finance_lines l ON l.project_id = p.id
     WHERE p.archived_at IS NULL
     GROUP BY 1,2,3,4
     HAVING COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.category='sales' AND l.auto_source IS NULL AND l.archived_at IS NULL), 0) > 0
     ORDER BY p.company_id DESC, sales DESC LIMIT 20`);
  note('\nprojects on a SHARED brand name, by company (the card that priced them is company-blind):');
  for (const b of bleed) note(`   project ${b.id} co=${b.company_id} ${JSON.stringify(b.code)} brand=${JSON.stringify(b.brand)} sales=RM ${Number(b.sales).toFixed(2)} auto_overhead=RM ${Number(b.auto_overhead).toFixed(2)}`);
}

// ── 2. auto cost lines stored vs the rate card recomputed from source ───────
async function autoLines() {
  hr('2. project_finance_lines auto rows vs the rate card recomputed from source');

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
      SELECT w.*, CASE WHEN w.sales > 0 THEN ((w.sales - w.cogs) / w.sales) * 100 ELSE 0 END AS gp_pct
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

  let bad = 0, worst = null, totalDelta = 0, noRate = 0, missingAll = 0, live = 0;
  let wantSum = 0, gotSum = 0;
  for (const r of recomputed) {
    if (r.archived) continue;
    live += 1;
    const s = byId.get(Number(r.id)) || { got_transport: 0, got_merchandise: 0, got_commission: 0, n: 0 };
    if (r.no_rate) noRate += 1;
    const zero = r.no_rate || Number(r.sales) <= 0;
    const wt = zero ? 0 : Number(r.want_transport ?? 0);
    const wm = zero ? 0 : Number(r.want_merchandise ?? 0);
    const wc = zero ? 0 : Number(r.want_commission ?? 0);
    const gt = Number(s.got_transport), gm = Number(s.got_merchandise), gc = Number(s.got_commission);
    wantSum += wt + wm + wc; gotSum += gt + gm + gc;
    const d = Math.abs(gt - wt) + Math.abs(gm - wm) + Math.abs(gc - wc);
    if (d > 0.011) {
      bad += 1; totalDelta += d;
      if (s.n === 0 && (wt || wm || wc)) missingAll += 1;
      if (!worst || d > worst.d) worst = { d, id: r.id, co: r.company_id, brand: r.brand, sales: r.sales, want: [wt, wm, wc], got: [gt, gm, gc] };
    }
  }
  note(`live (unarchived) projects examined: ${live}; with no rate card for their brand: ${noRate}`);
  note(`projects whose STORED auto cost lines disagree with the rate card recomputed: ${bad}`);
  note(`  ...of those, projects carrying NO auto rows at all while the card says they should: ${missingAll}`);
  note(`stored auto overhead total:     RM ${gotSum.toFixed(2)}`);
  note(`rate-card recomputed total:     RM ${wantSum.toFixed(2)}`);
  note(`DELTA (recomputed − stored):    RM ${(wantSum - gotSum).toFixed(2)}`);
  note(`total ABSOLUTE disagreement:    RM ${totalDelta.toFixed(2)}`);
  if (worst) note(`worst row: project ${worst.id} (company ${worst.co}, brand ${JSON.stringify(worst.brand)}, sales RM ${Number(worst.sales).toFixed(2)}) want=[T ${worst.want[0]}, M ${worst.want[1]}, C ${worst.want[2]}] got=[T ${worst.got[0]}, M ${worst.got[1]}, C ${worst.got[2]}] delta=RM ${worst.d.toFixed(2)}`);
  if (!bad) note("AGREES — every live project's auto cost lines match the rate card.");

  // Which side is stale? If auto rows exist but the sales base moved, the row
  // is stale; if none exist at all the engine never ran for that project.
  const ages = await tryQ('auto row ages', () => sql`
    SELECT count(*)::int AS auto_rows,
           count(DISTINCT project_id)::int AS projects_with_auto,
           min(created_at)::text AS oldest, max(created_at)::text AS newest
      FROM project_finance_lines WHERE auto_source IS NOT NULL AND archived_at IS NULL`);
  note('auto row census: ' + JSON.stringify(ages[0] ?? {}));
}

// ── 3. legacy cross-module P&L (/api/finance/pnl) row set ───────────────────
async function pnlRowSet() {
  hr('3. /api/finance/pnl — revenue + cost row set vs the source documents');

  const soCols = await tryQ('sales_orders cols', () => sql`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sales_orders' ORDER BY ordinal_position`);
  note('sales_orders columns: ' + soCols.map((c) => c.column_name).join(', '));

  const pflCols = await tryQ('project_finance_lines cols', () => sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='project_finance_lines' ORDER BY ordinal_position`);
  note('project_finance_lines columns: ' + pflCols.map((c) => c.column_name).join(', '));

  const assrCols = await tryQ('assr_cases cols', () => sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='assr_cases' ORDER BY ordinal_position`);
  note('assr_cases columns: ' + assrCols.map((c) => c.column_name).join(', '));

  // 3a — cancelled sales orders inside the report's revenue window.
  const cancelCol = soCols.find((c) => /cancel/i.test(c.column_name))?.column_name;
  const hasStatus = soCols.some((c) => c.column_name === 'doc_status');
  note(`\n3a. revenue arm: sales_orders cancellation marker = ${cancelCol ?? '(none)'}; doc_status present = ${hasStatus}`);
  if (cancelCol) {
    const dist = await tryQ('cancel marker distribution', () => sql`
      SELECT company_id, ${sql(cancelCol)}::text AS marker, count(*)::int AS n,
             COALESCE(SUM(COALESCE(local_total,0)),0) AS amt
        FROM sales_orders WHERE doc_date IS NOT NULL
       GROUP BY 1,2 ORDER BY 1,4 DESC LIMIT 20`);
    note(`   ${cancelCol} distribution over dated sales_orders:`);
    for (const d of dist) note(`     company=${d.company_id} ${cancelCol}=${JSON.stringify(d.marker)} rows=${d.n} RM ${Number(d.amt).toFixed(2)}`);
  }
  if (hasStatus) {
    const dist = await tryQ('doc_status distribution', () => sql`
      SELECT company_id, doc_status::text AS st, count(*)::int AS n,
             COALESCE(SUM(COALESCE(local_total,0)),0) AS amt
        FROM sales_orders WHERE doc_date IS NOT NULL
       GROUP BY 1,2 ORDER BY 1,4 DESC LIMIT 20`);
    note('   doc_status distribution over dated sales_orders:');
    for (const d of dist) note(`     company=${d.company_id} doc_status=${JSON.stringify(d.st)} rows=${d.n} RM ${Number(d.amt).toFixed(2)}`);
  }

  // 3b — cost lines the company-scoped pull silently DROPS (company_id NULL).
  const hasCo = pflCols.some((c) => c.column_name === 'company_id');
  note(`\n3b. cost arm: project_finance_lines.company_id present = ${hasCo}`);
  if (hasCo) {
    const orph = await tryQ('null-company cost lines', () => sql`
      SELECT l.company_id IS NULL AS unscoped, l.auto_source IS NOT NULL AS is_auto,
             count(*)::int AS n, COALESCE(SUM(COALESCE(l.amount,0)),0) AS amt
        FROM project_finance_lines l
        JOIN projects p ON p.id = l.project_id AND p.archived_at IS NULL
       WHERE l.kind='cost' AND l.archived_at IS NULL
       GROUP BY 1,2 ORDER BY 1 DESC, 2`);
    note('   live cost lines by scoping (this is what /finance/pnl sums):');
    for (const r of orph) note(`     company_id_null=${r.unscoped} auto=${r.is_auto} lines=${r.n} RM ${Number(r.amt).toFixed(2)}`);

    const mism = await tryQ('cost line company mismatch', () => sql`
      SELECT count(*)::int AS n, COALESCE(SUM(COALESCE(l.amount,0)),0) AS amt
        FROM project_finance_lines l
        JOIN projects p ON p.id = l.project_id AND p.archived_at IS NULL
       WHERE l.kind='cost' AND l.archived_at IS NULL
         AND l.company_id IS NOT NULL AND p.company_id IS NOT NULL
         AND l.company_id <> p.company_id`);
    note(`   cost lines whose company_id DISAGREES with their project's: ${mism[0]?.n} (RM ${Number(mism[0]?.amt ?? 0).toFixed(2)})`);

    const worst = await tryQ('worst unscoped project', () => sql`
      SELECT p.id, p.company_id, p.code, p.name,
             COALESCE(SUM(COALESCE(l.amount,0)),0) AS amt, count(*)::int AS n
        FROM project_finance_lines l
        JOIN projects p ON p.id = l.project_id AND p.archived_at IS NULL
       WHERE l.kind='cost' AND l.archived_at IS NULL AND l.company_id IS NULL
       GROUP BY 1,2,3,4 ORDER BY amt DESC LIMIT 5`);
    note('   worst projects hidden from a company-scoped cost total:');
    for (const w of worst) note(`     project ${w.id} project.company_id=${w.company_id} ${JSON.stringify(w.code)} lines=${w.n} RM ${Number(w.amt).toFixed(2)}`);

    // Income side too — the report only pulls cost from here, but an unscoped
    // income line would distort any per-company ledger view.
    const inc = await tryQ('income scoping', () => sql`
      SELECT l.company_id IS NULL AS unscoped, count(*)::int AS n,
             COALESCE(SUM(COALESCE(l.amount,0)),0) AS amt
        FROM project_finance_lines l
        JOIN projects p ON p.id = l.project_id AND p.archived_at IS NULL
       WHERE l.kind='income' AND l.archived_at IS NULL
       GROUP BY 1 ORDER BY 1 DESC`);
    note('   live INCOME lines by scoping:');
    for (const r of inc) note(`     company_id_null=${r.unscoped} lines=${r.n} RM ${Number(r.amt).toFixed(2)}`);
  }

  // 3c — assr_cases (service cost) unscoped rows.
  if (assrCols.some((c) => c.column_name === 'company_id')) {
    const a = await tryQ('assr null company', () => sql`
      SELECT company_id IS NULL AS unscoped, count(*)::int AS n,
             COALESCE(SUM(COALESCE(po_amount,0)),0) AS amt
        FROM assr_cases WHERE po_amount IS NOT NULL AND archived_at IS NULL
       GROUP BY 1 ORDER BY 1 DESC`);
    note('\n3c. service cost (assr_cases) by company scoping:');
    for (const r of a) note(`   company_id_null=${r.unscoped} cases=${r.n} RM ${Number(r.amt).toFixed(2)}`);
  }
}

// ── 4. AR aging snapshot (scm.mv_ar_aging) vs the live rule ─────────────────
async function arAging() {
  hr('4. AR aging: scm.mv_ar_aging snapshot vs the live Outstanding rule');

  const cols = await tryQ('mv cols', () => sql`
    SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
      FROM pg_attribute a
     WHERE a.attrelid = 'scm.mv_ar_aging'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`);
  note('mv_ar_aging columns: ' + cols.map((c) => `${c.col}::${c.typ}`).join(', '));

  const def = await tryQ('mv def', () => sql`
    SELECT pg_get_viewdef('scm.mv_ar_aging'::regclass, true) AS d`, [{ d: null }]);
  note('\n--- deployed definition (truncated to 3000 chars) ---\n' + String(def[0]?.d ?? '(missing)').slice(0, 3000));

  const meta = await tryQ('mv meta', () => sql`SELECT * FROM scm.mv_ar_aging_meta`);
  note('mv_ar_aging_meta: ' + JSON.stringify(meta));

  const snap = await tryQ('mv rows', () => sql`SELECT * FROM scm.mv_ar_aging ORDER BY company_id, module`);
  note('\nsnapshot rows:');
  for (const r of snap) note('   ' + JSON.stringify(r));

  const live = await tryQ('live recompute', () => sql`
    SELECT COALESCE(company_id,0)::bigint AS company_id, 'po'::text AS module, count(*)::bigint AS cnt,
           COALESCE(SUM(total_sen),0)::bigint AS total_sen, 0::bigint AS total_outstanding_sen
      FROM scm.v_po_outstanding WHERE is_outstanding GROUP BY 1
    UNION ALL SELECT COALESCE(company_id,0)::bigint, 'grn'::text, count(*)::bigint, 0::bigint, 0::bigint
      FROM scm.v_grn_outstanding WHERE is_outstanding GROUP BY 1
    UNION ALL SELECT COALESCE(company_id,0)::bigint, 'pi'::text, count(*)::bigint,
           COALESCE(SUM(total_sen),0)::bigint, COALESCE(SUM(outstanding_sen),0)::bigint
      FROM scm.v_pi_outstanding WHERE is_outstanding GROUP BY 1
    UNION ALL SELECT COALESCE(company_id,0)::bigint, 'pr'::text, count(*)::bigint, 0::bigint, 0::bigint
      FROM scm.v_pr_outstanding WHERE is_outstanding GROUP BY 1
    UNION ALL SELECT COALESCE(company_id,0)::bigint, 'so'::text, count(*)::bigint,
           COALESCE(SUM(local_total_sen),0)::bigint, 0::bigint
      FROM scm.v_so_outstanding WHERE is_outstanding GROUP BY 1
    UNION ALL SELECT COALESCE(company_id,0)::bigint, 'do'::text, count(*)::bigint, 0::bigint, 0::bigint
      FROM scm.v_do_outstanding WHERE is_outstanding GROUP BY 1
    UNION ALL SELECT COALESCE(company_id,0)::bigint, 'si'::text, count(*)::bigint,
           COALESCE(SUM(total_sen),0)::bigint, COALESCE(SUM(outstanding_sen),0)::bigint
      FROM scm.v_si_outstanding WHERE is_outstanding AND status <> 'DRAFT' GROUP BY 1
    ORDER BY 1,2`);
  note('\nlive recompute (endpoint predicates, now):');
  for (const r of live) note('   ' + JSON.stringify(r));

  const key = (r) => `${r.company_id}/${r.module}`;
  const sm = new Map(snap.map((r) => [key(r), r]));
  let disagree = 0;
  for (const l of live) {
    const s = sm.get(key(l));
    const d = {
      cnt: Number(s?.cnt ?? 0) - Number(l.cnt),
      total: Number(s?.total_sen ?? 0) - Number(l.total_sen),
      outs: Number(s?.total_outstanding_sen ?? 0) - Number(l.total_outstanding_sen),
    };
    if (d.cnt || d.total || d.outs) {
      disagree += 1;
      note(`   DELTA ${key(l)}: snapshot-minus-live cnt=${d.cnt} total=${rm(d.total)} outstanding=${rm(d.outs)}`);
    }
  }
  const draft = await tryQ('SI status census', () => sql`
    SELECT COALESCE(company_id,0) AS company_id, status, count(*)::int AS n,
           COALESCE(SUM(total_sen),0)::bigint AS total_sen,
           COALESCE(SUM(outstanding_sen),0)::bigint AS outstanding_sen
      FROM scm.v_si_outstanding WHERE is_outstanding GROUP BY 1,2 ORDER BY 1,2`);
  note('\nv_si_outstanding by status (is_outstanding rows only):');
  for (const r of draft) note('   ' + JSON.stringify(r));
  note(`\nmodules where the snapshot disagrees with a live recompute: ${disagree}`);
  if (!disagree) note('AGREES — the nightly snapshot reproduces the live rule exactly.');
}

// ── 5. WHY the stored auto lines disagree — the rate the row itself names ───
// Every auto row carries its own rate in the description ("Commission (auto ·
// 14% of sales)"). Parsing it says whether the row was written under a DIFFERENT
// card than the one the Fair P&L reads today — a rate-card edit that never
// reached the ledger — or whether only the sales base moved underneath it.
async function autoWhy() {
  hr('5. stored auto cost lines: which rate does the ROW ITSELF claim vs the card?');

  const rows = await tryQ('auto rows with pct', () => sql`
    SELECT l.auto_source, p.company_id, p.brand,
           substring(l.description from '([0-9]+(?:\\.[0-9]+)?)%') AS row_pct,
           r.transport_pct, r.merchandise_pct, r.commission_normal_pct, r.commission_boost_pct,
           count(*)::int AS n, COALESCE(SUM(l.amount),0) AS amt
      FROM project_finance_lines l
      JOIN projects p ON p.id = l.project_id AND p.archived_at IS NULL
      LEFT JOIN project_cost_rates r ON r.brand = btrim(p.brand)
     WHERE l.auto_source IS NOT NULL AND l.archived_at IS NULL
     GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 3,1,4`);
  note('auto rows grouped by (source, company, brand, the % the row names):');
  for (const r of rows) {
    const card =
      r.auto_source === 'auto:transport' ? r.transport_pct :
      r.auto_source === 'auto:merchandise' ? r.merchandise_pct : `${r.commission_normal_pct}/${r.commission_boost_pct}`;
    const flag = r.auto_source === 'auto:commission'
      ? (String(r.row_pct) !== String(r.commission_normal_pct) && String(r.row_pct) !== String(r.commission_boost_pct) ? '  <-- MATCHES NEITHER CARD RATE' : '')
      : (String(r.row_pct) !== String(card) ? '  <-- DISAGREES WITH CARD' : '');
    note(`   ${r.auto_source} co=${r.company_id} brand=${JSON.stringify(r.brand)} row_says=${r.row_pct}% card_says=${card}% rows=${r.n} RM ${Number(r.amt).toFixed(2)}${flag}`);
  }

  // Split the disagreement into its two causes.
  const causes = await tryQ('mismatch causes', () => sql`
    WITH base AS (
      SELECT p.id, p.company_id, btrim(p.brand) AS brand,
             COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.category='sales' AND l.auto_source IS NULL AND l.archived_at IS NULL), 0) AS sales
        FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
       WHERE p.archived_at IS NULL
       GROUP BY 1,2,3
    ), got AS (
      SELECT project_id,
             COALESCE(SUM(amount) FILTER (WHERE auto_source='auto:commission'),0) AS comm,
             substring(max(description) FILTER (WHERE auto_source='auto:commission') from '([0-9]+(?:\\.[0-9]+)?)%') AS row_pct,
             count(*)::int AS n
        FROM project_finance_lines WHERE auto_source IS NOT NULL AND archived_at IS NULL
       GROUP BY 1
    )
    SELECT b.company_id, b.brand,
           count(*) FILTER (WHERE g.n IS NULL AND b.sales > 0)::int AS no_auto_rows_at_all,
           count(*) FILTER (WHERE g.n IS NOT NULL AND b.sales > 0
                             AND abs(g.comm - (b.sales * g.row_pct::numeric / 100)) > 0.011)::int AS base_moved_under_row,
           count(*) FILTER (WHERE g.n IS NOT NULL AND b.sales > 0
                             AND abs(g.comm - (b.sales * g.row_pct::numeric / 100)) <= 0.011)::int AS row_self_consistent,
           COALESCE(SUM(b.sales) FILTER (WHERE g.n IS NULL AND b.sales > 0),0) AS sales_with_no_auto
      FROM base b LEFT JOIN got g ON g.project_id = b.id
     GROUP BY 1,2 ORDER BY 1,2`);
  note('\nmismatch causes per (company, brand):');
  for (const c of causes) note(`   co=${c.company_id} brand=${JSON.stringify(c.brand)} no_auto_rows=${c.no_auto_rows_at_all} (sales RM ${Number(c.sales_with_no_auto).toFixed(2)}) sales_base_moved=${c.base_moved_under_row} self_consistent=${c.row_self_consistent}`);
}

// ── 6. Fair Report money vs the SO's own document ───────────────────────────
// fairSoMoney reads SIX denormalised header columns. `amount` comes from
// local_total_sen; the category split next to it comes from the four product
// columns + service. If those two disagree the printed row does not add up, and
// summarizeSo's totals inherit the gap. total_cost_sen drives margin_pct while
// the cost BREAKDOWN beside it comes from five other columns.
async function fairVsDoc() {
  hr('6. Fair Report (stage=so/pnl): header money vs the SO lines and the header split');

  const cols = await tryQ('mfg_sales_orders cols', () => sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='scm' AND table_name='mfg_sales_orders' AND column_name LIKE '%_sen'
     ORDER BY 1`);
  note('mfg_sales_orders money columns: ' + cols.map((c) => c.column_name).join(', '));

  const itemCols = await tryQ('mfg_sales_order_items cols', () => sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='scm' AND table_name='mfg_sales_order_items'
     ORDER BY ordinal_position`);
  note('mfg_sales_order_items columns: ' + itemCols.map((c) => c.column_name).join(', '));

  // 6a — local_total_sen vs the FIVE revenue columns the report splits it into.
  const split = await tryQ('header revenue split', () => sql`
    SELECT company_id, status,
           count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(local_total_sen,0) <>
                 COALESCE(mattress_sofa_sen,0)+COALESCE(bedframe_sen,0)+COALESCE(accessories_sen,0)
                 +COALESCE(others_sen,0)+COALESCE(service_sen,0))::int AS mismatched,
           COALESCE(SUM(COALESCE(local_total_sen,0) -
                 (COALESCE(mattress_sofa_sen,0)+COALESCE(bedframe_sen,0)+COALESCE(accessories_sen,0)
                  +COALESCE(others_sen,0)+COALESCE(service_sen,0))),0)::bigint AS delta_sen
      FROM scm.mfg_sales_orders
     GROUP BY 1,2 ORDER BY 1,2`);
  note('\n6a. local_total_sen  vs  (mattress_sofa+bedframe+accessories+others+service):');
  for (const r of split) note(`   co=${r.company_id} status=${r.status} docs=${r.docs} mismatched=${r.mismatched} sum(local_total-split)=${rm(r.delta_sen)}`);

  const worstSplit = await tryQ('worst split', () => sql`
    SELECT doc_no, company_id, status, local_total_sen,
           COALESCE(mattress_sofa_sen,0)+COALESCE(bedframe_sen,0)+COALESCE(accessories_sen,0)
           +COALESCE(others_sen,0)+COALESCE(service_sen,0) AS split_sen
      FROM scm.mfg_sales_orders
     WHERE COALESCE(local_total_sen,0) <>
           COALESCE(mattress_sofa_sen,0)+COALESCE(bedframe_sen,0)+COALESCE(accessories_sen,0)
           +COALESCE(others_sen,0)+COALESCE(service_sen,0)
     ORDER BY abs(COALESCE(local_total_sen,0) -
           (COALESCE(mattress_sofa_sen,0)+COALESCE(bedframe_sen,0)+COALESCE(accessories_sen,0)
            +COALESCE(others_sen,0)+COALESCE(service_sen,0))) DESC LIMIT 10`);
  note('   worst rows (the Fair Report prints amount from the left and the split from the right):');
  for (const w of worstSplit) note(`     ${w.doc_no} co=${w.company_id} ${w.status} local_total=${rm(w.local_total_sen)} split=${rm(w.split_sen)} delta=${rm(Number(w.local_total_sen ?? 0) - Number(w.split_sen))}`);

  // 6b — total_cost_sen vs the five cost columns shown beside it.
  const costSplit = await tryQ('header cost split', () => sql`
    SELECT company_id, status, count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(total_cost_sen,0) <>
                 COALESCE(mattress_sofa_cost_sen,0)+COALESCE(bedframe_cost_sen,0)
                 +COALESCE(accessories_cost_sen,0)+COALESCE(others_cost_sen,0)+COALESCE(service_cost_sen,0))::int AS mismatched,
           COALESCE(SUM(COALESCE(total_cost_sen,0) -
                 (COALESCE(mattress_sofa_cost_sen,0)+COALESCE(bedframe_cost_sen,0)
                  +COALESCE(accessories_cost_sen,0)+COALESCE(others_cost_sen,0)+COALESCE(service_cost_sen,0))),0)::bigint AS delta_sen
      FROM scm.mfg_sales_orders
     GROUP BY 1,2 ORDER BY 1,2`);
  note('\n6b. total_cost_sen  vs  (the five *_cost_sen columns the report lists beside it):');
  for (const r of costSplit) note(`   co=${r.company_id} status=${r.status} docs=${r.docs} mismatched=${r.mismatched} sum(total_cost-split)=${rm(r.delta_sen)}`);

  // 6c — header vs the SO's own LINES (the document itself).
  const vsLines = await tryQ('header vs lines', () => sql`
    WITH li AS (
      SELECT doc_no AS so_doc_no, COALESCE(SUM(total_sen),0)::bigint AS lines_sen, count(*)::int AS n
        FROM scm.mfg_sales_order_items
       WHERE COALESCE(cancelled,false) = false
       GROUP BY 1
    )
    SELECT h.company_id, h.status, count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(h.local_total_sen,0) <> COALESCE(li.lines_sen,0))::int AS mismatched,
           COALESCE(SUM(COALESCE(h.local_total_sen,0) - COALESCE(li.lines_sen,0)),0)::bigint AS delta_sen
      FROM scm.mfg_sales_orders h LEFT JOIN li ON li.so_doc_no = h.doc_no
     GROUP BY 1,2 ORDER BY 1,2`);
  note('\n6c. local_total_sen  vs  SUM(non-cancelled line_total_sen) — the document itself:');
  for (const r of vsLines) note(`   co=${r.company_id} status=${r.status} docs=${r.docs} mismatched=${r.mismatched} sum(header-lines)=${rm(r.delta_sen)}`);

  const worstLines = await tryQ('worst header-vs-lines', () => sql`
    WITH li AS (
      SELECT doc_no AS so_doc_no, COALESCE(SUM(total_sen),0)::bigint AS lines_sen
        FROM scm.mfg_sales_order_items WHERE COALESCE(cancelled,false) = false GROUP BY 1
    )
    SELECT h.doc_no, h.company_id, h.status, h.local_total_sen, COALESCE(li.lines_sen,0) AS lines_sen
      FROM scm.mfg_sales_orders h LEFT JOIN li ON li.so_doc_no = h.doc_no
     WHERE h.status = 'CONFIRMED' AND COALESCE(h.local_total_sen,0) <> COALESCE(li.lines_sen,0)
     ORDER BY abs(COALESCE(h.local_total_sen,0) - COALESCE(li.lines_sen,0)) DESC LIMIT 10`);
  note('   worst CONFIRMED rows (CONFIRMED is exactly the Fair Report row set):');
  for (const w of worstLines) note(`     ${w.doc_no} co=${w.company_id} header=${rm(w.local_total_sen)} lines=${rm(w.lines_sen)} delta=${rm(Number(w.local_total_sen ?? 0) - Number(w.lines_sen))}`);

  // 6d — the delivery-fee service family is a PREFIX, not three fixed codes.
  const svc = await tryQ('service line codes', () => sql`
    SELECT item_code, count(*)::int AS n, COALESCE(SUM(total_sen),0)::bigint AS amt
      FROM scm.mfg_sales_order_items
     WHERE COALESCE(cancelled,false) = false AND item_code LIKE 'SVC-%'
     GROUP BY 1 ORDER BY 3 DESC`);
  note('\n6d. SVC-% service lines actually present on live SOs:');
  for (const r of svc) note(`   ${r.item_code} lines=${r.n} ${rm(r.amt)}`);

  const svcVsHeader = await tryQ('service_sen vs svc lines', () => sql`
    WITH s AS (
      SELECT doc_no AS so_doc_no, COALESCE(SUM(total_sen),0)::bigint AS svc_sen
        FROM scm.mfg_sales_order_items
       WHERE COALESCE(cancelled,false) = false AND item_code LIKE 'SVC-%'
       GROUP BY 1
    )
    SELECT h.company_id, h.status, count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(h.service_sen,0) <> COALESCE(s.svc_sen,0))::int AS mismatched,
           COALESCE(SUM(COALESCE(h.service_sen,0) - COALESCE(s.svc_sen,0)),0)::bigint AS delta_sen
      FROM scm.mfg_sales_orders h LEFT JOIN s ON s.so_doc_no = h.doc_no
     GROUP BY 1,2 ORDER BY 1,2`);
  note('   header service_sen vs SUM(SVC-% total_sen):');
  for (const r of svcVsHeader) note(`     co=${r.company_id} status=${r.status} docs=${r.docs} mismatched=${r.mismatched} delta=${rm(r.delta_sen)}`);

  // 6e — TWO revenue columns on one header. The Fair Report reads
  // local_total_sen; /api/pos/sales-stats SUMs total_revenue_sen. If they ever
  // differ, one order reports two different revenues to two dashboards.
  const twoRev = await tryQ('local_total vs total_revenue', () => sql`
    SELECT company_id, status, count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(local_total_sen,0) <> COALESCE(total_revenue_sen,0))::int AS mismatched,
           COALESCE(SUM(COALESCE(local_total_sen,0) - COALESCE(total_revenue_sen,0)),0)::bigint AS delta_sen
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 1,2`);
  note('\n6e. local_total_sen (Fair Report) vs total_revenue_sen (POS sales-stats) on the SAME header:');
  for (const r of twoRev) note(`   co=${r.company_id} status=${r.status} docs=${r.docs} mismatched=${r.mismatched} delta=${rm(r.delta_sen)}`);

  // 6f — total_margin_sen vs (revenue - cost). marginPct in the report is
  // recomputed from amount/total_cost; the stored margin column is a third home.
  const marg = await tryQ('margin column', () => sql`
    SELECT company_id, status, count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(total_margin_sen,0) <> COALESCE(local_total_sen,0) - COALESCE(total_cost_sen,0))::int AS mismatched,
           COALESCE(SUM(COALESCE(total_margin_sen,0) - (COALESCE(local_total_sen,0) - COALESCE(total_cost_sen,0))),0)::bigint AS delta_sen
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 1,2`);
  note('\n6f. stored total_margin_sen vs (local_total_sen - total_cost_sen), the report\'s own rule:');
  for (const r of marg) note(`   co=${r.company_id} status=${r.status} docs=${r.docs} mismatched=${r.mismatched} delta=${rm(r.delta_sen)}`);

  // 6g — header paid_sen / balance_sen vs the LIVE payment ledger. The Fair
  // Report prints balance_sen from the header but decides below_deposit from
  // the ledger, so a divergence makes the two cells on one row disagree.
  const paid = await tryQ('paid vs ledger', () => sql`
    WITH p AS (
      SELECT so_doc_no, COALESCE(SUM(amount_sen),0)::bigint AS ledger_sen
        FROM scm.mfg_sales_order_payments GROUP BY 1
    )
    SELECT h.company_id, h.status, count(*)::int AS docs,
           count(*) FILTER (WHERE COALESCE(h.paid_sen,0) <> COALESCE(p.ledger_sen,0))::int AS paid_mismatch,
           COALESCE(SUM(COALESCE(h.paid_sen,0) - COALESCE(p.ledger_sen,0)),0)::bigint AS paid_delta,
           count(*) FILTER (WHERE COALESCE(h.balance_sen,0) <> COALESCE(h.local_total_sen,0) - COALESCE(p.ledger_sen,0))::int AS bal_mismatch,
           COALESCE(SUM(COALESCE(h.balance_sen,0) - (COALESCE(h.local_total_sen,0) - COALESCE(p.ledger_sen,0))),0)::bigint AS bal_delta
      FROM scm.mfg_sales_orders h LEFT JOIN p ON p.so_doc_no = h.doc_no
     GROUP BY 1,2 ORDER BY 1,2`);
  note('\n6g. header paid_sen / balance_sen vs the live payment ledger:');
  for (const r of paid) note(`   co=${r.company_id} status=${r.status} docs=${r.docs} paid_mismatch=${r.paid_mismatch} (${rm(r.paid_delta)}) balance_mismatch=${r.bal_mismatch} (${rm(r.bal_delta)})`);
}

// ── 7. is the AR-aging delta freshness, or a rule drift? ────────────────────
async function agingFreshness() {
  hr('7. AR aging: are the snapshot-vs-live deltas explained by documents created AFTER the refresh?');
  const meta = await tryQ('meta', () => sql`SELECT refreshed_at FROM scm.mv_ar_aging_meta LIMIT 1`);
  const at = meta[0]?.refreshed_at ?? null;
  note(`snapshot refreshed_at = ${at}`);
  if (!at) { note('UNPROVEN — no freshness row, so nothing here can be attributed to lag.'); return; }

  /* Column names come from the LIVE view, never from a guess. The first cut of
     this section hard-coded `doc_no` and `created_at`; both queries died on
     42703 and the section then printed "0", which reads exactly like a clean
     answer. A check that could not run must say so. */
  async function since(view, idCandidates, amtCandidates) {
    const cols = await tryQ(`${view} cols`, () => sql`
      SELECT a.attname AS col
        FROM pg_attribute a
       WHERE a.attrelid = ${'scm.' + view}::regclass AND a.attnum > 0 AND NOT a.attisdropped`);
    const have = new Set(cols.map((c) => c.col));
    if (!have.size) { note(`${view}: UNPROVEN — could not read its columns.`); return; }
    const dateCol = ['created_at', 'doc_date', 'so_date', 'updated_at'].find((c) => have.has(c));
    const idCol = idCandidates.find((c) => have.has(c));
    const amtCol = amtCandidates.find((c) => have.has(c));
    if (!dateCol || !idCol) {
      note(`${view}: UNPROVEN — no usable date/id column. It has: ${[...have].sort().join(', ')}`);
      return;
    }
    let rows;
    try {
      rows = await sql`
        SELECT ${sql(idCol)} AS doc, company_id, ${amtCol ? sql(amtCol) : sql`0`} AS amt, ${sql(dateCol)} AS at
          FROM ${sql('scm.' + view)} WHERE is_outstanding AND ${sql(dateCol)} > ${at} ORDER BY 4`;
    } catch (e) {
      note(`${view}: UNPROVEN — the query failed: ${e.code ?? ''} ${e.message}`);
      return;
    }
    note(`${view}: ${rows.length} outstanding row(s) dated after the refresh (by ${dateCol}), worth ${rm(rows.reduce((s, r) => s + Number(r.amt ?? 0), 0))}`);
    for (const r of rows) note('   ' + JSON.stringify(r));
  }

  await since('v_po_outstanding', ['doc_no', 'po_number', 'document_no'], ['total_sen']);
  await since('v_so_outstanding', ['doc_no', 'so_doc_no', 'document_no'], ['local_total_sen']);
  await since('v_pi_outstanding', ['doc_no', 'invoice_number', 'pi_number'], ['total_sen']);
  await since('v_si_outstanding', ['doc_no', 'invoice_number'], ['total_sen']);
  note('\nA snapshot-minus-live delta is only FRESHNESS when a row above accounts for it.');
}

async function main() {
  note(`check-report-money — section=${SECTION} — READ ONLY`);
  if (want('schema')) await schemaCensus();
  if (want('ratecard')) await rateCard();
  if (want('autolines')) await autoLines();
  if (want('pnl')) await pnlRowSet();
  if (want('aging')) await arAging();
  if (want('autowhy')) await autoWhy();
  if (want('fairdoc')) await fairVsDoc();
  if (want('aging')) await agingFreshness();
  await sql.end({ timeout: 5 });
}

main().catch((e) => { console.error(e); process.exit(1); });
