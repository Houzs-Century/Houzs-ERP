// Read-only probe: dump the prod state needed to plan the supplier price-list
// load (owner's "Supplier Price List .xlsx", 2026-08-08).
//
// Prints NDJSON rows tagged "@@ROW " so the caller can grep them out of the
// Actions log, plus ::notice:: verdict lines. Read-only: exits 0 for every
// legitimate answer; zero rows for a section is reported as MISSING EVIDENCE,
// never as "clean".
//
//   DATABASE_URL=... node scripts/probe-supplier-costing-state.mjs
//
// Sections:
//   company   — public.companies rows
//   supplier  — scm.suppliers rows per company
//   binding   — scm.supplier_material_bindings (joined to supplier code)
//   product   — scm.mfg_products cost/price columns + seat grid summary
//   model     — scm.product_models (SOFA models: allowed_options.compartments)
//   maintcfg  — current master maintenance config's sofaCompartments pool
//   complib   — scm.compartment_library ids
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const row = (t, o) => console.log("@@ROW " + JSON.stringify({ t, ...o }));

try {
  const companies = await sql`SELECT id, code, name FROM public.companies ORDER BY id`;
  if (companies.length === 0) note("MISSING EVIDENCE: zero companies rows");
  for (const c of companies) row("company", c);

  for (const c of companies) {
    const cid = c.id;

    const sups = await sql`
      SELECT id, code, name, status, currency FROM scm.suppliers
      WHERE company_id = ${cid} ORDER BY code`;
    if (sups.length === 0) note(`MISSING EVIDENCE: company ${c.code}: zero suppliers`);
    for (const s of sups) row("supplier", { company: c.code, code: s.code, name: s.name, status: s.status, currency: s.currency });

    const binds = await sql`
      SELECT s.code AS supplier_code, b.material_kind, b.material_code, b.supplier_sku,
             b.unit_price_centi, b.currency, b.is_main_supplier,
             (b.price_matrix IS NOT NULL) AS has_matrix, b.price_matrix
      FROM scm.supplier_material_bindings b
      JOIN scm.suppliers s ON s.id = b.supplier_id
      WHERE b.company_id = ${cid}
      ORDER BY s.code, b.material_code`;
    if (binds.length === 0) note(`MISSING EVIDENCE: company ${c.code}: zero supplier_material_bindings`);
    for (const b of binds)
      row("binding", {
        company: c.code, sup: b.supplier_code, kind: b.material_kind,
        erp: b.material_code, ac: b.supplier_sku,
        cost: b.unit_price_centi, cur: b.currency,
        main: b.is_main_supplier, matrix: b.has_matrix ? b.price_matrix : null,
      });

    const prods = await sql`
      SELECT code, category, status, pos_active, branding, base_model,
             cost_price_sen, base_price_sen, price1_sen, sell_price_sen,
             seat_height_prices
      FROM scm.mfg_products WHERE company_id = ${cid} ORDER BY code`;
    if (prods.length === 0) note(`MISSING EVIDENCE: company ${c.code}: zero mfg_products`);
    for (const p of prods)
      row("product", {
        company: c.code, code: p.code, cat: p.category, status: p.status,
        pos: p.pos_active, branding: p.branding, model: p.base_model,
        cost: p.cost_price_sen, base: p.base_price_sen, p1: p.price1_sen,
        sell: p.sell_price_sen, seats: p.seat_height_prices,
      });

    const models = await sql`
      SELECT model_code, name, category, branding, active, allowed_options
      FROM scm.product_models WHERE company_id = ${cid} ORDER BY category, model_code`;
    if (models.length === 0) note(`MISSING EVIDENCE: company ${c.code}: zero product_models`);
    for (const m of models)
      row("model", {
        company: c.code, code: m.model_code, name: m.name, cat: m.category,
        branding: m.branding, active: m.active, opts: m.allowed_options,
      });

    const cfg = await sql`
      SELECT id, effective_from, config->'sofaCompartments' AS pool,
             (SELECT jsonb_agg(k) FROM jsonb_object_keys(COALESCE(config->'sofaCompartmentMeta','{}'::jsonb)) AS k) AS meta_keys
      FROM scm.maintenance_config_history
      WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    if (cfg.length === 0) note(`MISSING EVIDENCE: company ${c.code}: no effective master maintenance config`);
    for (const g of cfg) row("maintcfg", { company: c.code, id: g.id, from: g.effective_from, pool: g.pool, metaKeys: g.meta_keys });

    const lib = await sql`SELECT id, comp_group, is_accessory, sort_order FROM scm.compartment_library WHERE company_id = ${cid} OR company_id IS NULL ORDER BY sort_order, id`;
    if (lib.length === 0) note(`MISSING EVIDENCE: company ${c.code}: zero compartment_library rows`);
    for (const l of lib) row("complib", { company: c.code, id: l.id, group: l.comp_group, acc: l.is_accessory });
  }

  note(`PROBE COMPLETE: companies=${companies.length}`);
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
