#!/usr/bin/env node
// Repair the custom_specials values that backfill-sofa-special-orders.mjs
// double-encoded into jsonb STRING scalars.
//
// THE DAMAGE. That backfill bound `JSON.stringify(value)` to a `$1::jsonb`
// parameter. postgres.js runs with `prepare: false`, so with parameters present
// it asks the server for the parameter types before binding, resolves $1 to
// jsonb (OID 3802), and applies its OWN JSON.stringify serializer for that OID
// — encoding an already-stringified value a SECOND time. The column therefore
// holds a jsonb string like "[\"BOTTOM USE UMBRELLA FABRIC\"]" instead of a
// value. Full chain in docs/jsonb-double-encoding-coe.md and BUG-HISTORY.md.
//
// WHY THE REPAIR IS `NULL`, NOT "DECODE IT BACK".
//   1. custom_specials is a DERIVED OUTPUT, not an operator choice. The pricing
//      recompute reads variants.specials (mfg-pricing-recompute.ts:283) and
//      EMITS custom_specials from it (:604); the SO line PATCH overwrites it
//      wholesale on every recompute (mfg-sales-orders.ts:8234). It is a cache
//      of a derivation, and NULL is exactly the state of a line that has not
//      been recomputed yet — an honest, self-healing value.
//   2. Decoding would restore data that was ALREADY WRONG before it was
//      double-encoded. The declared shape is
//      `Array<{ description, surchargeSen }>` (mfg-pricing-recompute.ts:117);
//      what the old backfill wrote was a bare string[] of verbatim slip
//      phrases ("BOTTOM USE UMBRELLA FABRIC"), not picker codes and not that
//      shape. Un-double-encoding it produces valid jsonb holding invalid data,
//      which is worse than empty because it looks repaired.
//   3. Writing the "correct" derived value here would mean reimplementing the
//      pricing engine outside the pricing engine and stamping surchargeSen
//      figures onto historical documents. The owner ruled on 2026-08-11 that
//      migrated lines must NOT reprice. NULL cannot move money; a hand-computed
//      surcharge can.
//   4. NULL cannot make a report show the WRONG specials — it shows none, while
//      the real picker state lives in variants.specials, which is populated and
//      clean (backfill-specials-into-variants.mjs, run 31419290223).
//
// NOTHING IS LOST (owner 2026-08-11, 不可以删只可以 cancel). Every row's current
// raw value is PRINTED before the write, so the prior state is recoverable from
// the run log; description2 — the source text all of it was derived from — is
// untouched; and variants.specials carries the codes.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. Keyed on jsonb_typeof(custom_specials) = 'string', which the write turns into NULL.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 400);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* The two line tables and how each reaches its company. purchase_orders numbers
   itself po_number and joins on id; only the SO header uses doc_no. */
const TABLES = [
  { key: "so", table: "mfg_sales_order_items",
    join: "JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no", doc: "i.doc_no", code: "i.item_code" },
  { key: "po", table: "purchase_order_items",
    join: "JOIN scm.purchase_orders h ON h.id = i.purchase_order_id", doc: "h.po_number", code: "i.item_code" },
];

/* A shape census, so the report says what is actually there rather than what we
   expect. 'string' is the double-encoded damage; 'array'/'object' are real
   values; NULL rows are already in the target state. */
async function census(db, t) {
  return db.unsafe(
    `SELECT jsonb_typeof(i.custom_specials) AS shape, COUNT(*)::int AS n
       FROM scm.${t.table} i ${t.join}
      WHERE h.company_id = $1 AND i.custom_specials IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`, [CO]);
}

async function damaged(db, t) {
  return db.unsafe(
    `SELECT i.id::text AS id, ${t.doc} AS doc, ${t.code} AS code,
            i.custom_specials #>> '{}' AS raw
       FROM scm.${t.table} i ${t.join}
      WHERE h.company_id = $1 AND jsonb_typeof(i.custom_specials) = 'string'
      ORDER BY 2, 3`, [CO]);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const found = {};
  for (const t of TABLES) {
    const c = await census(sql, t);
    log("");
    log(`scm.${t.table}.custom_specials shape census (non-null rows):`);
    for (const r of c) log(`   ${String(r.n).padStart(5)}  ${r.shape}`);
    found[t.key] = await damaged(sql, t);
    log(`   double-encoded (jsonb string): ${found[t.key].length}`);
  }

  const total = TABLES.reduce((a, t) => a + found[t.key].length, 0);
  log("");
  log(`TOTAL double-encoded custom_specials: ${total}`);
  if (!total) { log("nothing to repair."); await sql.end(); return; }

  /* Print every row's current value BEFORE touching it. This log is the record
     of the prior state — the repair sets NULL, so this is the only place the
     old value survives. */
  log("");
  log(`current values, printed in full so the prior state survives this repair (first ${SHOW}):`);
  let shown = 0;
  for (const t of TABLES)
    for (const r of found[t.key]) {
      if (shown++ >= SHOW) break;
      log(`   ${t.key.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(22)} ${r.raw}`);
    }

  if (!APPLY) { log(""); log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  /* ONE transaction, and the count comes from RETURNING — not from the command
     tag. "APPLIED, stamped N" computed from a loop counter is how the colour
     sweep reported three successful runs while corrupting the column
     (BUG-HISTORY.md, #1938). */
  const returned = {};
  await sql.begin(async (tx) => {
    for (const t of TABLES) {
      const ids = found[t.key].map((r) => r.id);
      if (!ids.length) { returned[t.key] = 0; continue; }
      const rows = await tx.unsafe(
        `UPDATE scm.${t.table} SET custom_specials = NULL
          WHERE id = ANY($1::uuid[]) AND jsonb_typeof(custom_specials) = 'string'
        RETURNING id`, [ids]);
      returned[t.key] = rows.length;
      if (rows.length !== ids.length)
        throw new Error(`${t.key}: RETURNING gave ${rows.length} rows, expected ${ids.length} — rolling back`);
    }
  });
  log("");
  log(`transaction committed — RETURNING rows: SO ${returned.so}, PO ${returned.po}`);

  /* Read back on a SEPARATE connection. The session that just wrote is the
     worst available witness for whether the commit is visible. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let left = 0;
  try {
    for (const t of TABLES) {
      const still = await damaged(v, t);
      left += still.length;
      log(`READ-BACK on a NEW connection — ${t.key}: ${still.length} double-encoded rows remain`);
      const c = await census(v, t);
      log(`   post-repair shape census: ${c.map((r) => `${r.shape}=${r.n}`).join(" ") || "(all null)"}`);
    }
  } finally { await v.end(); }

  if (left) {
    log("");
    log(`NOT FULLY REPAIRED — ${left} rows still hold a double-encoded value.`);
    await sql.end();
    process.exit(1);
  }
  log("");
  log(`REPAIRED — ${returned.so + returned.po} rows set to NULL, PROVEN by read-back. ` +
      `Recompute regenerates custom_specials from variants.specials on the next edit.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
