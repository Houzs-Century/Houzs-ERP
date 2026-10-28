#!/usr/bin/env node
// check-model-option-pools-vs-backup — what each COMPANY's Models offered before
// `open-model-option-pools` cleared their pools, and what they offer now.
//
// WHY THIS EXISTS. On 2026-09-13 the owner reported that on the 2990 side some
// SIZES and the HEADREST had gone missing from the pickers. Earlier the same day
// `open-model-option-pools` cleared `allowed_options` on 421 Models — and its
// scope was EVERY COMPANY, while the ruling it implemented
// (「全部都是啊」) was given about the sofa/fabric problem on the HOUZS side.
// That is the first thing to rule in or out, and guessing either way is not
// allowed here.
//
// READ-ONLY. One read of `scm.product_models`, one of the backup row, one of
// `public.companies`. No DDL, no writes, no transaction.
//
// WHAT IT ANSWERS, per company:
//   • how many Models carried a pool BEFORE, and how many carry one NOW;
//   • per pool key, how many Models lost a restriction;
//   • the DISTINCT option values that existed ONLY inside a pool and appear in
//     no other Model's pool — the ones that could not come back from a master
//     list, which is the shape of "an option disappeared".
//
// That last section is the point. Clearing a pool is supposed to make a picker
// offer MORE (an absent pool means unrestricted, per lib/allowed-options-check
// and SoLineCard's specials filter). It can only REMOVE something if the pool
// was the option's only home — so the report names exactly those values.
//
// RE-RUN: read-only and idempotent. Every run re-reads the live rows and the
// backup; nothing is cached and nothing is written, so a second run is free and
// answers about the state at that moment.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const ONLY = (process.env.COMPANY || "").trim();
const BACKUP_KEY = "scm.model_allowed_options_backup";
const GH = !!process.env.GITHUB_ACTIONS;
const log = (m) => console.log(GH ? `::notice::${m}` : m);

const POOL_KEYS = [
  "fabrics", "sizes", "compartments", "specials",
  "divan_heights", "leg_heights", "total_heights", "gaps",
  "mattress_thickness_cm",
];

/** The non-empty pools on one allowed_options blob, as key -> values. */
const poolsOf = (ao) => {
  const out = {};
  for (const k of POOL_KEYS) {
    const v = ao?.[k];
    if (Array.isArray(v) && v.length > 0) out[k] = v.map((x) => String(x));
  }
  return out;
};

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const companies = await sql`SELECT id, code, name FROM public.companies ORDER BY id`;
  const nameOf = new Map(companies.map((c) => [Number(c.id), `${c.code} (${c.name})`]));

  const live = await sql`
    SELECT company_id, model_code, category, allowed_options
      FROM scm.product_models ORDER BY company_id, model_code`;

  const [backupRow] = await sql`SELECT value, updated_at FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
  await sql.end();

  if (!backupRow) {
    /* The backup MISSING is itself the finding — never invent one to make the
       report readable (CLAUDE.md: evidence is not a setting). */
    console.error(`::error::No backup row at scm.app_config['${BACKUP_KEY}'] on this database. `
      + "Without it there is nothing to compare against, and this check must not guess.");
    process.exit(0);
  }

  const before = JSON.parse(backupRow.value);
  log(`Backup taken ${new Date(backupRow.updated_at).toISOString()} — ${before.length} model(s).`);
  log(`Live now: ${live.length} model(s) across ${companies.length} compan(ies).`);

  const keyOf = (r) => `${r.company_id}::${r.model_code}`;
  const beforeBy = new Map(before.map((b) => [`${b.company_id}::${b.model_code}`, poolsOf(b.allowed_options)]));

  /* Per company: models that HAD a pool, and what each key lost. */
  const byCo = new Map();
  /* Every value that appeared in ANY pool, and where. Used below to answer the
     only question that matters: could this value come back from somewhere else? */
  const valueHomes = new Map();   // "key::value" -> Set(company::model)

  for (const m of live) {
    const co = Number(m.company_id);
    if (ONLY && String(co) !== ONLY && (nameOf.get(co) ?? "").indexOf(ONLY) === -1) continue;
    const was = beforeBy.get(keyOf(m)) ?? {};
    const now = poolsOf(m.allowed_options);
    if (!byCo.has(co)) byCo.set(co, { models: 0, hadPool: 0, hasPool: 0, lost: new Map() });
    const e = byCo.get(co);
    e.models += 1;
    if (Object.keys(was).length) e.hadPool += 1;
    if (Object.keys(now).length) e.hasPool += 1;
    for (const [k, vals] of Object.entries(was)) {
      if (!now[k]) {
        e.lost.set(k, (e.lost.get(k) ?? 0) + 1);
      }
      for (const v of vals) {
        const id = `${k}::${v}`;
        if (!valueHomes.has(id)) valueHomes.set(id, new Set());
        valueHomes.get(id).add(`${co}::${m.model_code}`);
      }
    }
  }

  console.log("\ncompany                          models   had a pool   has one now   keys cleared");
  console.log("-------------------------------  ------   ----------   -----------   ------------");
  for (const [co, e] of [...byCo].sort((a, b) => a[0] - b[0])) {
    const keys = [...e.lost].sort().map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(
      `${(nameOf.get(co) ?? `company ${co}`).padEnd(31)}  ${String(e.models).padStart(6)}   ${String(e.hadPool).padStart(10)}   ${String(e.hasPool).padStart(11)}   ${keys || "(none)"}`,
    );
  }

  /* THE ONE THAT EXPLAINS A MISSING OPTION. A value that lived in exactly one
     Model's pool has no second home; if the picker's unrestricted list is built
     from a master table it still appears, and if it was only ever in the pool it
     is now unreachable. The report cannot tell which from here — it names the
     values so a reader can check ONE of them instead of hunting. */
  const orphans = [...valueHomes].filter(([, homes]) => homes.size === 1);
  console.log(`\nValues that lived in exactly ONE model's pool: ${orphans.length}`);
  const byKey = new Map();
  for (const [id] of orphans) {
    const [k, ...rest] = id.split("::");
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(rest.join("::"));
  }
  for (const [k, vals] of [...byKey].sort()) {
    console.log(`  ${k.padEnd(22)} ${vals.length} value(s): ${vals.slice(0, 12).join(", ")}${vals.length > 12 ? " …" : ""}`);
  }

  log("\nRead-only: nothing was written. Restore for ONE company is the UPDATE in "
    + "open-model-option-pools.mjs's footer with a company_id predicate added.");
}

main().catch((e) => { console.error(GH ? `::error::${e?.message ?? e}` : e); process.exit(1); });
