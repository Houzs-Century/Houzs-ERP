#!/usr/bin/env node
// check-allowed-options-vocabulary — does every value in a Model's option pool
// mean anything to the gate that reads it?
//
// WHY THIS EXISTS. `product_models.allowed_options` is filled by one screen and
// read by another, and on 2026-09-11 the two were speaking different languages
// for one key. The Modular drawer offers fabric SERIES
// (`fabric_library.id`, `ProductModelDetail.tsx` hands it
// `fabricLibQ.data.filter(active).map(f => f.id)`); the gate and the POS picker
// compared the line's COLOUR (`fabric_colours.colour_id`). MEASURED that day on
// company 1: all 79 sofa Models carried the SAME 101-entry pool - 91 library
// ids, 3 colour ids, 10 library LABELS - while 851 colours were active. So the
// owner opened every Model's allow-list and his staff could still pick exactly
// THREE of 851 fabrics. docs/bugs/0814.
//
// The owner's question when he heard it was the right one: 「fix 掉了就不会有
// 相同的问题了是吧」. A promise does not answer that; a check does. This one
// resolves every pool value against the table the gate compares it to and
// reports what matches NOTHING - so the next time a pool is filled from the
// wrong list, this says so instead of a salesperson discovering it at the till.
//
// It is DIAGNOSTIC, not a repair: read-only, one statement per table, and it
// exits 0 for every legitimate answer (a red job reads as "the check broke").
// `--strict` makes an unresolvable value exit 1, for wiring into CI once the
// tree is clean.
//
// WHAT IT CANNOT DO, said plainly: it only knows the keys listed in RESOLVERS
// below. A NEW option key added to `allowed_options` is invisible to it until
// somebody adds a resolver - so the list is printed on every run, including the
// keys it found in the data and does not understand.
//
//   DATABASE_URL=... node backend/scripts/check-allowed-options-vocabulary.mjs
//   ... --strict
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const STRICT = process.argv.includes("--strict");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

/* Each entry: the pool key, and the set of values the GATE will accept for it.
   `from` returns the accepted strings; `reads` names, for the reader, where the
   gate takes the line's value from - so a mismatch report says which side to
   change. Keys whose values are free text the gate compares literally
   (`specials`) or which come off the product row rather than a lookup table
   (`sizes`) resolve against the DOCUMENTS instead: what lines actually store. */
const RESOLVERS = {
  fabrics: {
    reads: "line variants.fabricCode / .colourId, or .fabricId (the series)",
    from: async (sql, company) => {
      const colours = await sql`SELECT colour_id FROM scm.fabric_colours WHERE company_id = ${company}`;
      const series = await sql`SELECT id FROM scm.fabric_library WHERE company_id = ${company}`;
      return new Set([...colours.map((r) => r.colour_id), ...series.map((r) => r.id)]);
    },
  },
  compartments: {
    reads: "the line's item_code suffix, or variants.cells[].moduleId",
    from: async (sql, company) => {
      const rows = await sql`
        SELECT DISTINCT substring(item_code from '-([^-]+)$') AS sfx
          FROM scm.mfg_sales_order_items WHERE company_id = ${company} AND item_code LIKE '%-%'`;
      return new Set(rows.map((r) => r.sfx).filter(Boolean));
    },
  },
  divan_heights: { reads: "line variants.divanHeight", from: (sql, c) => seenVariant(sql, c, "divanHeight") },
  leg_heights:   { reads: "line variants.legHeight",   from: (sql, c) => seenVariant(sql, c, "legHeight") },
  total_heights: { reads: "line variants.totalHeight", from: (sql, c) => seenVariant(sql, c, "totalHeight") },
  gaps:          { reads: "line variants.gap",         from: (sql, c) => seenVariant(sql, c, "gap") },
};

/** The distinct values live lines actually carry for one variant key. Used for
 *  the keys whose vocabulary has no lookup table - the documents ARE the
 *  vocabulary. A pool value absent here is SUSPICIOUS, not proven wrong: a
 *  legitimately never-sold option looks identical, which is why those are
 *  reported as ADVISORY and never fail --strict. */
async function seenVariant(sql, company, key) {
  const rows = await sql`
    SELECT DISTINCT variants->>${key} AS v FROM scm.mfg_sales_order_items
     WHERE company_id = ${company} AND variants ? ${key}`;
  return new Set(rows.map((r) => r.v).filter((v) => v != null));
}

/** Keys that have a lookup table, so an unresolvable value is a DEFECT rather
 *  than an option nobody has sold yet. Only these can fail --strict. */
const AUTHORITATIVE = new Set(["fabrics"]);

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  await sql`SET default_transaction_read_only = on`;

  const companies = await sql`
    SELECT DISTINCT company_id FROM scm.product_models WHERE allowed_options IS NOT NULL ORDER BY company_id`;
  let defects = 0;

  for (const { company_id: company } of companies) {
    const models = await sql`
      SELECT model_code, category, allowed_options FROM scm.product_models
       WHERE company_id = ${company} AND allowed_options IS NOT NULL`;
    log(`\n=== company ${company}: ${models.length} model(s) with an option blob ===`);

    /* Every key present in the DATA, not a hand-kept list - so a key nobody
       wrote a resolver for is visible instead of silently unchecked. */
    const keysInData = new Set();
    for (const m of models) for (const k of Object.keys(m.allowed_options ?? {})) keysInData.add(k);
    const unknown = [...keysInData].filter((k) => !RESOLVERS[k]);
    if (unknown.length) warn(`   keys with NO resolver (not checked): ${unknown.join(", ")}`);

    for (const key of Object.keys(RESOLVERS)) {
      const pooled = new Map();     // value -> how many models carry it
      for (const m of models) {
        const arr = m.allowed_options?.[key];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        for (const v of arr) pooled.set(String(v), (pooled.get(String(v)) ?? 0) + 1);
      }
      if (pooled.size === 0) { log(`   ${key.padEnd(14)} no model restricts this`); continue; }

      const accepted = await RESOLVERS[key].from(sql, company);
      const orphans = [...pooled.keys()].filter((v) => !accepted.has(v));
      const authoritative = AUTHORITATIVE.has(key);
      const head = `   ${key.padEnd(14)} ${String(pooled.size).padEnd(4)} value(s), ${String(orphans.length).padEnd(4)} match NOTHING`;

      if (orphans.length === 0) { log(`${head}  ok`); continue; }
      const sample = orphans.slice(0, 8).map((v) => JSON.stringify(v)).join(", ");
      const line = `${head}  <- ${authoritative ? "DEFECT" : "advisory"}; the gate reads ${RESOLVERS[key].reads}`;
      (authoritative ? warn : log)(line);
      (authoritative ? warn : log)(`      e.g. ${sample}${orphans.length > 8 ? ` (and ${orphans.length - 8} more)` : ""}`);
      if (authoritative) defects += orphans.length;
    }
  }

  await sql.end();
  log("");
  if (defects === 0) {
    log("Every pool value in an authoritative key resolves. Nothing to fix.");
    return;
  }
  warn(`${defects} pool value(s) in an authoritative key resolve to nothing.`);
  warn("A value that matches neither side is unreachable: a Model that lists it offers nothing by it.");
  if (STRICT) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
