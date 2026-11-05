#!/usr/bin/env node
/* Add one sofa compartment to a Model — the backend-script form of what the
   owner does in Modular: put the code in the company's compartment pool, tick it
   on the Model's allowed_options, and let its SKU come into being.

   This exists because the owner asked for it by chat ("7233 要加多一个 G1F") and the
   write path for prod is the gated runner, not an ad-hoc edit. It is GENERIC: the
   Model and the compartment are env, so the next such request is a runner
   dispatch, not another PR.

   THREE WRITES, each the app's own and each idempotent:
     1. POOL. A NEW effective-dated scm.maintenance_config_history 'master' row
        carrying the whole current config with the code appended to
        sofaCompartments. Append-only, exactly like POST /maintenance-config/
        changes — the existing rows are history and are never mutated.
     2. MODEL. scm.product_models.allowed_options.compartments gains the code
        (UPDATE in place, company-scoped), as PATCH /product-models/:id does.
     3. SKU. scm.mfg_products gets `<MODEL>-<comp>` named `SOFA <NAME> <comp>`,
        branding + model_id off the Model, NO price (Master Admin prices it in SKU
        Master afterward) — byte-for-byte the auto-create in product-models.ts.
   The compartment pool is COMPANY-WIDE; a Model shows the code only once it is
   ticked here, so this does not disturb other Models.

   SCOPE / REFUSALS. One company (COMPANY, default 1). The Model must exist, be
   SOFA, and be the only SOFA model with that code. `<MODEL>-<comp>` must fit the
   30-char item-code limit. Each of the three writes is skipped when it is already
   true, so the three can be in any mix of done/undone and the run completes them.

   MODE=plan (default) reads and reports the three decisions, writes NOTHING.
   MODE=apply needs CONFIRM="ADD <COMP> TO <MODEL>" (the target spelled out so it
   cannot be applied to the wrong Model by a copied phrase), writes the missing
   pieces in ONE transaction, then re-reads on a FRESH connection and asserts the
   code is in the pool, ticked on the Model, and that the SKU exists.

   RE-RUN: inert. The pool append, the Model tick and the SKU insert each happen
   only when absent, so a second run re-reports "already present" on all three and
   writes nothing. */
import postgres from 'postgres';
import {
  normalizeCode, skuCodeFor, skuNameFor, itemCodeTooLong,
  poolWithCompartment, optionsWithCompartment,
} from './lib/add-model-compartment.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const MODEL = (process.env.MODEL || '').trim();
const COMP = normalizeCode(process.env.COMPARTMENT);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = `ADD ${COMP} TO ${MODEL}`;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!MODEL || !COMP) {
  bad('need MODEL and COMPARTMENT, e.g. MODEL=7233;COMPARTMENT=G1F');
  process.exit(2);
}
if (itemCodeTooLong(MODEL, COMP)) {
  bad(`"${skuCodeFor(MODEL, COMP)}" is longer than 30 characters — the SKU item-code limit`);
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}

// Malaysia (UTC+8) calendar date, matching todayMyt() in src/scm/lib/my-time.ts:
// the effective_from of a Maintenance save is the MY day it was saved.
const todayMyt = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const randId = (p) => `${p}-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-f0-9]/gi, '').slice(0, 12)}`;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} model=${MODEL} compartment="${COMP}"`);
  const today = todayMyt();

  // ── The Model: exactly one SOFA model of this company with this code ────────
  const models = await sql`SELECT id, model_code, name, branding, category, allowed_options
                             FROM scm.product_models
                            WHERE company_id = ${CO} AND upper(model_code) = ${MODEL.toUpperCase()} AND category = 'SOFA'`;
  if (models.length === 0) { bad(`no SOFA Model "${MODEL}" in company ${CO}`); process.exit(1); }
  if (models.length > 1) { bad(`${models.length} SOFA Models share code "${MODEL}" in company ${CO} — refusing to guess`); process.exit(1); }
  const model = models[0];

  // ── The pool: newest master config effective on/before today ───────────────
  const [poolRow] = await sql`SELECT id, config FROM scm.maintenance_config_history
                               WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= ${today}
                               ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
  if (!poolRow) { bad(`company ${CO} has no master maintenance config to extend`); process.exit(1); }

  const { config: newConfig, added: poolAdds } = poolWithCompartment(poolRow.config, COMP);
  const { options: newOptions, added: modelAdds } = optionsWithCompartment(model.allowed_options, COMP);

  const skuCode = skuCodeFor(model.model_code, COMP);
  const skuName = skuNameFor(model.name, model.model_code, COMP);
  const [existingSku] = await sql`SELECT code FROM scm.mfg_products
                                   WHERE company_id = ${CO} AND upper(code) = ${skuCode.toUpperCase()} LIMIT 1`;
  const skuAdds = !existingSku;

  note(`\n=== PLAN ===`);
  note(`  Model ${model.model_code} (${model.id})`);
  note(`  pool  : ${poolAdds ? 'WILL ADD' : 'already present'} "${COMP}" in master sofaCompartments`);
  note(`  model : ${modelAdds ? 'WILL ADD' : 'already present'} "${COMP}" in allowed_options.compartments`);
  note(`  sku   : ${skuAdds ? `WILL CREATE ${skuCode}  —  ${skuName}` : `exists ${existingSku.code}`}`);
  if (!poolAdds && !modelAdds && !skuAdds) note(`  nothing to do — "${COMP}" is already on ${model.model_code} end to end`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== APPLYING ===`);
  const poolId = randId('mch');
  const skuId = randId('mfg');
  const nowIso = new Date().toISOString();
  await sql.begin(async (tx) => {
    if (poolAdds) {
      await tx`INSERT INTO scm.maintenance_config_history (company_id, id, scope, config, effective_from, notes, created_by)
               VALUES (${CO}, ${poolId}, 'master', ${tx.json(newConfig)}, ${today}, ${`add compartment ${COMP} (add-model-compartment.mjs)`}, null)`;
      note(`  pool  : inserted master row ${poolId} effective ${today}`);
    }
    if (modelAdds) {
      await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(newOptions)}, updated_at = now()
                WHERE id = ${model.id} AND company_id = ${CO}`;
      note(`  model : ticked "${COMP}" on ${model.model_code}`);
    }
    if (skuAdds) {
      await tx`INSERT INTO scm.mfg_products
                 (company_id, id, code, name, category, base_model, model_id, branding, status, created_at, updated_at)
               VALUES (${CO}, ${skuId}, ${skuCode}, ${skuName}, 'SOFA', ${model.model_code}, ${model.id},
                       ${model.branding ?? null}, 'ACTIVE', ${nowIso}, ${nowIso})`;
      note(`  sku   : created ${skuCode} (${skuId})`);
    }
  });

  // ── Verify on a FRESH connection: the values, not a row count ───────────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [p] = await check`SELECT config->'sofaCompartments' AS comps FROM scm.maintenance_config_history
                             WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= ${today}
                             ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    const [m] = await check`SELECT allowed_options->'compartments' AS comps FROM scm.product_models WHERE id = ${model.id}`;
    const [s] = await check`SELECT code, name FROM scm.mfg_products
                             WHERE company_id = ${CO} AND upper(code) = ${skuCode.toUpperCase()} LIMIT 1`;
    const poolList = Array.isArray(p?.comps) ? p.comps : [];
    const modelList = Array.isArray(m?.comps) ? m.comps : [];
    note(`  pool  sofaCompartments: ${JSON.stringify(poolList)}`);
    note(`  model compartments:    ${JSON.stringify(modelList)}`);
    note(`  sku:                   ${s ? `${s.code} — ${s.name}` : '(missing)'}`);
    const okPool = poolList.includes(COMP);
    const okModel = modelList.includes(COMP);
    const okSku = Boolean(s);
    if (!okPool || !okModel || !okSku) {
      bad(`verification failed: pool=${okPool} model=${okModel} sku=${okSku}`);
      process.exit(1);
    }
    note(`  OK — "${COMP}" is in the pool, ticked on ${model.model_code}, and SKU ${skuCode} exists.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
