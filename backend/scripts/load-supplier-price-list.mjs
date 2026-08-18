// Gated loader for the owner's "Supplier Price List .xlsx" (2026-08 edition).
//
// Executes the pre-compiled plan in scripts/data/supplier-price-list-plan-2026-08.json
// (built offline from the workbook + the read-only probe; reviewed via
// scripts/data/supplier-price-list-DRY-RUN-2026-08.md).
//
//   MODE=dry-run (default)  — re-verify every op against the live DB, print
//                             what WOULD change, write nothing.
//   MODE=apply              — additionally requires
//                             CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//   PHASE=all|flat|sofa     — flat: main flags + binding costs + product costs;
//                             sofa: models/compartments/SKUs/grids/sofa bindings.
//
// RULES (owner-approved shape, same as every gated repair here):
//   - FILL-EMPTY-ONLY: a non-zero cost/price/matrix in prod is never touched;
//     the op is skipped and counted as "skip_nonzero".
//   - sellingPriceSen is NEVER written; seat-grid merge preserves every
//     existing entry and only fills priceSen.
//   - is_main_supplier singleton kept app-side: demote-then-promote per material.
//   - One transaction; expected/applied counts verified; mismatch => rollback.
//   - jsonb via sql.json() (postgres.js double-serialization trap, see
//     scm/lib/pg-supabase-transaction.ts).
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const PHASE = (process.env.PHASE || "all").toLowerCase();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = MODE === "apply" && process.env.CONFIRM === CONFIRM_PHRASE;
if (MODE === "apply" && !APPLY) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". Aborting.`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const plan = JSON.parse(readFileSync(new URL("./data/supplier-price-list-plan-2026-08.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const FLAT_OPS = new Set(["bind_update", "bind_upsert", "product_cost"]);
const SOFA_OPS = new Set(["model_create", "model_open", "sku_mint", "seat_grid", "sofa_bind"]);
const wanted = (o) =>
  PHASE === "all" || (PHASE === "flat" && FLAT_OPS.has(o.op)) || (PHASE === "sofa" && SOFA_OPS.has(o.op));

const counts = {};       // op -> {apply, skip_<reason>...}
const bump = (op, key) => { (counts[op] ??= {}); counts[op][key] = (counts[op][key] || 0) + 1; };
const detail = [];       // dry-run detail lines (sampled in output)

async function main() {
  const [co] = await sql`SELECT id, code FROM public.companies WHERE code = ${plan.company_code}`;
  if (!co) throw new Error(`company ${plan.company_code} not found`);
  const cid = co.id;

  const sups = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = ${cid}`;
  const supByCode = new Map(sups.map((s) => [s.code, s.id]));

  const ops = plan.ops.filter(wanted);
  note(`MODE=${MODE} PHASE=${PHASE} company=${plan.company_code}(${cid}) ops=${ops.length}`);

  await sql.begin(async (tx) => {
    // ---- caches ----
    const prodRows = await tx`SELECT id, code, name, category, base_price_sen, price1_sen, seat_height_prices, base_model, model_id
                              FROM scm.mfg_products WHERE company_id = ${cid}`;
    const prodByCode = new Map(prodRows.map((p) => [p.code, p]));
    const bindRows = await tx`SELECT b.id, b.supplier_id, b.material_code, b.supplier_sku, b.unit_price_sen,
                                     b.price_matrix, b.is_main_supplier, s.code AS sup_code
                              FROM scm.supplier_material_bindings b
                              JOIN scm.suppliers s ON s.id = b.supplier_id
                              WHERE b.company_id = ${cid} AND b.material_kind = 'mfg_product'`;
    const bindBySupMat = new Map(bindRows.map((b) => [`${b.sup_code}||${b.material_code}`, b]));
    const bindsByMat = new Map();
    for (const b of bindRows) {
      if (!bindsByMat.has(b.material_code)) bindsByMat.set(b.material_code, []);
      bindsByMat.get(b.material_code).push(b);
    }
    const modelRows = await tx`SELECT id, model_code, name, category, allowed_options
                               FROM scm.product_models WHERE company_id = ${cid} AND category = 'SOFA'`;
    const modelByCode = new Map(modelRows.map((m) => [m.model_code, m]));
    const now = new Date().toISOString();

    const demoted = new Set(); // materials whose non-target mains we already cleared
    async function setMain(target, materialCode) {
      const siblings = (bindsByMat.get(materialCode) || []).filter((b) => b.id !== target.id && b.is_main_supplier);
      if (siblings.length && !demoted.has(materialCode)) {
        demoted.add(materialCode);
        if (APPLY) await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = false, updated_at = ${now}
                            WHERE company_id = ${cid} AND material_kind = 'mfg_product'
                              AND material_code = ${materialCode} AND id <> ${target.id}`;
      }
      if (APPLY) await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = true, updated_at = ${now}
                          WHERE id = ${target.id}`;
    }

    async function audit(code, field, oldSen, newSen) {
      if (!APPLY) return;
      await tx`INSERT INTO scm.master_price_history (product_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
               VALUES (${code}, ${field}, ${oldSen ?? null}, ${newSen}, ${"supplier-price-list-2026-08 load"}, ${now}, ${cid})`;
    }

    for (const o of ops) {
      if (o.op === "bind_update" || o.op === "bind_upsert") {
        const supId = supByCode.get(o.sup);
        if (!supId) { bump(o.op, "skip_no_supplier"); continue; }
        let b = bindBySupMat.get(`${o.sup}||${o.erp}`);
        if (!b && o.op === "bind_update") { bump(o.op, "skip_binding_gone"); continue; }
        if (!b) {
          const p = prodByCode.get(o.erp);
          if (!p) { bump(o.op, "skip_no_product"); continue; }
          b = { id: null, supplier_id: supId, material_code: o.erp, unit_price_sen: 0, price_matrix: null, is_main_supplier: false };
          if (APPLY) {
            const [ins] = await tx`INSERT INTO scm.supplier_material_bindings
              (supplier_id, material_kind, material_code, material_name, supplier_sku,
               unit_price_sen, is_main_supplier, company_id, created_at, updated_at)
              VALUES (${supId}, 'mfg_product', ${o.erp}, ${p.name}, ${o.ac},
                      ${o.cost_sen ?? 0}, false, ${cid}, ${now}, ${now})
              RETURNING id`;
            b.id = ins.id;
          }
          bindBySupMat.set(`${o.sup}||${o.erp}`, b);
          (bindsByMat.get(o.erp) ?? bindsByMat.set(o.erp, []).get(o.erp)).push(b);
          bump(o.op, "apply_insert");
          if (o.main) { if (b.id || !APPLY) await setMain(b, o.erp); }
          continue;
        }
        let did = false;
        if (o.main && !b.is_main_supplier) { await setMain(b, o.erp); did = true; bump(o.op, "apply_main"); }
        if (o.cost_sen != null && o.cost_sen > 0) {
          if ((b.unit_price_sen || 0) === 0) {
            if (APPLY) await tx`UPDATE scm.supplier_material_bindings SET unit_price_sen = ${o.cost_sen}, updated_at = ${now} WHERE id = ${b.id}`;
            did = true; bump(o.op, "apply_cost");
          } else if (b.unit_price_sen !== o.cost_sen) {
            bump(o.op, "skip_nonzero_cost");
            detail.push(`KEEP ${o.erp} @${o.sup}: prod=${b.unit_price_sen} plan=${o.cost_sen}`);
          }
        }
        if (!did) bump(o.op, "noop");
      }

      else if (o.op === "product_cost") {
        const p = prodByCode.get(o.erp);
        if (!p) { bump(o.op, "skip_no_product"); continue; }
        let did = false;
        if (o.base_price_sen != null && (p.base_price_sen || 0) === 0) {
          if (APPLY) await tx`UPDATE scm.mfg_products SET base_price_sen = ${o.base_price_sen}, updated_at = ${now} WHERE id = ${p.id}`;
          await audit(o.erp, "base_price_sen", p.base_price_sen, o.base_price_sen);
          did = true; bump(o.op, "apply_base");
        } else if (o.base_price_sen != null && (p.base_price_sen || 0) !== o.base_price_sen) {
          bump(o.op, "skip_nonzero_base");
        }
        if (o.price1_sen != null && (p.price1_sen || 0) === 0) {
          if (APPLY) await tx`UPDATE scm.mfg_products SET price1_sen = ${o.price1_sen}, updated_at = ${now} WHERE id = ${p.id}`;
          await audit(o.erp, "price1_sen", p.price1_sen, o.price1_sen);
          did = true; bump(o.op, "apply_p1");
        }
        if (!did) bump(o.op, "noop");
      }

      else if (o.op === "model_create") {
        if (modelByCode.has(o.model)) { bump(o.op, "skip_exists"); continue; }
        const opts = { compartments: o.compartments, sizes: o.sizes };
        const row = { id: null, model_code: o.model, name: o.model, allowed_options: opts };
        if (APPLY) {
          const [ins] = await tx`INSERT INTO scm.product_models
            (branding, model_code, name, category, allowed_options, active, company_id, created_at, updated_at)
            VALUES (${o.branding}, ${o.model}, ${o.model}, 'SOFA', ${tx.json(opts)}, true, ${cid}, ${now}, ${now})
            RETURNING id`;
          row.id = ins.id;
        }
        modelByCode.set(o.model, row);
        bump(o.op, "apply");
      }

      else if (o.op === "model_open") {
        const m = modelByCode.get(o.model);
        if (!m) { bump(o.op, "skip_no_model"); continue; }
        const opts = { ...(m.allowed_options || {}) };
        const cur = new Set(opts.compartments || []);
        const add = (o.add_compartments || []).filter((c) => !cur.has(c));
        const sizes = Array.from(new Set([...(opts.sizes || []), ...(o.sizes || [])]));
        const sizesChanged = sizes.length !== (opts.sizes || []).length;
        if (!add.length && !sizesChanged) { bump(o.op, "noop"); continue; }
        opts.compartments = [...(opts.compartments || []), ...add];
        opts.sizes = sizes;
        if (APPLY) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(opts)}, updated_at = ${now} WHERE id = ${m.id}`;
        m.allowed_options = opts;
        bump(o.op, "apply");
      }

      else if (o.op === "sku_mint") {
        if (prodByCode.has(o.erp)) { bump(o.op, "skip_exists"); continue; }
        const m = modelByCode.get(o.model);
        const id = "mfg-" + randomBytes(6).toString("hex");
        const name = `ZANOTTI SOFA ${m ? m.name : o.model} ${o.comp}`.toUpperCase();
        if (APPLY) await tx`INSERT INTO scm.mfg_products
          (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
          VALUES (${id}, ${o.erp}, ${name}, 'SOFA', 'ACTIVE', 'ZANOTTI', ${o.model}, ${m?.id ?? null}, ${cid}, ${now}, ${now})`;
        prodByCode.set(o.erp, { id, code: o.erp, name, base_price_sen: 0, price1_sen: 0, seat_height_prices: null });
        bump(o.op, "apply");
      }

      else if (o.op === "seat_grid") {
        const p = prodByCode.get(o.erp);
        if (!p) { bump(o.op, "skip_no_product"); continue; }
        const existing = Array.isArray(p.seat_height_prices) ? p.seat_height_prices : [];
        const byKey = new Map(existing.map((e) => [`${e.height}|${e.tier ?? "PRICE_2"}`, { ...e }]));
        let kept = 0;
        const filledSlots = [];
        for (const e of o.entries) {
          const k = `${e.height}|${e.tier}`;
          const cur = byKey.get(k);
          if (!cur) { byKey.set(k, { height: e.height, tier: e.tier, priceSen: e.priceSen }); filledSlots.push(e); }
          else if (!cur.priceSen) { cur.priceSen = e.priceSen; filledSlots.push(e); }
          else if (cur.priceSen !== e.priceSen) kept++;
        }
        if (!filledSlots.length) { bump(o.op, kept ? "skip_nonzero_grid" : "noop"); continue; }
        const next = Array.from(byKey.values());
        if (APPLY) {
          await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(next)}, updated_at = ${now} WHERE id = ${p.id}`;
          for (const e of filledSlots) await audit(o.erp, `seat_height:${e.height}|${e.tier}`, null, e.priceSen);
        }
        p.seat_height_prices = next;
        bump(o.op, "apply");
      }

      else if (o.op === "sofa_bind") {
        const supId = supByCode.get(o.sup);
        if (!supId) { bump(o.op, "skip_no_supplier"); continue; }
        const p = prodByCode.get(o.erp);
        if (!p) { bump(o.op, "skip_no_product"); continue; }
        let b = bindBySupMat.get(`${o.sup}||${o.erp}`);
        if (!b) {
          if (APPLY) {
            const [ins] = await tx`INSERT INTO scm.supplier_material_bindings
              (supplier_id, material_kind, material_code, material_name, supplier_sku,
               unit_price_sen, price_matrix, is_main_supplier, company_id, created_at, updated_at)
              VALUES (${supId}, 'mfg_product', ${o.erp}, ${p.name}, ${o.ac ?? o.erp},
                      0, ${tx.json(o.matrix)}, false, ${cid}, ${now}, ${now})
              RETURNING id`;
            b = { id: ins.id, is_main_supplier: false };
          } else b = { id: null, is_main_supplier: false };
          bindBySupMat.set(`${o.sup}||${o.erp}`, b);
          bump(o.op, "apply_insert");
        } else if (b.price_matrix == null) {
          if (APPLY) await tx`UPDATE scm.supplier_material_bindings SET price_matrix = ${tx.json(o.matrix)}, updated_at = ${now} WHERE id = ${b.id}`;
          bump(o.op, "apply_matrix");
        } else {
          bump(o.op, "skip_has_matrix");
        }
        if (o.main && !b.is_main_supplier) await setMain(b, o.erp);
      }
    }

    // ---- maintenance pool additions (sofa phase) ----
    if (PHASE !== "flat") {
      const needed = new Set();
      for (const o of ops) {
        if (o.op === "model_create") o.compartments.forEach((c) => needed.add(c));
        if (o.op === "model_open") (o.add_compartments || []).forEach((c) => needed.add(c));
      }
      const [cfg] = await tx`SELECT id, config FROM scm.maintenance_config_history
        WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
        ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
      const pool = new Set((cfg?.config?.sofaCompartments || []).map((v) => (typeof v === "object" ? v.value : v)));
      const add = [...needed].filter((c) => !pool.has(c));
      if (add.length) {
        note(`pool additions required: ${add.join(", ")}`);
        if (APPLY) {
          const nextCfg = { ...cfg.config, sofaCompartments: [...cfg.config.sofaCompartments, ...add] };
          await tx`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
                   VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${tx.json(nextCfg)}, CURRENT_DATE,
                           ${"supplier-price-list-2026-08: add " + add.join(", ")}, ${now}, ${cid})`;
        }
        bump("pool_append", "apply");
      }
    }

    // ---- verify ----
    const applied = Object.entries(counts).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n  ");
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}):\n  ${applied}`);
    for (const d of detail.slice(0, 30)) console.log("  " + d);
    if (detail.length > 30) console.log(`  … ${detail.length - 30} more`);

    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => {
    if (e.message !== "DRY-RUN-ROLLBACK") throw e;
    note("DRY-RUN complete: transaction rolled back, nothing written.");
  });
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("FAIL", e.message);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
