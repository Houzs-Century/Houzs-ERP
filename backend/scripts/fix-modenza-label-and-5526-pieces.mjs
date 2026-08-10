#!/usr/bin/env node
// Two owner rulings from the colour and compartment review, 2026-08-10.
//
// 1. MODENZA-01 IS Houston Cream. Ten document lines write
//    "Modenza-Houston Cream" with no number and cannot bind, while the lines
//    that write "Modenza 01 Houston Cream" bind to MODENZA-01 today - the
//    library row simply has no name in its label. Put the name there and all
//    ten bind through the existing matcher, with no code change. Owner: "ok".
//
// 2. Mint 5526-1ABOX(LHF) and 5526-1NA. When model 5526 was opened these two
//    were deliberately left out - RED SOFA's price list implies them but no
//    document needed them, and opening a compartment on inference is how the
//    28 wrong recliner SKUs happened last week. HC-PO-010117 now needs them:
//    its build "(1 ELT/T + NA + 2ER)" decodes to 1ABOX(LHF) + 1NA + 2A(RHF)
//    and the correction REFUSED for want of the first two. A document asking
//    for a piece is the evidence that was missing.
//
// All three steps of opening a compartment are done, per
// docs/sofa-import-handoff.md section 3.2 - allowed_options, the SKU, and the
// master pool - because skipping any one of them half-works.
//
// DRY-RUN by default; APPLY=1 writes.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const K = (s) => String(s ?? "").trim().toUpperCase();
const val = (v) => (v && typeof v === "object" ? v.value : v);

const LABEL_FIX = [["MODENZA", "MODENZA-01", "MODENZA-01 HOUSTON CREAM"]];
const PIECES = ["1ABOX(LHF)", "1NA"];
const MODEL = "5526";

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  // ---- 1. the MODENZA-01 label ----
  for (const [fid, cid, label] of LABEL_FIX) {
    const [row] = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours
      WHERE company_id = ${CO} AND upper(fabric_id) = ${K(fid)} AND upper(colour_id) = ${K(cid)}`;
    if (!row) { log(`  ${fid}/${cid}: not in the library — skipped`); continue; }
    if (K(row.label) === K(label)) { log(`  ${cid}: label already "${row.label}"`); continue; }
    log(`  LABEL ${cid}: "${row.label}" -> "${label}"  (lets "Modenza-Houston Cream" bind, 10 lines)`);
    if (APPLY) await sql`UPDATE scm.fabric_colours SET label = ${label}
      WHERE company_id = ${CO} AND fabric_id = ${row.fabric_id} AND colour_id = ${row.colour_id}`;
  }

  // ---- 2. the two 5526 pieces ----
  const [model] = await sql`SELECT id, name, branding, allowed_options FROM scm.product_models
    WHERE company_id = ${CO} AND upper(model_code) = ${K(MODEL)}`;
  if (!model) { log(`  model ${MODEL} not found — nothing to open`); await sql.end(); return; }
  const opts = model.allowed_options ?? {};
  const comps = Array.isArray(opts.compartments) ? opts.compartments.map(String) : [];
  const addComp = PIECES.filter((p) => !comps.some((c) => K(c) === K(p)));
  log("");
  log(`model ${MODEL} compartments (${comps.length}): ${comps.join(", ")}`);
  log(addComp.length ? `  += ${addComp.join(", ")}` : "  nothing to add");

  const codes = PIECES.map((p) => `${MODEL}-${p}`);
  const have = new Set((await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}
    AND upper(code) = ANY(${codes.map(K)})`).map((r) => K(r.code)));
  const mint = codes.filter((c) => !have.has(K(c)));
  for (const c of mint) log(`  mint ${c}  "SOFA ${MODEL} ${c.slice(MODEL.length + 1)}"`);
  if (!mint.length) log("  every SKU already exists");

  const [cfg] = await sql`SELECT id, config FROM scm.maintenance_config_history
    WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= CURRENT_DATE
    ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
  const pool = cfg?.config?.sofaCompartments ?? [];
  const addPool = PIECES.filter((p) => !pool.some((e) => K(val(e)) === K(p)));
  log(addPool.length ? `  pool += ${addPool.join(", ")}` : "  both already in the master pool");

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  if (addComp.length) {
    await sql`UPDATE scm.product_models SET allowed_options = ${sql.json({ ...opts, compartments: [...comps, ...addComp] })}
      WHERE id = ${model.id}`;
  }
  /* mfg_products.id has NO default - the first APPLY threw "null value in
     column id violates not-null constraint" here. Every other minting script
     supplies it explicitly; follow open-sofa-so-compartments.mjs, which also
     sets model_id so the SKU belongs to the model rather than floating. */
  for (const c of mint) {
    const comp = c.slice(MODEL.length + 1);
    const id = "mp-" + randomBytes(8).toString("hex");
    await sql`INSERT INTO scm.mfg_products
      (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
      VALUES (${id}, ${c}, ${`SOFA ${MODEL} ${comp}`}, 'SOFA', 'ACTIVE',
              ${model.branding ?? ""}, ${MODEL}, ${model.id}, ${CO}, now(), now())
      ON CONFLICT DO NOTHING`;
  }
  if (addPool.length && cfg) {
    const next = { ...cfg.config, sofaCompartments: [...pool, ...addPool] };
    await sql`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
      VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${sql.json(next)}, CURRENT_DATE,
              ${"5526 needs " + addPool.join("/") + " for HC-PO-010117 (owner 2026-08-10)"}, now(), ${CO})`;
  }
  log(`APPLIED — label fixes done; compartments +${addComp.length}, SKUs +${mint.length}, pool +${addPool.length}.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
