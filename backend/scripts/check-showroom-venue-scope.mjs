// READ-ONLY. Measures the cross-company showroom/venue leak the owner ruled on
// 2026-08-19: "客人开单不能看到 2990 的展厅啊。分开的公司都不一样啊，收入单也不一样。
// venue 都不一样啊" / "我们的 Venue、我们的 Warehouse、我们的 Showroom 等等，都是跟着
// 看到自己公司的".
//
// GET /api/projects/venues?includeShowrooms=1 built its SHOWROOM half from
// scm.warehouses with NO company predicate, so every company's picker listed
// every company's showrooms. This prints, per company:
//
//   BEFORE — rows the unscoped query returned (identical for every caller)
//   AFTER  — rows the company-scoped query returns for that company
//   FOREIGN — BEFORE minus AFTER, i.e. exactly what was leaking into that
//             company's picker
//
// It also counts project_venues NAME collisions across companies, which is what
// decides whether the unscoped `SELECT id FROM project_venues WHERE lower(name)
// = ?` in mfg-sales-orders' active-venue autofill could hand one company the
// OTHER company's venue master id.
//
// SELECT only. No writes, no DDL, no transaction. The verdict is the output.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  notice("=== SHOWROOM / VENUE COMPANY SCOPE (READ-ONLY) ===");

  const companies = await sql`
    SELECT id, code, name FROM public.companies ORDER BY id`;
  notice(`companies: ${companies.map((c) => `${c.id}=${c.code}`).join(", ")}`);

  // BEFORE — the exact query the route ran, predicate and all, minus company.
  const before = await sql`
    SELECT id, code, name, venue_name, company_id
      FROM scm.warehouses
     WHERE is_showroom = true AND is_active = true
       AND venue_name IS NOT NULL AND btrim(venue_name) <> ''
     ORDER BY venue_name`;
  notice(`BEFORE (unscoped, what EVERY company's picker listed): ${before.length} showroom venues`);
  for (const r of before) {
    notice(`  co=${r.company_id} ${r.code} | venue="${r.venue_name}" | ${r.name}`);
  }

  notice("--- AFTER, per company (what the scoped query returns) ---");
  for (const co of companies) {
    const mine = before.filter((r) => Number(r.company_id) === Number(co.id));
    const foreign = before.filter((r) => Number(r.company_id) !== Number(co.id));
    notice(`${co.code} (id ${co.id}): BEFORE ${before.length} -> AFTER ${mine.length} (FOREIGN removed: ${foreign.length})`);
    for (const r of foreign) {
      notice(`    was leaking into ${co.code}: "${r.venue_name}" (owned by company_id ${r.company_id})`);
    }
  }

  // Rows with NO company_id would survive neither answer cleanly — surface them
  // rather than let them hide inside a count.
  const orphan = before.filter((r) => r.company_id == null);
  notice(`showroom venues with NULL company_id (invisible after the fix): ${orphan.length}`);
  for (const r of orphan) notice(`    ORPHAN ${r.code} "${r.venue_name}"`);

  // project_venues per company + cross-company NAME collisions.
  const pv = await sql`
    SELECT company_id, count(*)::int AS n
      FROM public.project_venues WHERE active = 1
     GROUP BY company_id ORDER BY company_id`;
  notice(`project_venues (active) by company: ${pv.map((r) => `${r.company_id}=${r.n}`).join(", ")}`);

  const clash = await sql`
    SELECT lower(btrim(name)) AS nm,
           count(DISTINCT company_id)::int AS companies,
           count(*)::int AS rows
      FROM public.project_venues WHERE active = 1
     GROUP BY 1 HAVING count(DISTINCT company_id) > 1
     ORDER BY 1`;
  notice(`project_venues names held by MORE THAN ONE company: ${clash.length}`);
  for (const r of clash) notice(`    "${r.nm}" in ${r.companies} companies (${r.rows} rows)`);

  // Same question for the showroom venue_names, which the picker merges in.
  const shClash = await sql`
    SELECT lower(btrim(venue_name)) AS nm, count(DISTINCT company_id)::int AS companies
      FROM scm.warehouses
     WHERE is_showroom = true AND is_active = true
       AND venue_name IS NOT NULL AND btrim(venue_name) <> ''
     GROUP BY 1 HAVING count(DISTINCT company_id) > 1 ORDER BY 1`;
  notice(`showroom venue_names held by MORE THAN ONE company: ${shClash.length}`);
  for (const r of shClash) notice(`    "${r.nm}" in ${r.companies} companies`);
}

main()
  .then(() => sql.end())
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
