#!/usr/bin/env node
// open-model-fabric-pools — clear the fabric allow-list nobody chose, so a
// fabric added in Modular is offered by every Model from the moment it exists.
//
// THE OWNER'S RULE, 2026-09-12: 「限不限制是我在 Modular 那边自己选，不用去理」
// and 「我的维护，无论是打什么东西、标点符号、妖魔鬼怪，全部都是可以跳出来给我去
// 做选择的」. Whether a Model restricts its fabrics is HIS decision, taken in the
// Modular drawer. A pool that arrived as a snapshot is a restriction the system
// applied on his behalf, and this removes it.
//
// WHAT IS ACTUALLY THERE, measured on the staging copy of production
// 2026-09-12T11:19Z (79 sofa Models, 820 active colours, 182 fabric series of
// which 100 carry colours):
//
//   * all 79 sofa Models carry the SAME 101-entry pool - one snapshot, copied;
//   * every one of those 101 entries is a valid fabric SERIES id (0 dead
//     values, after docs/bugs/0814 rewrote the ten labels);
//   * so today the pool reaches 820 of 820 colours - it restricts NOTHING;
//   * all 113 bedframe Models already carry no pool at all.
//
// SO THIS CHANGES NOTHING AN OPERATOR CAN SEE TODAY, and that is the point of
// saying it out loud rather than selling a fix. What it changes is TOMORROW:
// with a pool present, a fabric series created in Modular is offered by NO sofa
// Model until somebody edits 79 of them, because a non-empty pool means
// "restrict to exactly these" (`hasRestriction` in
// backend/src/scm/lib/allowed-options-check.ts). Empty means "no restriction",
// which is what the bedframes already do and what the owner asked for.
//
// NOT A GUESS ABOUT THE GATE: `hasRestriction(pool)` is
// `Array.isArray(pool) && pool.length > 0`, and both the server gate and the
// desktop picker read it, so an EMPTY array and an ABSENT key behave
// identically. This writes the key away entirely (`- 'fabrics'`) rather than
// setting `[]`, so the blob carries no vestigial key for a later reader to
// wonder about.
//
// SCOPE: every company, SOFA Models only. Bedframes have no pool to clear;
// mattresses and accessories do not use the fabric pool at all. A Model whose
// pool is ALREADY absent or empty is skipped, not rewritten.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="OPEN-FABRIC-POOLS".
// RE-RUN: idempotent. A second run finds no sofa Model carrying a pool and
// reports zero; the fresh-connection check asserts the SHAPE - that no SOFA
// Model has a non-empty fabrics pool - not the row count.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "OPEN-FABRIC-POOLS";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`);
  process.exit(1);
};

/** Colours reachable from a pool of series ids + colour ids — what the operator
 *  can actually pick, which is the number worth printing beside a change. */
const reachable = (pool, coloursBySeries, colourIds) => {
  const out = new Set();
  for (const v of pool) {
    for (const c of coloursBySeries.get(v) ?? []) out.add(c);
    if (colourIds.has(v)) out.add(v);
  }
  return out.size;
};

async function main() {
  if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) {
    die(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  }
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  /* `category` is the ENUM scm.mfg_product_category, so coalesce(category, '')
     asks Postgres to read '' AS that enum and it refuses — "invalid input value
     for enum scm.mfg_product_category". Cast to text FIRST; the comparison was
     always a text one. Caught by the first staging plan run (34691761762). */
  const models = await sql`
    SELECT company_id, model_code, category,
           coalesce(allowed_options->'fabrics', 'null'::jsonb) AS pool
      FROM scm.product_models
     WHERE upper(coalesce(category::text, '')) = 'SOFA'
     ORDER BY company_id, model_code`;
  const colours = await sql`
    SELECT company_id, fabric_id, colour_id FROM scm.fabric_colours
     WHERE coalesce(active, true) = true`;

  const perCompany = new Map();
  for (const c of colours) {
    const k = String(c.company_id);
    if (!perCompany.has(k)) perCompany.set(k, { bySeries: new Map(), ids: new Set() });
    const e = perCompany.get(k);
    if (!e.bySeries.has(String(c.fabric_id))) e.bySeries.set(String(c.fabric_id), []);
    e.bySeries.get(String(c.fabric_id)).push(String(c.colour_id));
    e.ids.add(String(c.colour_id));
  }

  const carrying = models.filter((m) => Array.isArray(m.pool) && m.pool.length > 0);
  log(`SOFA Models: ${models.length}; carrying a fabric pool: ${carrying.length}`);
  if (carrying.length === 0) {
    log("Nothing to do — no sofa Model restricts its fabrics.");
    await sql.end();
    return;
  }

  /* What each Model can offer BEFORE and AFTER, so the plan says what the
     change costs rather than only what it touches. AFTER is every active
     colour of that company, because an empty pool is no restriction. */
  const byCompany = new Map();
  for (const m of carrying) {
    const k = String(m.company_id);
    const e = perCompany.get(k) ?? { bySeries: new Map(), ids: new Set() };
    const before = reachable(m.pool.map(String), e.bySeries, e.ids);
    const after = e.ids.size;
    if (!byCompany.has(k)) byCompany.set(k, { models: 0, poolSizes: new Set(), before: new Set(), after });
    const b = byCompany.get(k);
    b.models += 1;
    b.poolSizes.add(m.pool.length);
    b.before.add(before);
  }
  for (const [company, b] of byCompany) {
    log(`  company ${company}: ${b.models} model(s), pool size ${[...b.poolSizes].join("/")}, `
      + `colours offered ${[...b.before].sort((x, y) => x - y).join("/")} -> ${b.after} (every active colour)`);
  }
  const widens = [...byCompany.values()].some((b) => [...b.before].some((n) => n < b.after));
  log(widens
    ? "This WIDENS what at least one Model offers today."
    : "No Model's offer changes today — every pool already reaches every active colour. "
      + "The change is that a fabric added LATER is offered without editing 79 Models.");

  if (MODE !== "apply") {
    log(`\nPLAN ONLY — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const m of carrying) {
      await tx`UPDATE scm.product_models
                  SET allowed_options = allowed_options - 'fabrics',
                      updated_at = now()
                WHERE company_id = ${m.company_id} AND model_code = ${m.model_code}`;
      n++;
    }
  });
  log(`\nAPPLIED: ${n} sofa Model(s) no longer restrict their fabrics.`);
  await sql.end();

  /* Verify on a FRESH connection and assert the SHAPE — that no SOFA Model
     carries a non-empty pool — not the number of rows the UPDATE reported. A
     rowcount is true while the blob is wrong (docs/jsonb-double-encoding-coe.md). */
  const v2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v2`
    SELECT company_id, model_code
      FROM scm.product_models
     WHERE upper(coalesce(category::text, '')) = 'SOFA'
       AND jsonb_array_length(coalesce(allowed_options->'fabrics', '[]'::jsonb)) > 0`;
  await v2.end();
  if (after.length) {
    die(`VERIFY FAILED: ${after.length} sofa Model(s) still carry a fabric pool — `
      + after.slice(0, 5).map((r) => r.model_code).join(", "));
  }
  log("VERIFIED on a fresh connection: no sofa Model restricts its fabrics.");
}

main().catch((e) => die(e?.message ?? String(e)));
