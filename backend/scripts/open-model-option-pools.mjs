#!/usr/bin/env node
// open-model-option-pools — every option a Model offers follows Modular, not a
// snapshot taken years ago. Takes a RESTORABLE backup first.
//
// OWNER, 2026-09-12. Asked whether the remaining pools (sizes, compartments,
// specials, divan / leg / total heights, gaps, mattress thickness) should follow
// Modular the way `fabrics` now does — clear all, clear only the add-on ones, or
// leave them — he answered 「全部都是啊」: all of them. He had already set the
// principle twice: 「限不限制是我在 Modular 那边自己选，不用去理」 and 「我的维护，
// 无论是打什么东西、标点符号、妖魔鬼怪，全部都是可以跳出来给我去做选择的」.
//
// WHAT THIS DOES, said plainly: a Model stops carrying its own allow-list, so
// every option that exists in Modular is offered, and a restriction exists only
// where HE ticks one. `hasRestriction` is `Array.isArray(pool) && pool.length > 0`
// (backend/src/scm/lib/allowed-options-check.ts), so an absent key and an empty
// one behave identically — the key is removed outright rather than left as a
// vestigial `[]`.
//
// THE CONCERN THAT WAS RAISED, AND HIS ANSWER. A size or a compartment pool is
// not obviously the same kind of thing as a fabric pool: a two-seater cannot be
// built with a three-seater's compartment, so those lists are sometimes RIGHT,
// and clearing them lets an order be keyed for something the factory cannot
// make. That was put to him with a recommendation to keep sizes and
// compartments; he chose all. It is recorded here because the next reader will
// wonder, and because the backup below is what makes the choice cheap to revisit.
//
// THE BACKUP IS THE POINT. Before a single row changes, the CURRENT
// `allowed_options` of every Model is written as one JSON document into
// `scm.app_config` under `scm.model_allowed_options_backup`, with the timestamp
// in its description. Restoring is a single UPDATE ... FROM over that JSON — the
// header of the restore section below has it verbatim. A change this wide with
// no way back is not one to make on a Friday or any other day.
//
// SCOPE: every company, every category, every pool key listed in POOL_KEYS.
// Models whose `allowed_options` is already empty are skipped, not rewritten.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="OPEN-OPTION-POOLS".
// RE-RUN: idempotent. A second run finds no Model carrying a pool and reports
// zero; it does NOT overwrite the backup row once written for that day, so
// re-running cannot destroy the only copy of the previous state.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "OPEN-OPTION-POOLS";
const BACKUP_KEY = "scm.model_allowed_options_backup";
const GH = !!process.env.GITHUB_ACTIONS;
const log = (m) => console.log(GH ? `::notice::${m}` : m);
const die = (m) => { console.error(GH ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

/** Every option list a Model can carry. `fabrics` is already cleared on SOFA
 *  Models (docs/bugs/0842) and is listed so a Model that regained one is caught. */
const POOL_KEYS = [
  "fabrics", "sizes", "compartments", "specials",
  "divan_heights", "leg_heights", "total_heights", "gaps",
  "mattress_thickness_cm",
];

const poolsOf = (ao) => {
  const out = {};
  for (const k of POOL_KEYS) {
    const v = ao?.[k];
    if (Array.isArray(v) && v.length > 0) out[k] = v.length;
  }
  return out;
};

async function main() {
  if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) die(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const models = await sql`
    SELECT company_id, model_code, category, allowed_options
      FROM scm.product_models
     ORDER BY company_id, category, model_code`;

  /* What is restricted today, per category per key — the shape of the change in
     the owner's own terms ("how many sofas stop having a size list"). */
  const byCat = new Map();
  const carrying = [];
  for (const m of models) {
    const cat = String(m.category ?? "(none)").toUpperCase();
    const pools = poolsOf(m.allowed_options);
    if (!byCat.has(cat)) byCat.set(cat, { models: 0, keys: new Map() });
    const e = byCat.get(cat);
    e.models += 1;
    for (const [k, n] of Object.entries(pools)) {
      if (!e.keys.has(k)) e.keys.set(k, { models: 0, sizes: new Set() });
      e.keys.get(k).models += 1;
      e.keys.get(k).sizes.add(n);
    }
    if (Object.keys(pools).length) carrying.push(m);
  }

  log(`Models: ${models.length}; carrying at least one option pool: ${carrying.length}`);
  for (const [cat, e] of [...byCat].sort()) {
    const parts = [...e.keys].sort().map(([k, v]) => `${k}=${v.models} (list of ${[...v.sizes].sort((a, b) => a - b).join("/")})`);
    console.log(`  ${cat.padEnd(10)} ${String(e.models).padStart(4)} model(s)   ${parts.length ? parts.join("  ") : "(nothing restricted)"}`);
  }

  if (!carrying.length) { log("Nothing to do — no Model restricts any option."); await sql.end(); return; }

  if (MODE !== "apply") {
    log(`\nPLAN ONLY — nothing written, and no backup taken. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    log("On apply, the CURRENT allowed_options of every Model is saved to "
      + `scm.app_config['${BACKUP_KEY}'] first; the restore statement is in this script's header.`);
    await sql.end();
    return;
  }

  /* ── The backup, BEFORE anything moves ─────────────────────────────────────
     One JSON document: [{ company_id, model_code, allowed_options }, ...].
     Written with ON CONFLICT DO NOTHING so a SECOND run cannot overwrite the
     copy of the pre-change state with a copy of the post-change state — which
     is the one way a backup like this destroys itself. */
  const snapshot = models.map((m) => ({
    company_id: m.company_id, model_code: m.model_code, allowed_options: m.allowed_options,
  }));
  /* `::text` on the snapshot bind is load-bearing, not decoration.
     `scm.app_config.value` is a TEXT column (mig 0272), so JSON.stringify is the
     right bind — but postgres.js asks the SERVER for parameter types and runs
     its own JSON.stringify over anything typed json/jsonb, which would encode
     this twice and leave the backup a jsonb STRING that the restore statement
     below reads as nothing. The cast pins the parameter as text so the driver's
     serializer never runs. `audit:jsonb-binds` refuses the bind without it;
     docs/jsonb-double-encoding-coe.md is why. On a BACKUP the stake is the whole
     point: a double-encoded copy of the previous state is not a copy. */
  const [existing] = await sql`SELECT key, updated_at FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
  if (existing) {
    log(`BACKUP already exists (written ${new Date(existing.updated_at).toISOString()}) — keeping it. `
      + "It holds the state BEFORE the first apply, which is the one worth keeping.");
  } else {
    await sql`
      INSERT INTO scm.app_config (key, value, description, updated_at)
      VALUES (${BACKUP_KEY}, ${JSON.stringify(snapshot)}::text,
              ${`product_models.allowed_options for ${models.length} model(s), taken ${new Date().toISOString()} before open-model-option-pools`},
              now())
      ON CONFLICT (key) DO NOTHING`;
    const [check] = await sql`SELECT length(value) AS n FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
    if (!check || !(check.n > 0)) die("BACKUP FAILED — refusing to clear anything without a copy of the current state.");
    log(`BACKUP written: ${models.length} model(s), ${check.n} bytes, scm.app_config['${BACKUP_KEY}'].`);
  }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const m of carrying) {
      await tx`UPDATE scm.product_models
                  SET allowed_options = allowed_options - ${POOL_KEYS}::text[],
                      updated_at = now()
                WHERE company_id = ${m.company_id} AND model_code = ${m.model_code}`;
      n += 1;
    }
  });
  log(`APPLIED: ${n} Model(s) no longer restrict any option.`);
  await sql.end();

  /* Verify on a FRESH connection, asserting the SHAPE — no Model carries a
     non-empty pool — rather than the number of rows the UPDATE reported. */
  const v2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v2`SELECT company_id, model_code, allowed_options FROM scm.product_models`;
  const [backupRow] = await v2`SELECT length(value) AS n FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
  await v2.end();
  const still = after.filter((m) => Object.keys(poolsOf(m.allowed_options)).length > 0);
  if (still.length) {
    die(`VERIFY FAILED: ${still.length} Model(s) still restrict an option — ${still.slice(0, 5).map((m) => m.model_code).join(", ")}`);
  }
  if (!backupRow || !(backupRow.n > 0)) die("VERIFY FAILED: the backup row is gone.");
  log(`VERIFIED on a fresh connection: no Model restricts any option, and the ${backupRow.n}-byte backup is in place.`);

  /* ── RESTORE (not run here; this is the statement, kept beside the code that
     made it necessary) ───────────────────────────────────────────────────────
       UPDATE scm.product_models m
          SET allowed_options = b.allowed_options, updated_at = now()
         FROM (SELECT (e->>'company_id')::int AS company_id,
                       e->>'model_code'        AS model_code,
                       e->'allowed_options'    AS allowed_options
                 FROM scm.app_config c,
                      LATERAL jsonb_array_elements(c.value::jsonb) e
                WHERE c.key = 'scm.model_allowed_options_backup') b
        WHERE m.company_id = b.company_id AND m.model_code = b.model_code;                  */
}

main().catch((e) => die(e?.message ?? String(e)));
