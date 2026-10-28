#!/usr/bin/env node
// Cleanup for the 2026-07-21 importer stray-row incident (see BUG-HISTORY.md).
// The earlier import generation REMAPPED some parent ids on PK collision (mig 0092);
// the verbatim-id importer run then inserted child/master rows under the SOURCE ids:
//   - product_size_variants: 132 dangling rows (product_id not a company_2 product)
//   - categories: stray rows duplicating the label of a referenced company_2 category
//   - series: extras with no read path anywhere (report only — hand-pick later)
// Dry-run unless APPLY=1. Idempotent: deletes only rows matching the stray predicates.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
async function main() {
  const r = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!r.length) throw new Error("no 2990 company");
  const cid = Number(r[0].id);
  console.log(`2990 company_id=${cid} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // --- product_size_variants: drop rows whose size_id is not a company_2 size_library entry
  // (the 132 verbatim-id imports point at 2990's size_library uuids, which live under company_1;
  // the JOIN in pos-pools.ts / configurator drops these rows or resolves them to empty labels).
  const split = await dst`SELECT
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.size_library s WHERE s.id = v.size_id AND s.company_id = ${cid})) AS keep,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM scm.size_library s WHERE s.id = v.size_id AND s.company_id = ${cid})) AS drop
    FROM scm.product_size_variants v WHERE v.company_id = ${cid}`;
  console.log(`psv split (size_id vs company_${cid} size_library): keep=${split[0].keep} drop=${split[0].drop}`);
  if (APPLY) {
    const del = await dst`DELETE FROM scm.product_size_variants v
      WHERE v.company_id = ${cid}
        AND NOT EXISTS (SELECT 1 FROM scm.size_library s WHERE s.id = v.size_id AND s.company_id = ${cid})`;
    console.log(`psv deleted: ${del.count}`);
  }

  // --- categories: strays = unreferenced + duplicate the label of a referenced row ---
  const catStray = await dst`SELECT cat.id, cat.label FROM scm.categories cat
    WHERE cat.company_id = ${cid}
      AND NOT EXISTS (SELECT 1 FROM scm.products p WHERE p.company_id = ${cid} AND p.category_id = cat.id)
      AND EXISTS (SELECT 1 FROM scm.categories k
                  WHERE k.company_id = ${cid} AND k.id <> cat.id AND lower(k.label) = lower(cat.label)
                    AND EXISTS (SELECT 1 FROM scm.products p2 WHERE p2.company_id = ${cid} AND p2.category_id = k.id))`;
  console.log(`categories strays: ${catStray.length}${catStray.length ? " -> " + catStray.map(c => `${c.id}(${c.label})`).join(", ") : ""}`);
  if (APPLY && catStray.length) {
    const del = await dst`DELETE FROM scm.categories WHERE id IN ${dst(catStray.map(c => c.id))} AND company_id = ${cid}`;
    console.log(`categories deleted: ${del.count}`);
  }

  // --- psv DIAGNOSTIC: the real dangling dimension is size_id, not product_id ---
  // (the first cleanup run proved every psv.product_id resolves to a company_2
  // product, so the 132->264 growth must differ on the OTHER half of the PK)
  const sizeDangle = await dst`SELECT count(*)::int AS n FROM scm.product_size_variants v
    WHERE v.company_id = ${cid}
      AND NOT EXISTS (SELECT 1 FROM scm.size_library s WHERE s.id = v.size_id AND s.company_id = ${cid})`;
  console.log(`psv rows whose size_id is NOT a company_${cid} size_library entry: ${sizeDangle[0].n}`);
  const perProduct = await dst`SELECT n_variants, count(*)::int AS n_products FROM (
      SELECT product_id, count(*)::int AS n_variants FROM scm.product_size_variants
      WHERE company_id = ${cid} GROUP BY product_id) t GROUP BY n_variants ORDER BY n_variants`;
  console.log(`psv variants-per-product histogram: ${perProduct.map(r => `${r.n_variants}x:${r.n_products}`).join(" ")}`);

  // --- series: REPORT ONLY (no read path in backend; shared seeded rows make predicates unsafe) ---
  const seriesCols = await dst`SELECT column_name FROM information_schema.columns
    WHERE table_schema='scm' AND table_name='series' ORDER BY ordinal_position`;
  console.log(`series columns: ${seriesCols.map(c => c.column_name).join(",")}`);
  const seriesRows = await dst`SELECT count(*)::int AS n FROM scm.series WHERE company_id = ${cid}`;
  console.log(`series rows (company_${cid}, report only): ${seriesRows[0].n}`);

  // --- after-state ---
  const after = await dst`SELECT
      (SELECT count(*) FROM scm.product_size_variants WHERE company_id = ${cid}) AS psv,
      (SELECT count(*) FROM scm.categories WHERE company_id = ${cid}) AS categories`;
  console.log(`after: psv=${after[0].psv} categories=${after[0].categories}`);
}
main().then(() => dst.end()).catch(async e => { console.error("CLEANUP_FAIL", e.message); await dst.end(); process.exit(1); });
