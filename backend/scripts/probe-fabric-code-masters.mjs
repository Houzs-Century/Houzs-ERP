// Read-only probe, the fast half: the fabric masters and the handful of tables
// the KN01..KN13 -> EM rename has to move. One-off; dropped before merge.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (m) => console.log(m);
const cut = (s, n = 260) => { const v = String(s ?? ""); return v.length > n ? `${v.slice(0, n)}…` : v; };
const OLD = ["KN01", "KN02", "KN03", "KN04", "KN05", "KN06", "KN07", "KN08", "KN09", "KN10", "KN11", "KN12", "KN13"];
const OLD_RE = "(^|[^A-Za-z0-9])KN(0[1-9]|1[0-3])([^A-Za-z0-9]|$)";

async function section(title, fn) {
  out(`\n=== ${title} ===`);
  try { await fn(); } catch (e) { out(`  FAILED: ${cut(e.message, 300)}`); }
}
const dump = (rows) => { out(`  ${rows.length} row(s)`); for (const r of rows) out(`  ${cut(JSON.stringify(r), 900)}`); };

await section("A. companies", async () => dump(await sql`SELECT id, code, name FROM public.companies ORDER BY id`));

await section("B. scm.fabric_trackings (code/id KN*|EM*, or series EMBRACE)", async () => dump(await sql`
  SELECT * FROM scm.fabric_trackings
   WHERE fabric_code ~* '^(KN|EM)[-_ ]?[0-9]' OR id ~* '^(KN|EM)[-_ ]?[0-9]' OR series ILIKE '%EMBRACE%'
   ORDER BY company_id, fabric_code`));

await section("C1. scm.fabric_library (id KN*|EM*|EMBRACE)", async () => dump(await sql`
  SELECT * FROM scm.fabric_library
   WHERE id ~* '^(KN|EM)([-_ ]?[0-9]|$)' OR label ILIKE '%EMBRACE%' OR id ILIKE '%EMBRACE%'
   ORDER BY company_id, id`));

await section("C2. scm.fabric_colours (fabric_id/colour_id KN*|EM*)", async () => dump(await sql`
  SELECT * FROM scm.fabric_colours
   WHERE fabric_id ~* '^(KN|EM)([-_ ]?[0-9]|$)' OR colour_id ~* '^(KN|EM)[-_ ]?[0-9]' OR fabric_id ILIKE '%EMBRACE%'
   ORDER BY company_id, fabric_id, colour_id`));

await section("C3. how a multi-colour series looks today (BROWNIE / HOMELY), for the label convention", async () => {
  dump(await sql`SELECT * FROM scm.fabric_library WHERE id IN ('BROWNIE', 'NB', 'ZL') ORDER BY id`);
  dump(await sql`SELECT * FROM scm.fabric_colours WHERE fabric_id = 'BROWNIE' ORDER BY colour_id LIMIT 4`);
  dump(await sql`SELECT id, company_id, fabric_code, fabric_description, series, supplier_code, is_active
                   FROM scm.fabric_trackings WHERE fabric_code ILIKE 'BROWNIE%' ORDER BY fabric_code LIMIT 4`);
});

await section("D1. constraints ON the three fabric tables", async () => dump(await sql`
  SELECT conrelid::regclass::text AS t, conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
   WHERE conrelid IN ('scm.fabric_trackings'::regclass, 'scm.fabric_library'::regclass, 'scm.fabric_colours'::regclass)
   ORDER BY 1, 2`));

await section("D2. foreign keys that REFERENCE the three fabric tables", async () => dump(await sql`
  SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid IN ('scm.fabric_trackings'::regclass, 'scm.fabric_library'::regclass, 'scm.fabric_colours'::regclass)
   ORDER BY 1, 2`));

await section("D3. triggers on the three fabric tables", async () => dump(await sql`
  SELECT tgrelid::regclass::text AS t, tgname, pg_get_triggerdef(oid) AS def
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgrelid IN ('scm.fabric_trackings'::regclass, 'scm.fabric_library'::regclass, 'scm.fabric_colours'::regclass)
   ORDER BY 1, 2`));

await section("E. scm.product_fabrics rows on the old series", async () => dump(await sql`
  SELECT * FROM scm.product_fabrics WHERE fabric_id = ANY(${OLD}::text[]) OR fabric_id ~* '^EM([-_ ]?[0-9]|$)' ORDER BY fabric_id LIMIT 60`));

await section("F. scm.hr_item_kpi fabric rules on the old series (and EM)", async () => dump(await sql`
  SELECT * FROM scm.hr_item_kpi
   WHERE flag_type::text = 'fabric' AND (ref = ANY(${OLD}::text[]) OR ref ~* '^EM([-_ ]?[0-9]|$)')
   ORDER BY company_id, ref`));

await section("G. scm.product_models whose fabric pool names an old code", async () => {
  const rows = await sql`
    SELECT m.company_id, m.id, m.model_code, m.category,
           jsonb_array_length(m.allowed_options->'fabrics') AS pool_size,
           (SELECT array_agg(e ORDER BY e) FROM jsonb_array_elements_text(m.allowed_options->'fabrics') e
             WHERE e = ANY(${OLD}::text[])) AS old_in_pool,
           (SELECT array_agg(e ORDER BY e) FROM jsonb_array_elements_text(m.allowed_options->'fabrics') e
             WHERE e ~* '^EM([-_ ]?[0-9]|$)') AS em_in_pool
      FROM scm.product_models m
     WHERE jsonb_typeof(m.allowed_options->'fabrics') = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.allowed_options->'fabrics') e WHERE e = ANY(${OLD}::text[]))`;
  out(`  ${rows.length} model(s)`);
  const shapes = new Map();
  for (const r of rows) {
    const k = `company ${r.company_id} | ${r.category} | old ${(r.old_in_pool ?? []).length}/13 [${(r.old_in_pool ?? []).join(",")}] | EM [${(r.em_in_pool ?? []).join(",")}]`;
    shapes.set(k, (shapes.get(k) ?? 0) + 1);
  }
  for (const [k, n] of shapes) out(`  ${n} model(s): ${k}`);
});

await section("H. scm.mfg_products that name an old code (fabric_color / default_variants)", async () => dump(await sql`
  SELECT company_id, code, category, fabric_color, default_variants::text AS default_variants, status
    FROM scm.mfg_products
   WHERE fabric_color = ANY(${OLD}::text[]) OR default_variants::text ~* ${OLD_RE}
   ORDER BY company_id, code LIMIT 40`));

await section("I. SO lines on the old codes: (fabricId, fabricCode, colourId, colourLabel, fabricLabel) shapes", async () => dump(await sql`
  SELECT h.company_id, i.variants->>'fabricId' AS fabric_id, i.variants->>'fabricCode' AS fabric_code,
         i.variants->>'colourId' AS colour_id, i.variants->>'colourLabel' AS colour_label,
         i.variants->>'fabricLabel' AS fabric_label, i.variants->>'fabricSupplierCode' AS sup,
         COUNT(*)::int AS n, MIN(i.doc_no) AS first_doc, MAX(i.doc_no) AS last_doc
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE i.variants->>'fabricId' = ANY(${OLD}::text[]) OR i.variants->>'fabricCode' = ANY(${OLD}::text[])
      OR i.variants->>'colourId' = ANY(${OLD}::text[]) OR i.variants->>'colorCode' = ANY(${OLD}::text[])
      OR i.variants->>'colourCode' = ANY(${OLD}::text[]) OR i.variants->>'fabricColor' = ANY(${OLD}::text[])
   GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4`));

await section("J. SO lines on the old codes: status of their orders", async () => dump(await sql`
  SELECT h.company_id, h.status, COUNT(DISTINCT h.doc_no)::int AS orders, COUNT(*)::int AS lines
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE i.variants->>'fabricId' = ANY(${OLD}::text[]) OR i.variants->>'fabricCode' = ANY(${OLD}::text[])
   GROUP BY 1, 2 ORDER BY 1, 2`));

await section("K. SO lines: sample description2 + variants for the old codes", async () => dump(await sql`
  SELECT i.doc_no, i.item_code, i.description2, i.variants::text AS variants
    FROM scm.mfg_sales_order_items i
   WHERE i.variants->>'fabricCode' = ANY(${OLD}::text[]) OR i.variants->>'fabricId' = ANY(${OLD}::text[])
   ORDER BY i.doc_no DESC LIMIT 6`));

await section("L. SO lines whose description2 names an old code, by whether variants also does", async () => dump(await sql`
  SELECT (i.variants->>'fabricCode' = ANY(${OLD}::text[])) AS variants_has_old_code,
         (i.variants->>'fabricId' = ANY(${OLD}::text[])) AS variants_has_old_series,
         COUNT(*)::int AS n, MIN(i.description2) AS eg
    FROM scm.mfg_sales_order_items i
   WHERE i.description2 ~* ${OLD_RE}
   GROUP BY 1, 2 ORDER BY 3 DESC`));

await section("M. every scm column literally named like a fabric / colour / series reference", async () => dump(await sql`
  SELECT table_name, column_name, data_type FROM information_schema.columns
   WHERE table_schema = 'scm'
     AND (column_name ILIKE '%fabric%' OR column_name ILIKE '%colour%' OR column_name ILIKE '%color%' OR column_name ILIKE '%series%')
   ORDER BY 1, 2`));

await sql.end({ timeout: 5 });
