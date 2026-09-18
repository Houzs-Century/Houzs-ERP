#!/usr/bin/env node
// restore-2990-fabric-ticks-from-source — put the owner's own Modular colour
// ticks back on 2990's sofa Models.
//
// WHAT WAS LOST. `open-model-fabric-pools.mjs` cleared
// `allowed_options.fabrics` on every SOFA Model and took no backup; its run
// recorded only "company 2: 16 model(s), pool size 28/36". The refill that
// unblocked the POS gave every Model all 58 colours. The owner, 2026-09-13:
// 「原本是 28 到 36 个，现在突然变 56 个了」.
//
// WHERE THE TICKS STILL ARE. The 2990 SOURCE system this company was migrated
// from. Production run 34765704752 (check-2990-fabric-tick-reconstruction.mjs)
// read its product_models: 16 of 17 SOFA Models hold 28 or 36 colours, every
// colour id exists among company 2's active colours, and 16 Models at 28/36 is
// exactly what the clear recorded. MAKOTO holds none there and is left alone.
//
// WHAT THIS CANNOT PROVE. A tick changed inside this ERP after the migration
// would not be in the source. The counts agree with the clear's own record,
// which is the strongest evidence available; it is not per-colour proof.
//
// SCOPE. Company 2, SOFA Models only, the `fabrics` key only. A Model is
// restored only when the source pool is non-empty AND every colour id in it is
// an active colour of this company — otherwise it is reported and skipped,
// because writing a pool with an unknown id would narrow what can be sold.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="RESTORE-2990-TICKS".
// Before writing, the CURRENT allowed_options of every SOFA Model is saved to
// scm.app_config['scm.sofa_fabric_pools_before_source_restore'] (never
// overwritten), so this is undone by writing that copy back.
//
// RE-RUN: idempotent. A second run finds every restorable Model already
// holding its source pool and reports zero changes; the backup is kept.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const DST = process.env.DATABASE_URL;
const SRC_URL = process.env.SOURCE_SUPABASE_URL;
const SRC_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
if (!DST || !SRC_URL || !SRC_KEY) { console.error("need DATABASE_URL + SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "RESTORE-2990-TICKS";
const COMPANY = Number(process.env.COMPANY || 2);
const BACKUP_KEY = "scm.sofa_fabric_pools_before_source_restore";
const GH = !!process.env.GITHUB_ACTIONS;
const log = (m) => console.log(GH ? `::notice::${m}` : m);
const die = (m) => { console.error(GH ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const sameSet = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const s = new Set(a.map(String));
  return b.every((x) => s.has(String(x)));
};

async function main() {
  if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) die(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  /* The source system is 2990's own; its ticks mean nothing for another company. */
  if (COMPANY !== 2) die("this restore is for company 2 (2990) only");

  const src = createClient(SRC_URL, SRC_KEY, { auth: { persistSession: false } });
  const { data: srcModels, error } = await src.schema("public").from("product_models").select("*");
  if (error) die(`source read failed: ${error.message}`);
  const srcByCode = new Map();
  for (const m of srcModels ?? []) {
    if (String(m.category ?? "").toUpperCase() !== "SOFA") continue;
    srcByCode.set(String(m.code ?? m.model_code ?? "").toUpperCase(), m);
  }
  if (srcByCode.size === 0) die("source holds no SOFA Models — refusing to report an empty plan as 'nothing to do'");

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const colours = await sql`
    SELECT colour_id::text AS colour_id FROM scm.fabric_colours
     WHERE company_id = ${COMPANY} AND coalesce(active, true) = true`;
  const active = new Set(colours.map((r) => r.colour_id));
  const models = await sql`
    SELECT company_id, model_code, allowed_options FROM scm.product_models
     WHERE company_id = ${COMPANY} AND upper(coalesce(category::text,'')) = 'SOFA'
     ORDER BY model_code`;

  const plan = [];
  for (const m of models) {
    const s = srcByCode.get(String(m.model_code).toUpperCase());
    const now = Array.isArray(m.allowed_options?.fabrics) ? m.allowed_options.fabrics.map(String) : [];
    if (!s) { log(`SKIP ${m.model_code}: not in the source system`); continue; }
    const pool = Array.isArray(s.allowed_options?.fabrics) ? [...new Set(s.allowed_options.fabrics.map(String))] : [];
    if (pool.length === 0) { log(`SKIP ${m.model_code}: source holds no pool — left as it is (${now.length} colours)`); continue; }
    const unknown = pool.filter((c) => !active.has(c));
    if (unknown.length) { log(`SKIP ${m.model_code}: ${unknown.length} source colour id(s) are not active here — ${unknown.slice(0, 5).join(", ")}`); continue; }
    if (sameSet(now, pool)) { log(`OK   ${m.model_code}: already holds its ${pool.length} source colours`); continue; }
    plan.push({ m, pool, before: now.length });
  }

  log(`${models.length} SOFA Model(s); ${active.size} active colour(s); source SOFA Models: ${srcByCode.size}.`);
  for (const p of plan) log(`RESTORE ${p.m.model_code}: ${p.before} -> ${p.pool.length} colours`);
  log(`Models to restore: ${plan.length}`);
  if (!plan.length) { await sql.end(); log("Nothing to do."); return; }

  if (MODE !== "apply") {
    log(`PLAN ONLY — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  const [existing] = await sql`SELECT key FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
  if (existing) {
    log("BACKUP already exists — keeping it; it holds the state before the FIRST apply.");
  } else {
    const snapshot = models.map((m) => ({ company_id: m.company_id, model_code: m.model_code, allowed_options: m.allowed_options }));
    await sql`
      INSERT INTO scm.app_config (key, value, description, updated_at)
      VALUES (${BACKUP_KEY}, ${JSON.stringify(snapshot)}::text,
              ${`sofa allowed_options for company ${COMPANY}, taken ${new Date().toISOString()} before restore-2990-fabric-ticks-from-source`},
              now())
      ON CONFLICT (key) DO NOTHING`;
    const [chk] = await sql`SELECT length(value) AS n FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
    if (!chk || !(chk.n > 0)) die("BACKUP FAILED — refusing to write without a copy of the current state.");
    log(`BACKUP written: ${models.length} model(s), ${chk.n} bytes.`);
  }

  await sql.begin(async (tx) => {
    for (const p of plan) {
      await tx`UPDATE scm.product_models
                  SET allowed_options = coalesce(allowed_options, '{}'::jsonb)
                        || jsonb_build_object('fabrics', ${JSON.stringify(p.pool)}::text::jsonb),
                      updated_at = now()
                WHERE company_id = ${p.m.company_id} AND model_code = ${p.m.model_code}`;
    }
  });
  log(`APPLIED: ${plan.length} SOFA Model(s) restored to their source ticks.`);
  await sql.end();

  /* Fresh connection; assert the SHAPE — each restored Model's fabrics is a
     JSON ARRAY equal as a set to its source pool, not a row count. */
  const v2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v2`
    SELECT model_code, jsonb_typeof(allowed_options->'fabrics') AS t, allowed_options
      FROM scm.product_models
     WHERE company_id = ${COMPANY} AND upper(coalesce(category::text,'')) = 'SOFA'`;
  await v2.end();
  const byCode = new Map(after.map((r) => [r.model_code, r]));
  const wrong = plan.filter((p) => {
    const r = byCode.get(p.m.model_code);
    return !r || r.t !== "array" || !sameSet(r.allowed_options.fabrics, p.pool);
  });
  if (wrong.length) die(`VERIFY FAILED: ${wrong.map((p) => p.m.model_code).join(", ")}`);
  log(`VERIFIED on a fresh connection: ${plan.length} Model(s) hold exactly their source pool as a JSON array (${plan.map((p) => `${p.m.model_code}=${p.pool.length}`).join(", ")}).`);
}

main().catch((e) => die(e?.message ?? String(e)));
