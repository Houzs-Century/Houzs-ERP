// The reads and writes behind a Product Model merge, shared by the Actions script
// (merge-duplicate-models.mjs) and the Modular "Merge models" screen
// (src/scm/routes/mfg-product-merge.ts). The RULES live in
// duplicate-model-merge-plan.mjs; this file gathers their input and carries out
// one planned group. Every query carries company_id: both callers bypass RLS.
//
// NO SHEBANG: imported by the Worker.

import { sizeOf, planModelGroup } from "./duplicate-model-merge-plan.mjs";

const jarr = (xs) => JSON.stringify([...new Set(xs)]);
const anyOf = (sql, xs) => sql`ARRAY(SELECT jsonb_array_elements_text(${jarr(xs)}::text::jsonb))`;

export async function readModelWorld(sql, { co, groups, idle }) {
  const codes = [...groups.flatMap((g) => [g.keep, g.newModel, ...g.drops].filter(Boolean)), ...idle.map((x) => x.model)];
  const models = await sql`
    SELECT id::text AS id, model_code, name, branding, category::text AS category, active, allowed_options
      FROM scm.product_models WHERE company_id = ${co} AND model_code = ANY(${anyOf(sql, codes)})`;
  const found = new Set(models.map((m) => m.model_code));
  const near = new Map();
  for (const c of codes.filter((x) => !found.has(x) && !groups.some((g) => g.newModel === x))) {
    const head = c.split(/\s+/).slice(0, 2).join(" ");
    const rows = await sql`SELECT model_code, category::text AS category FROM scm.product_models
                            WHERE company_id = ${co} AND upper(model_code) LIKE ${`${head.toUpperCase()}%`} ORDER BY model_code LIMIT 8`;
    near.set(c, rows.map((r) => `"${r.model_code}" (${r.category})`));
  }
  const ids = models.map((m) => m.id);
  const rows = await sql`
    SELECT p.id::text AS id, p.code, p.status::text AS status, p.size_code, p.model_id::text AS model_id, p.base_model, to_jsonb(p) AS master
      FROM scm.mfg_products p WHERE p.company_id = ${co} AND p.model_id::text = ANY(${anyOf(sql, ids)})`;
  const skuCodes = rows.map((r) => r.code);
  const so = await sql`
    SELECT i.item_code, COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE i.cancelled IS NOT TRUE
                              AND h.status::text NOT IN ('DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'))::int AS open
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.company_id = ${co} AND i.item_code = ANY(${anyOf(sql, skuCodes)}) GROUP BY i.item_code`;
  const po = await sql`
    SELECT item_code, COUNT(*)::int AS total FROM scm.purchase_order_items
     WHERE company_id = ${co} AND item_code = ANY(${anyOf(sql, skuCodes)}) GROUP BY item_code`;
  const stock = await sql`
    SELECT item_code, SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                             WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements WHERE company_id = ${co} AND item_code = ANY(${anyOf(sql, skuCodes)}) GROUP BY item_code`;
  const bindings = await sql`
    SELECT b.id::text AS id, b.item_code, b.supplier_id::text AS supplier_id, b.is_main_supplier AS main,
           b.supplier_sku, s.code AS supplier, s.name AS supplier_name
      FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.company_id = ${co} AND b.item_code = ANY(${anyOf(sql, skuCodes)}) AND b.material_kind::text = 'mfg_product'`;
  const n = (xs, code, f) => Number(xs.find((r) => r.item_code === code)?.[f] ?? 0);
  const skus = rows.map((r) => {
    const mainB = bindings.find((b) => b.item_code === r.code && b.main);
    return {
      ...r,
      main: mainB?.supplier ?? null,
      use: { lines: n(so, r.code, "total") + n(po, r.code, "total"), stock: n(stock, r.code, "qty"), openSo: n(so, r.code, "open"),
             so: n(so, r.code, "total"), po: n(po, r.code, "total") },
    };
  });
  return { models, near, skus, bindings };
}

/* Sofa keys hang on the Model code (combo prices, quick picks). Moving them is a
   ruling of its own, so a Model that still carries one is refused. */
export const SOFA_KEYED = ["sofa_combo_pricing", "sofa_quick_picks", "personal_quick_picks", "pos_sofa_combos"];

/** One group (`keep` and the Models folded into it) planned against the live rows.
 *  `retiring`: codes the caller is about to switch off, planned as already off
 *  (the SKU merge preview); null when the rows already say it. */
export async function planModelFold(sql, { co, keep, drops, retiring }) {
  const rows = await sql`SELECT DISTINCT category::text AS category FROM scm.product_models WHERE company_id = ${co} AND model_code = ${keep}`;
  const group = { category: String(rows[0]?.category ?? ""), keep, drops };
  const world = await readModelWorld(sql, { co, groups: [group], idle: [] });
  if (retiring) world.skus = world.skus.map((s) => (retiring.has(s.code) ? { ...s, status: "INACTIVE" } : s));
  let plan = planModelGroup({ group, models: world.models, skus: world.skus });
  const refuse = (refusals) => ({ ...plan, refusals, pairs: [], moves: [], fills: [], addSizes: [], foldModels: [], inactiveMoves: [], createModel: null, activateKept: false });
  if (rows.length !== 1) plan = refuse([`Model "${keep}" is ${rows.length === 0 ? "not in this company" : "in more than one category"}`]);
  const keyed = [];
  for (const table of SOFA_KEYED) {
    const [n] = await sql`SELECT COUNT(*)::int AS n FROM ${sql(`scm.${table}`)} WHERE company_id = ${co} AND base_model = ANY(${anyOf(sql, drops)})`;
    if (n.n > 0) keyed.push(`${table} ${n.n}`);
  }
  if (keyed.length > 0) plan = refuse([`a folded Model still carries sofa rows (${keyed.join(", ")})`]);
  const keptActive = Boolean(world.models.find((m) => m.id === plan.keptModelId)?.active);
  return { world, plan, keptActive, refuse };
}

/** For a SKU merge's codes: each code's Model, and how many ACTIVE codes those Models hold. */
export async function readFoldInputs(sql, { co, codes }) {
  const rows = await sql`
    SELECT p.code, p.status::text AS status, p.model_id::text AS model_id, m.model_code
      FROM scm.mfg_products p LEFT JOIN scm.product_models m ON m.id = p.model_id AND m.company_id = p.company_id
     WHERE p.company_id = ${co} AND p.code = ANY(${anyOf(sql, codes)})`;
  const ids = [...new Set(rows.map((r) => r.model_id).filter(Boolean))];
  const counts = await sql`
    SELECT model_id::text AS model_id, COUNT(*)::int AS n FROM scm.mfg_products
     WHERE company_id = ${co} AND status = 'ACTIVE' AND model_id::text = ANY(${anyOf(sql, ids)}) GROUP BY model_id`;
  return {
    codeModels: new Map(rows.map((r) => [r.code, { model_id: r.model_id, model_code: r.model_code, status: r.status }])),
    activeByModel: new Map(counts.map((r) => [r.model_id, r.n])),
  };
}

export function bindingFill(world, f) {
  const donor = world.bindings.find((b) => b.item_code === f.from && b.main);
  const same = world.bindings.find((b) => b.item_code === f.code && b.supplier_id === donor?.supplier_id);
  return same ? { kind: "star", bindingId: same.id } : { kind: "move", bindingId: donor.id };
}

/** One group's Model writes, in one transaction, after its SKU merges committed.
 *  Every UPDATE re-asserts what it replaces, so a row changed since the plan rolls
 *  the group back. @returns the kept Model's id */
export async function writeModelGroup(sql, { co, plan, world, log }) {
  const skuByCode = new Map(world.skus.map((s) => [s.code, s]));
  let modelId = plan.keptModelId;
  await sql.begin(async (tx) => {
    if (plan.createModel) {
      const tpl = plan.createModel.template;
      const opts = { ...(tpl?.allowed_options ?? {}), sizes: plan.addSizes };
      const [m] = await tx`
        INSERT INTO scm.product_models (company_id, branding, model_code, name, category, allowed_options, active)
        VALUES (${co}, ${tpl?.branding ?? null}, ${plan.createModel.code}, ${plan.createModel.code}, ${plan.category}, ${JSON.stringify(opts)}::text::jsonb, true)
        RETURNING id::text AS id`;
      modelId = m.id;
      log(`   created Model "${plan.createModel.code}" ${modelId} (undo: DELETE it after the moves are undone)`);
    } else if (plan.addSizes.length || plan.activateKept) {
      const kept = world.models.find((m) => m.id === modelId);
      const pool = Array.isArray(kept.allowed_options?.sizes) ? kept.allowed_options.sizes : [];
      const r = await tx`
        UPDATE scm.product_models
           SET allowed_options = jsonb_set(COALESCE(allowed_options, '{}'::jsonb), '{sizes}', ${JSON.stringify([...pool, ...plan.addSizes])}::text::jsonb),
               active = true, updated_at = now()
         WHERE company_id = ${co} AND id::text = ${modelId}
           AND COALESCE(allowed_options -> 'sizes', 'null'::jsonb) = ${JSON.stringify(kept.allowed_options?.sizes ?? null)}::text::jsonb
        RETURNING id`;
      if (r.length !== 1) throw new Error(`kept Model "${plan.label}" changed since the plan`);
    }
    const keptCode = plan.createModel ? plan.createModel.code : world.models.find((m) => m.id === modelId).model_code;
    for (const m of plan.moves) {
      const r = await tx`
        UPDATE scm.mfg_products
           SET model_id = ${modelId}::uuid, base_model = ${keptCode}, size_code = COALESCE(NULLIF(size_code, ''), ${m.size}), updated_at = now()
         WHERE company_id = ${co} AND id::text = ${m.id} AND status = 'ACTIVE' AND model_id::text IS NOT DISTINCT FROM ${m.fromModelId}
        RETURNING id`;
      if (r.length !== 1) throw new Error(`"${m.code}" changed since the plan`);
    }
    for (const f of plan.fills) {
      const target = skuByCode.get(f.code);
      if (f.field === "main supplier") {
        const b = bindingFill(world, f);
        const r = b.kind === "star"
          ? await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = true
                      WHERE company_id = ${co} AND id::text = ${b.bindingId} AND item_code = ${f.code} AND is_main_supplier IS NOT TRUE RETURNING id`
          : await tx`UPDATE scm.supplier_material_bindings SET item_code = ${f.code}
                      WHERE company_id = ${co} AND id::text = ${b.bindingId} AND item_code = ${f.from} RETURNING id`;
        if (r.length !== 1) throw new Error(`main supplier binding for "${f.code}" changed since the plan`);
        continue;
      }
      const r = await tx`
        UPDATE scm.mfg_products SET ${tx(f.field)} = ${f.value}, updated_at = now()
         WHERE company_id = ${co} AND id::text = ${target.id} AND (${tx(f.field)} IS NULL OR ${tx(f.field)} = 0)
        RETURNING id`;
      if (r.length !== 1) throw new Error(`"${f.code}".${f.field} is not blank any more`);
    }
    for (const m of plan.inactiveMoves ?? []) {
      const r = await tx`
        UPDATE scm.mfg_products SET model_id = ${modelId}::uuid, base_model = ${keptCode}, updated_at = now()
         WHERE company_id = ${co} AND id::text = ${m.id} AND status <> 'ACTIVE' AND model_id::text IS NOT DISTINCT FROM ${m.fromModelId}
        RETURNING id`;
      if (r.length !== 1) throw new Error(`"${m.code}" changed since the plan`);
    }
    for (const f of plan.foldModels) {
      const r = await tx`UPDATE scm.product_models SET active = false, updated_at = now()
                          WHERE company_id = ${co} AND id::text = ${f.id} AND active = true RETURNING id`;
      if (r.length !== 1) throw new Error(`Model "${f.code}" was not on any more`);
    }
  });
  return modelId;
}

/** Re-read on a connection the writes did not use: what the rows now say. */
export async function verifyModelGroup(v, { co, plan, modelId }) {
  const problems = [];
  const [m] = await v`SELECT active, allowed_options FROM scm.product_models WHERE company_id = ${co} AND id::text = ${modelId}`;
  const pool = (m?.allowed_options?.sizes ?? []).map((z) => String(z).toUpperCase());
  if (!m?.active) problems.push(`kept Model "${plan.label}" is not on`);
  for (const z of plan.addSizes) if (!pool.includes(z)) problems.push(`kept Model "${plan.label}" pool lacks ${z}`);
  for (const mv of plan.moves) {
    const [s] = await v`SELECT model_id::text AS model_id, size_code FROM scm.mfg_products WHERE company_id = ${co} AND id::text = ${mv.id}`;
    if (s?.model_id !== modelId || sizeOf({ code: mv.code, size_code: s?.size_code }) !== mv.size) problems.push(`"${mv.code}" is not under "${plan.label}" with size ${mv.size}`);
  }
  for (const mv of plan.inactiveMoves ?? []) {
    const [s] = await v`SELECT model_id::text AS model_id FROM scm.mfg_products WHERE company_id = ${co} AND id::text = ${mv.id}`;
    if (s?.model_id !== modelId) problems.push(`"${mv.code}" is not under "${plan.label}"`);
  }
  for (const f of plan.fills.filter((x) => x.field === "main supplier")) {
    const [b] = await v`SELECT COUNT(*)::int AS n FROM scm.supplier_material_bindings WHERE company_id = ${co} AND item_code = ${f.code} AND is_main_supplier = true AND material_kind::text = 'mfg_product'`;
    if (b.n < 1) problems.push(`"${f.code}" has no main supplier`);
  }
  for (const f of plan.foldModels) {
    const [x] = await v`SELECT active FROM scm.product_models WHERE company_id = ${co} AND id::text = ${f.id}`;
    if (x?.active !== false) problems.push(`Model "${f.code}" is still on`);
  }
  return problems;
}
