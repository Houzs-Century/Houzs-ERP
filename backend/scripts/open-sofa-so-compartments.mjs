#!/usr/bin/env node
// Open the compartments the sofa-SO import round needs (owner rulings 2026-08-10):
//   "都开" for the missing 2S/arm/chaise pieces; NA/LT — NA/RT are the new
//   1ABOX(LHF)/1ABOX(RHF) compartments; 3S is NOT opened anywhere (a 3-seater
//   at seat size ≠24" decomposes into 2A+1A per the owner's split rule).
//
// Same gated shape as load-supplier-price-list.mjs: MODE=dry-run default
// (transaction rolled back), MODE=apply requires CONFIRM phrase; model_open
// appends to product_models.allowed_options.compartments (the ON/OFF truth),
// sku_mint inserts {MODEL}-{COMP} named "SOFA {model name} {COMP}", and any
// compartment code new to the maintenance pool is appended as a NEW
// maintenance_config_history row (append-only).
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = MODE === "apply" && process.env.CONFIRM === CONFIRM_PHRASE;
if (MODE === "apply" && !APPLY) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". Aborting.`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const OPENINGS = [
  // round 2 (owner: 缺件都开 + 有R必有P; 1B/2B = Bench; dry-run 8 rollup)
  { model: "3068", comps: ["1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)"] },
  { model: "5119", comps: ["1A(P)(LHF)", "1A(P)(RHF)"] },
  { model: "5535", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)"] },
  { model: "8030", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)", "1B"] },
  { model: "8038", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)"] },
  { model: "8051", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)"] },
  { model: "8060", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)", "1B"] },
  { model: "8069", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)", "1B", "2B"] },
  { model: "9021", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)"] },
  { model: "9028", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)"] },
  { model: "9050", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)", "1B"] },
  { model: "9058", comps: ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)", "1B"] },
  { model: "7223", comps: ["CNR"] },
];

const counts = {};
const bump = (op, key) => { (counts[op] ??= {}); counts[op][key] = (counts[op][key] || 0) + 1; };

async function main() {
  const [co] = await sql`SELECT id, code FROM public.companies WHERE code = ${"HOUZS"}`;
  if (!co) throw new Error("company HOUZS not found");
  const cid = co.id;
  note(`MODE=${MODE} company=HOUZS(${cid}) openings=${OPENINGS.length} models`);

  await sql.begin(async (tx) => {
    const prodRows = await tx`SELECT id, code, name, branding, base_model, model_id
                              FROM scm.mfg_products WHERE company_id = ${cid} AND category = 'SOFA'`;
    const prodByCode = new Map(prodRows.map((p) => [p.code.toUpperCase(), p]));
    const modelRows = await tx`SELECT id, model_code, name, allowed_options
                               FROM scm.product_models WHERE company_id = ${cid} AND category = 'SOFA'`;
    const modelByCode = new Map(modelRows.map((m) => [m.model_code, m]));
    const now = new Date().toISOString();
    const poolNeeded = new Set();

    for (const g of OPENINGS) {
      const m = modelByCode.get(g.model);
      if (!m) { bump("model_open", "skip_no_model"); note(`  !! model ${g.model} not found — held`); continue; }
      const opts = { ...(m.allowed_options || {}) };
      const cur = new Set(opts.compartments || []);
      const add = g.comps.filter((c) => !cur.has(c));
      g.comps.forEach((c) => poolNeeded.add(c));
      if (add.length) {
        opts.compartments = [...(opts.compartments || []), ...add];
        if (APPLY) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(opts)}, updated_at = ${now} WHERE id = ${m.id}`;
        m.allowed_options = opts;
        bump("model_open", "apply");
        note(`  ${g.model}: +${add.join(", ")}`);
      } else bump("model_open", "noop");

      for (const comp of g.comps) {
        const code = `${g.model}-${comp}`;
        if (prodByCode.has(code.toUpperCase())) { bump("sku_mint", "skip_exists"); continue; }
        const sib = prodRows.find((p) => p.base_model === g.model && p.branding);
        const id = "mfg-" + randomBytes(6).toString("hex");
        const name = `SOFA ${m.name} ${comp}`.toUpperCase();
        if (APPLY) await tx`INSERT INTO scm.mfg_products
          (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
          VALUES (${id}, ${code}, ${name}, 'SOFA', 'ACTIVE', ${sib?.branding ?? "ZANOTTI"}, ${g.model}, ${m.id}, ${cid}, ${now}, ${now})`;
        prodByCode.set(code.toUpperCase(), { id, code, name });
        bump("sku_mint", "apply");
        note(`  mint ${code}  "${name}"`);
      }
    }

    const [cfg] = await tx`SELECT id, config FROM scm.maintenance_config_history
      WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    const pool = new Set((cfg?.config?.sofaCompartments || []).map((v) => (typeof v === "object" ? v.value : v)));
    const poolAdd = [...poolNeeded].filter((c) => !pool.has(c));
    if (poolAdd.length) {
      note(`pool additions: ${poolAdd.join(", ")}`);
      if (APPLY) {
        const nextCfg = { ...cfg.config, sofaCompartments: [...cfg.config.sofaCompartments, ...poolAdd] };
        await tx`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
                 VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${tx.json(nextCfg)}, CURRENT_DATE,
                         ${"sofa-so-import round2 2026-08-10: add " + poolAdd.join(", ")}, ${now}, ${cid})`;
      }
      bump("pool_append", "apply");
    }

    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): ${JSON.stringify(counts)}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => {
    if (e.message !== "DRY-RUN-ROLLBACK") throw e;
    note("DRY-RUN complete: transaction rolled back, nothing written.");
  });
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
