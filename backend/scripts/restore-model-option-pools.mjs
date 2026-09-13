#!/usr/bin/env node
// restore-model-option-pools — put back the `allowed_options` that
// `open-model-option-pools` cleared on 2026-09-13.
//
// WHY THIS HAD TO BE WRITTEN, said plainly. The clear was run on the owner's
// ruling 「全部都是啊」, which he gave about RESTRICTIONS — the sofa-fabric
// problem, where a Model's pool stopped him picking a colour that exists. The
// clear then treated every pool key as a restriction. Several of them are not:
//
//   • `product-models.ts` (PATCH /:id, "Chairman 2026-06-01"): for MATTRESS and
//     BEDFRAME, `allowed_options.sizes` is "the SINGLE source of truth for
//     ON/OFF — there is no separate per-SKU Visible toggle anymore", mirrored
//     onto each SKU's `pos_active`. It is not a filter over a master list; it IS
//     the record of which sizes that Model comes in.
//   • MATTRESS thickness lives ONLY at
//     `Model.allowed_options.mattress_thickness_cm` (same file, the generate-skus
//     MATTRESS branch). Clearing it deletes the value outright.
//   • `ProductModelDetail.tsx` renders the Modular editor's ticked boxes FROM
//     these pools, so a cleared Model reads as "nothing configured".
//
// So the clear removed CONFIGURATION, not only restrictions, and the owner saw
// it as sizes and the headrest going missing on the 2990 side. Full trace:
// docs/bugs/0855.
//
// WHAT THIS RESTORES: every Model's `allowed_options` exactly as the backup
// recorded it, from `scm.app_config['scm.model_allowed_options_backup']`.
//
// That backup was taken immediately before the clear, so it already contains the
// EARLIER, deliberate sofa-fabric opening (docs/bugs/0842) — restoring does not
// undo that, and sofa fabrics stay unrestricted. This puts the database back to
// the morning of 2026-09-13 for this column and nothing else.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="RESTORE-OPTION-POOLS".
// COMPANY= limits it to one company id; empty means every company.
//
// RE-RUN: idempotent. A second run finds every Model already equal to its backup
// and reports zero changes. It never deletes the backup row, so it can be run
// again after a partial failure.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "RESTORE-OPTION-POOLS";
const ONLY_COMPANY = (process.env.COMPANY || "").trim();
const BACKUP_KEY = "scm.model_allowed_options_backup";
const GH = !!process.env.GITHUB_ACTIONS;
const log = (m) => console.log(GH ? `::notice::${m}` : m);
const die = (m) => { console.error(GH ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const POOL_KEYS = [
  "fabrics", "sizes", "compartments", "specials",
  "divan_heights", "leg_heights", "total_heights", "gaps",
  "mattress_thickness_cm",
];

const poolCount = (ao) => POOL_KEYS.reduce(
  (n, k) => n + (Array.isArray(ao?.[k]) && ao[k].length > 0 ? 1 : 0), 0,
);

/** Deep-equal for the pool subset only — the shape this script owns. */
const samePools = (a, b) => POOL_KEYS.every((k) => {
  const x = Array.isArray(a?.[k]) ? a[k].map(String) : null;
  const y = Array.isArray(b?.[k]) ? b[k].map(String) : null;
  if (x === null || y === null) return x === y;
  return x.length === y.length && x.every((v, i) => v === y[i]);
});

async function main() {
  if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) die(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const [backupRow] = await sql`SELECT value, updated_at FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
  if (!backupRow) {
    /* The backup MISSING is the finding. Never invent one. */
    await sql.end();
    die(`No backup at scm.app_config['${BACKUP_KEY}'] on this database — there is nothing to restore from, and this script must not guess a previous state.`);
  }
  const backup = JSON.parse(backupRow.value);
  log(`Backup taken ${new Date(backupRow.updated_at).toISOString()} — ${backup.length} model(s).`);

  const live = await sql`SELECT company_id, model_code, category, allowed_options FROM scm.product_models`;
  const liveBy = new Map(live.map((m) => [`${m.company_id}::${m.model_code}`, m]));

  const todo = [];
  let missing = 0;
  for (const b of backup) {
    if (ONLY_COMPANY && String(b.company_id) !== ONLY_COMPANY) continue;
    const m = liveBy.get(`${b.company_id}::${b.model_code}`);
    if (!m) { missing += 1; continue; }
    if (samePools(m.allowed_options, b.allowed_options)) continue;
    todo.push(b);
  }

  /* A Model in the backup that no longer exists is reported, never silently
     skipped: it means somebody deleted a Model since the backup, and that is a
     fact the reader needs even though this script cannot act on it. */
  if (missing) log(`${missing} model(s) in the backup no longer exist live — reported, not restored.`);

  const byCo = new Map();
  for (const b of todo) {
    const co = Number(b.company_id);
    if (!byCo.has(co)) byCo.set(co, { models: 0, pools: 0 });
    byCo.get(co).models += 1;
    byCo.get(co).pools += poolCount(b.allowed_options);
  }
  log(`Models whose pools differ from the backup: ${todo.length}`);
  for (const [co, e] of [...byCo].sort((a, b) => a[0] - b[0])) {
    console.log(`  company ${String(co).padEnd(4)} ${String(e.models).padStart(4)} model(s), ${e.pools} pool(s) to put back`);
  }

  if (!todo.length) { log("Nothing to do — every Model already matches the backup."); await sql.end(); return; }

  if (MODE !== "apply") {
    log(`\nPLAN ONLY — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const b of todo) {
      /* The whole blob is replaced, not merged: the backup IS the previous
         state, and merging would leave a key the clear removed and the backup
         does not have. ::jsonb via a text-typed parameter so postgres.js cannot
         double-encode it (docs/jsonb-double-encoding-coe.md). */
      await tx`UPDATE scm.product_models
                  SET allowed_options = ${JSON.stringify(b.allowed_options ?? {})}::text::jsonb,
                      updated_at = now()
                WHERE company_id = ${b.company_id} AND model_code = ${b.model_code}`;
      n += 1;
    }
  });
  log(`APPLIED: ${n} Model(s) restored.`);
  await sql.end();

  /* Verify on a FRESH connection, asserting the SHAPE — every restored Model's
     pools equal the backup's — not the number of rows the UPDATE reported. */
  const v2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v2`SELECT company_id, model_code, allowed_options FROM scm.product_models`;
  await v2.end();
  const afterBy = new Map(after.map((m) => [`${m.company_id}::${m.model_code}`, m.allowed_options]));
  const wrong = todo.filter((b) => !samePools(afterBy.get(`${b.company_id}::${b.model_code}`), b.allowed_options));
  if (wrong.length) {
    die(`VERIFY FAILED: ${wrong.length} Model(s) still differ from the backup — ${wrong.slice(0, 5).map((b) => b.model_code).join(", ")}`);
  }
  const restoredPools = todo.reduce((s, b) => s + poolCount(b.allowed_options), 0);
  log(`VERIFIED on a fresh connection: ${todo.length} Model(s) match the backup exactly, ${restoredPools} pool(s) back in place.`);
}

main().catch((e) => die(e?.message ?? String(e)));
