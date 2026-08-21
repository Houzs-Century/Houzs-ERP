#!/usr/bin/env node
// Read-only: show every project_brands row belonging to 2990, so the owner
// can verify the seed only added values from 2990's own data.
//
// EXTENDED 2026-08-21 (brand letterhead defect). The owner found a 2990 HOME
// SDN. BHD. Sales Order PDF printing the ZANOTTI logo — Zanotti is Houzs's
// house sofa brand. The PDF's logo resolver
// (scm/routes/mfg-sales-orders.ts:2759) reads project_brands with NO company
// predicate and then hardcodes the name 'ZANOTTI' for any SOFA order, so it can
// only ever stamp Houzs's brand on both companies' documents. This script now
// also answers, FROM PRODUCTION rather than from reading the code:
//
//   Q1  does a 2990 house sofa brand row exist, and does it carry a logo?
//   Q2  how many EXISTING sales orders does the CURRENT resolver stamp with a
//       brand belonging to the OTHER company — in both directions?
//   Q3  what else is in project_brands, per company, with/without a logo?
//   Q4  is the name UNIQUE still GLOBAL (a per-company table with a global
//       business key — the landmine audit-multicompany-scope.mjs names), and
//       are there cross-company name collisions today?
//
// Every statement below is a plain SELECT. No DDL, no writes, no transaction.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const [cHouzs] = await dst`SELECT id FROM companies WHERE code='HOUZS'`;
  notice(`2990 company_id=${c2990.id}  HOUZS company_id=${cHouzs.id}`);
  const rows = await dst`
    SELECT id, name, sort_order, active, created_at
      FROM project_brands
     WHERE company_id=${c2990.id}
     ORDER BY sort_order, name`;
  notice(`\n=== project_brands for company_id=2 (2990) — ${rows.length} rows ===`);
  for (const r of rows) {
    notice(`  id=${r.id}  name="${r.name}"  sort_order=${r.sort_order}  active=${r.active}  created=${r.created_at}`);
  }
  // Same for HOUZS to prove nothing bled.
  const hz = await dst`
    SELECT count(*)::int AS n FROM project_brands WHERE company_id=${cHouzs.id}`;
  notice(`\n=== project_brands for HOUZS (company_id=${cHouzs.id}) — ${hz[0].n} rows (untouched) ===`);
  const usage = await dst.unsafe(`
    WITH src AS (
      SELECT btrim(branding) AS n FROM scm.mfg_products WHERE company_id=${c2990.id} AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION ALL SELECT btrim(branding) FROM scm.product_models WHERE company_id=${c2990.id} AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION ALL SELECT btrim(i.branding) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
                WHERE o.company_id=${c2990.id} AND i.branding IS NOT NULL AND btrim(i.branding) <> ''
    )
    SELECT n, count(*)::int AS occurrences FROM src GROUP BY n ORDER BY count(*) DESC, n ASC
  `);
  notice(`\n=== DISTINCT branding values IN USE across 2990's own SKUs/models/SO lines ===`);
  for (const r of usage) notice(`  "${r.n}"  used on ${r.occurrences} rows`);

  // ── BRAND LETTERHEAD SCOPE (2026-08-21) ───────────────────────────────────
  // Q3 first: the whole table, per company, with logo presence. The company
  // assignment for a scoping fix has to come from THESE rows, not from two
  // remembered names.
  const all = await dst`
    SELECT b.id, b.company_id, c.code AS company_code, btrim(b.name) AS name,
           b.active,
           (b.logo_r2_key IS NOT NULL AND btrim(b.logo_r2_key) <> '') AS has_logo,
           b.logo_r2_key
      FROM project_brands b
      LEFT JOIN companies c ON c.id = b.company_id
     ORDER BY c.code NULLS FIRST, lower(btrim(b.name))`;
  notice(`\n=== Q3 · EVERY project_brands row (${all.length}) — company / active / logo ===`);
  for (const r of all) {
    notice(`  co=${r.company_code ?? "(null)"}  id=${r.id}  active=${r.active}  logo=${r.has_logo ? "YES" : "no "}  name="${r.name}"${r.has_logo ? `  key=${r.logo_r2_key}` : ""}`);
  }
  const withLogo = all.filter((r) => r.has_logo);
  notice(`  -> ${withLogo.length} of ${all.length} rows carry a logo_r2_key.`);

  // Q1: the two house sofa brands the owner's 2026-08-18 rule names, looked up
  // by the exact strings shared/so-branding-label.ts holds.
  notice(`\n=== Q1 · the house sofa brand rows (owner's 2026-08-18 rule) ===`);
  for (const [label, wanted] of [["HOUZS", "ZANOTTI"], ["2990", "2990s Sofa"]]) {
    const hits = all.filter((r) => r.name.toUpperCase() === wanted.toUpperCase());
    if (hits.length === 0) { notice(`  ${label} · "${wanted}": NO ROW EXISTS`); continue; }
    for (const h of hits) {
      notice(`  ${label} · "${wanted}": row id=${h.id} belongs to co=${h.company_code} active=${h.active} logo=${h.has_logo ? "YES" : "NO — falls back to the company letterhead"}`);
    }
  }
  // Anything else that LOOKS like a 2990 sofa brand, so "no row" is not read as
  // "no equivalent" when the operator spelled it differently.
  const sofaish = all.filter((r) => /sofa/i.test(r.name));
  notice(`  every brand row whose name mentions "sofa" (${sofaish.length}):`);
  for (const r of sofaish) notice(`    co=${r.company_code} "${r.name}" logo=${r.has_logo ? "YES" : "no"} active=${r.active}`);

  // Q4: is the UNIQUE on name still GLOBAL, and do any names collide across
  // companies today (which is what a global unique makes impossible)?
  const uniq = await dst`
    SELECT c.conname, c.contype,
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum) AS cols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public' AND cl.relname = 'project_brands' AND c.contype IN ('u','p')
     ORDER BY c.conname`;
  const uidx = await dst`
    SELECT i.relname AS idxname, ix.indisunique,
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'project_brands' AND ix.indisunique
     ORDER BY i.relname`;
  notice(`\n=== Q4 · project_brands UNIQUE / PK keys in production ===`);
  for (const r of uniq) notice(`  constraint ${r.conname} (${r.contype}) on (${(r.cols ?? []).join(", ")})`);
  for (const r of uidx) notice(`  unique index ${r.idxname} on (${(r.cols ?? []).join(", ")})`);
  const collide = await dst`
    SELECT lower(btrim(name)) AS n, count(DISTINCT company_id)::int AS companies,
           array_agg(DISTINCT company_id ORDER BY company_id) AS cos
      FROM project_brands
     GROUP BY 1 HAVING count(DISTINCT company_id) > 1
     ORDER BY 1`;
  notice(`  cross-company name collisions today: ${collide.length}`);
  for (const r of collide) notice(`    "${r.n}" in companies ${(r.cos ?? []).join(",")}`);

  // Q2: replay the CURRENT resolver over every existing SO and count the ones
  // it stamps with another company's brand. Mirrors mfg-sales-orders.ts:2755-2793:
  //   · brand pool  = active rows with a non-empty logo_r2_key, ALL companies
  //   · SOFA order  = ANY line (cancelled ones included — the detail read does
  //                   not filter them) whose item_group contains "SOFA"
  //                   -> the row named ZANOTTI, if it has a logo
  //   · otherwise   = longest active brand NAME that prefixes the FIRST line's
  //                   description, in the route's display order (group rank
  //                   mains -> bedframe -> accessories -> other -> service,
  //                   then line_no, then created_at)
  // APPROXIMATION, stated rather than hidden: the route also permutes sofa
  // module rows WITHIN a build (orderSofaModuleRowsWithinBuilds) before taking
  // itemRows[0]. That only permutes sofa rows among themselves, and a sofa
  // order never reaches the prefix branch while ZANOTTI has a logo, so it
  // cannot change the company verdict below; it could change WHICH brand name
  // a sofa-less order matches in a tie. Ties on equal name length are also
  // resolved by physical row order in the route (its SELECT has no ORDER BY),
  // which is not reproducible here; id order is used instead.
  const census = await dst.unsafe(`
    WITH brands AS (
      SELECT b.id, btrim(b.name) AS name, b.company_id
        FROM public.project_brands b
       WHERE b.active = 1
         AND b.logo_r2_key IS NOT NULL AND btrim(b.logo_r2_key) <> ''
    ),
    zan AS (SELECT id, company_id FROM brands WHERE upper(name) = 'ZANOTTI' ORDER BY id LIMIT 1),
    li AS (
      SELECT i.doc_no, upper(btrim(coalesce(i.description, ''))) AS descr,
             row_number() OVER (
               PARTITION BY i.doc_no
               ORDER BY (CASE
                   WHEN lower(coalesce(i.item_group, '')) LIKE '%sofa%'
                     OR lower(coalesce(i.item_group, '')) LIKE '%mattress%' THEN 0
                   WHEN lower(coalesce(i.item_group, '')) LIKE '%bedframe%' THEN 1
                   WHEN lower(coalesce(i.item_group, '')) LIKE '%accessor%' THEN 2
                   WHEN lower(coalesce(i.item_group, '')) LIKE '%service%'  THEN 4
                   ELSE 3 END),
                 i.line_no ASC NULLS LAST, i.created_at ASC
             ) AS rn
        FROM scm.mfg_sales_order_items i
    ),
    sofa AS (
      SELECT doc_no, bool_or(upper(coalesce(item_group, '')) LIKE '%SOFA%') AS has_sofa
        FROM scm.mfg_sales_order_items GROUP BY doc_no
    ),
    pfx AS (
      SELECT l.doc_no, b.id AS brand_id,
             row_number() OVER (PARTITION BY l.doc_no ORDER BY length(b.name) DESC, b.id) AS pr
        FROM li l JOIN brands b
          ON l.rn = 1 AND l.descr <> '' AND left(l.descr, length(b.name)) = upper(b.name)
    ),
    resolved AS (
      SELECT o.doc_no, o.company_id AS so_company_id,
             CASE WHEN coalesce(s.has_sofa, false) AND EXISTS (SELECT 1 FROM zan)
                  THEN (SELECT id FROM zan)
                  ELSE (SELECT p.brand_id FROM pfx p WHERE p.doc_no = o.doc_no AND p.pr = 1)
             END AS brand_id,
             coalesce(s.has_sofa, false) AS has_sofa
        FROM scm.mfg_sales_orders o
        LEFT JOIN sofa s ON s.doc_no = o.doc_no
    )
    SELECT sc.code AS so_company,
           coalesce(bc.code, '(none)') AS brand_company,
           coalesce(btrim(b.name), '(no brand -> company letterhead)') AS brand_name,
           r.has_sofa,
           count(*)::int AS orders
      FROM resolved r
      JOIN public.companies sc ON sc.id = r.so_company_id
      LEFT JOIN public.project_brands b ON b.id = r.brand_id
      LEFT JOIN public.companies bc ON bc.id = b.company_id
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 5 DESC, 3
  `);
  notice(`\n=== Q2 · what the CURRENT resolver stamps on every existing SO ===`);
  let wrong = 0;
  for (const r of census) {
    const cross = r.brand_company !== "(none)" && r.brand_company !== r.so_company;
    if (cross) wrong += r.orders;
    notice(`  ${cross ? "WRONG-COMPANY " : "             "}SO co=${r.so_company}  sofa=${r.has_sofa ? "Y" : "n"}  -> brand "${r.brand_name}" (co=${r.brand_company})  ${r.orders} orders`);
  }
  notice(`  -> ${wrong} existing sales orders resolve a brand belonging to the OTHER company.`);
  notice(`  NOTE: a PDF is generated on demand, so this is what those documents`);
  notice(`  print TODAY, not proof any of them was ever printed or sent.`);

  // The owner's own instance, named, so the census is anchored to a real doc.
  const inst = await dst`
    SELECT o.doc_no, c.code AS company_code, o.status,
           (SELECT count(*)::int FROM scm.mfg_sales_order_items i
             WHERE i.doc_no = o.doc_no AND upper(coalesce(i.item_group, '')) LIKE '%SOFA%') AS sofa_lines
      FROM scm.mfg_sales_orders o
      LEFT JOIN companies c ON c.id = o.company_id
     WHERE o.doc_no IN ('2990-SO-2607-026', 'SO-2607-026')
     ORDER BY o.doc_no`;
  notice(`\n=== the owner's instance ===`);
  if (inst.length === 0) notice(`  no row for 2990-SO-2607-026 / SO-2607-026`);
  for (const r of inst) notice(`  ${r.doc_no}  company=${r.company_code}  status=${r.status}  sofa_lines=${r.sofa_lines}`);
}
main().then(() => dst.end()).catch(async e => {
  console.error("CHECK_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
