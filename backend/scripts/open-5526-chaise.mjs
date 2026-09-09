#!/usr/bin/env node
// Open the chaise on model 5526 — `5526-L(LHF)`.
//
// ── WHY, AND WHY THIS IS NOT AN INFERENCE ───────────────────────────────────
// The owner, 2026-09-05, gave the shop-floor shorthand its meaning in two
// sentences: 「1ELT 就是L来的」 — the slip token `1ELT` IS the chaise, `L` — and
// 「1Abox 是1NALT」 — the piece `1ABOX` is what the slip writes as `1NALT`.
//
// That makes the build on HC-SO-000814 / HC-PO-000254 wrong. Their AutoCount
// text is `[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`, and on
// 2026-08-10 it was read as `1ABOX(LHF) + 1NA + 2A(RHF)` — a reading taken from
// the SPELLING, recorded as such in sofa-compartment-corrections-2026-08.json
// ("the ELT/T spelling has no parser rule"). fix-modenza-label-and-5526-
// pieces.mjs then minted 5526-1ABOX(LHF) so that reading could be applied. The
// first piece is `L`, not `1ABOX`, so the correction has to be re-pointed and
// 5526 needs a chaise it has never had.
//
// scripts/lib/parse-sofa.mjs already carries both halves of the ruling and
// agrees, which is corroboration rather than the evidence: on `1 ELT + NA +
// 2ER` it emits L(LHF) + 1NA + 2A(RHF), and on `1NALT + NA + 2ER` it emits
// 1ABOX(LHF) + 1NA + 2A(RHF). Pinned in scripts/lib/parse-sofa.test.mjs. (On
// the REAL string it emits nothing at all — the stray `/ T` splits the segment
// and it returns conf=low with no pieces — which is why these two documents are
// corrected from a data file and not by re-running the decoder.)
//
// ── ALL THREE STEPS, OR NONE ────────────────────────────────────────────────
// docs/sofa-import-handoff.md §3.2: opening a compartment is
//   1. scm.product_models.allowed_options.compartments  — the ON/OFF truth
//   2. scm.mfg_products                                  — the {model}-{piece} SKU
//   3. maintenance_config_history.config.sofaCompartments — the master pool
// Skipping any one of them half-works. Step 3 is ALREADY DONE for `L(LHF)`:
// measured on prod 2026-09-05 the master pool carries all 29 codes including
// L(LHF)/L(RHF), because thirty other company-1 models already have a chaise.
// This script checks it and appends only if it is genuinely absent — it does
// not add a duplicate to make its own log look busier.
//
// §3.3's lesson is the bar this has to clear: opening pieces on INFERENCE is
// how 28 wrong recliner SKUs were created and had to be reverted. This is not
// an inference — the owner ruled — but the bar is the same, so the SKU is
// COPIED from the model's closest existing sibling (5526-1A(LHF)) rather than
// invented, and the run REFUSES if that sibling is not there to copy.
//
// Nothing here touches a document, a quantity or a price. Re-pointing the two
// documents is apply-sofa-compartment-corrections.mjs's job, from the
// corrections data files, and it refuses until this SKU exists.
//
// MODE=plan by default (the transaction is rolled back); MODE=apply needs the
// CONFIRM phrase. The apply path re-reads on a FRESH connection and asserts the
// SHAPE of all three steps.
//
// RE-RUN: convergent and inert on a second run. Each of the three steps tests the current state first, so a repeat run writes nothing, appends no maintenance_config_history row, and still runs the full verification.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const CONFIRM_PHRASE = "1ELT IS THE CHAISE L";
const APPLY = MODE === "apply" && process.env.CONFIRM === CONFIRM_PHRASE;
if (MODE === "apply" && !APPLY) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". Aborting.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);

const MODEL = "5526";
const PIECE = "L(LHF)";
const CODE = `${MODEL}-${PIECE}`;
/** The model's closest existing piece. Its row is the template; nothing is invented. */
const SIBLING = `${MODEL}-1A(LHF)`;

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const K = (s) => String(s ?? "").trim().toUpperCase();
/** The pool stores either a bare string or `{ value }`. */
const poolValue = (v) => (v && typeof v === "object" ? v.value : v);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`MODE=${MODE} company=${CO} piece=${CODE}`);

  await sql.begin(async (tx) => {
    // ── 1. the ON/OFF truth ────────────────────────────────────────────────
    const [model] = await tx`SELECT id, model_code, name, branding, allowed_options
                               FROM scm.product_models
                              WHERE company_id = ${CO} AND upper(model_code) = ${K(MODEL)}`;
    if (!model) throw new Error(`model ${MODEL} is not in scm.product_models for company ${CO} — nothing to open`);
    const opts = model.allowed_options ?? {};
    const comps = Array.isArray(opts.compartments) ? opts.compartments.map(String) : [];
    const needComp = !comps.some((c) => K(c) === K(PIECE));
    log(`1. model ${MODEL} compartments (${comps.length}): ${comps.join(", ")}`);
    log(needComp ? `   += ${PIECE}` : `   ${PIECE} already open`);
    if (needComp && APPLY) {
      await tx`UPDATE scm.product_models
                  SET allowed_options = ${tx.json({ ...opts, compartments: [...comps, PIECE] })},
                      updated_at = now()
                WHERE id = ${model.id}`;
    }

    // ── 2. the SKU, copied from the sibling ────────────────────────────────
    const [sib] = await tx`SELECT id, code, name, category, status, branding, base_model, model_id
                             FROM scm.mfg_products
                            WHERE company_id = ${CO} AND upper(code) = ${K(SIBLING)}`;
    if (!sib) throw new Error(`${SIBLING} is not in scm.mfg_products — there is no sibling to copy, and inventing the attributes is what §3.3 forbids`);
    const [have] = await tx`SELECT id, code FROM scm.mfg_products
                             WHERE company_id = ${CO} AND upper(code) = ${K(CODE)}`;
    /* The sibling names itself `SOFA 5526 1A(LHF)`; the same rule spells this
       one. Read from the row rather than assumed, so a renamed family is
       followed instead of contradicted. */
    const name = sib.name.slice(0, sib.name.length - `1A(LHF)`.length) + PIECE;
    log(`2. SKU ${CODE}`);
    log(`   template ${sib.code}: category=${sib.category} status=${sib.status} branding=${JSON.stringify(sib.branding)} base_model=${sib.base_model} model_id=${sib.model_id}`);
    if (have) log(`   already exists (${have.id}) — not touched`);
    else log(`   mint "${name}"  (same category/status/branding/base_model/model_id)`);
    if (!have && APPLY) {
      await tx`INSERT INTO scm.mfg_products
                 (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
               VALUES (${"mfg-" + randomBytes(6).toString("hex")}, ${CODE}, ${name},
                       ${sib.category}, ${sib.status}, ${sib.branding}, ${sib.base_model},
                       ${model.id}, ${CO}, now(), now())`;
    }

    // ── 3. the master pool ─────────────────────────────────────────────────
    const [cfg] = await tx`SELECT id, config FROM scm.maintenance_config_history
                            WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= CURRENT_DATE
                            ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    if (!cfg) throw new Error(`company ${CO} has no master maintenance_config_history row — step 3 cannot be done, so no step is done`);
    const pool = Array.isArray(cfg.config?.sofaCompartments) ? cfg.config.sofaCompartments : [];
    const needPool = !pool.some((e) => K(poolValue(e)) === K(PIECE));
    log(`3. master pool (${pool.length} codes, cfg ${cfg.id})`);
    log(needPool ? `   += ${PIECE} (a NEW history row; the old row is never edited)` : `   ${PIECE} already in the pool — thirty other company-1 models have a chaise`);
    if (needPool && APPLY) {
      await tx`INSERT INTO scm.maintenance_config_history
                 (id, scope, config, effective_from, notes, created_at, company_id)
               VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master',
                       ${tx.json({ ...cfg.config, sofaCompartments: [...pool, PIECE] })}, CURRENT_DATE,
                       ${`5526 needs ${PIECE}: owner 2026-09-05 "1ELT 就是L来的" (HC-SO-000814 / HC-PO-000254)`},
                       now(), ${CO})`;
    }

    if (!APPLY) throw new Error("PLAN-ROLLBACK");
    log("APPLIED.");
  }).catch((e) => {
    if (e.message !== "PLAN-ROLLBACK") throw e;
    log("\nPLAN — transaction rolled back, nothing written. MODE=apply CONFIRM=\"" + CONFIRM_PHRASE + "\" to write.");
  });

  await sql.end();
  if (APPLY) await verifyOnFreshConnection();
}

/**
 * Re-read all three steps on a NEW connection and assert what they now ARE.
 *
 * A row count would pass here while the SKU carried the wrong branding or the
 * compartment list had been replaced by a string, so every assertion below
 * looks at a VALUE: the compartment list is checked for being an array that
 * contains the piece, and the minted row is compared field by field against the
 * sibling it was copied from.
 */
async function verifyOnFreshConnection() {
  const v = postgres(url, { ssl: "require", prepare: false, max: 1 });
  log("\nVERIFY — re-reading all three steps on a fresh connection");
  const bad = [];

  const [model] = await v`SELECT allowed_options FROM scm.product_models
                           WHERE company_id = ${CO} AND upper(model_code) = ${K(MODEL)}`;
  const comps = model?.allowed_options?.compartments;
  if (!Array.isArray(comps)) bad.push(`1. allowed_options.compartments is ${JSON.stringify(comps)}, not an array`);
  else if (!comps.some((c) => K(c) === K(PIECE))) bad.push(`1. compartments do not contain ${PIECE}: ${JSON.stringify(comps)}`);
  else log(`  OK  1. compartments (${comps.length}) contain ${PIECE}`);

  const rows = await v`SELECT code, name, category, status, branding, base_model, model_id, company_id
                         FROM scm.mfg_products
                        WHERE company_id = ${CO} AND upper(code) IN (${K(CODE)}, ${K(SIBLING)})
                        ORDER BY code`;
  const got = rows.find((r) => K(r.code) === K(CODE));
  const sib = rows.find((r) => K(r.code) === K(SIBLING));
  if (!got) bad.push(`2. ${CODE} is not in scm.mfg_products`);
  else if (!sib) bad.push(`2. ${SIBLING} vanished — the shape cannot be compared against its template`);
  else {
    for (const f of ["category", "status", "branding", "base_model", "model_id", "company_id"]) {
      if (JSON.stringify(got[f]) !== JSON.stringify(sib[f]))
        bad.push(`2. ${CODE}.${f} is ${JSON.stringify(got[f])}, the sibling's is ${JSON.stringify(sib[f])}`);
    }
    const wantName = sib.name.slice(0, sib.name.length - `1A(LHF)`.length) + PIECE;
    if (got.name !== wantName) bad.push(`2. ${CODE}.name is ${JSON.stringify(got.name)}, expected ${JSON.stringify(wantName)}`);
    if (!bad.length) log(`  OK  2. ${CODE} = ${JSON.stringify(got)}`);
  }

  const [cfg] = await v`SELECT config FROM scm.maintenance_config_history
                         WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= CURRENT_DATE
                         ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
  const pool = cfg?.config?.sofaCompartments;
  if (!Array.isArray(pool)) bad.push(`3. sofaCompartments is ${JSON.stringify(pool)}, not an array`);
  else if (!pool.some((e) => K(poolValue(e)) === K(PIECE))) bad.push(`3. the master pool does not contain ${PIECE}`);
  else log(`  OK  3. master pool (${pool.length}) contains ${PIECE}`);

  await v.end();
  if (bad.length) { console.error(`\nVERIFY FAILED:\n${bad.map((b) => `  - ${b}`).join("\n")}`); process.exit(1); }
  log(`VERIFY OK — all three steps of ${CODE}`);
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
