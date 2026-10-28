#!/usr/bin/env node
// Census — and, only where the reasoning holds, repair — of the ARRAY-shaped
// `custom_specials` values that #1944 left behind.
//
// WHAT #1944 DID AND DID NOT DO. It set to NULL the values that
// backfill-sofa-special-orders.mjs had DOUBLE-ENCODED into jsonb STRING
// scalars (docs/jsonb-double-encoding-coe.md). What it deliberately did not
// touch is every row whose `custom_specials` is a jsonb ARRAY — and
// `jsonb_typeof` cannot tell a correct `Array<{description, surchargeSen}>`
// from a bare `string[]` of verbatim slip phrases. Both read as 'array'.
// Nobody has looked. This script looks.
//
// WHAT THE FIRST PROD RUN FOUND (31428435434, 2026-08-11), and why this script
// no longer offers to NULL most of what it finds. All 604 array-shaped rows
// (SO 511, PO 93) are bare `string[]`; none is the declared object shape and
// none is empty. But 679 of their 694 strings are LIVE picker codes, every row
// is a migrated line, and every row's `variants.specials` holds exactly as many
// entries as its `custom_specials` — the derived cache AGREES with its source.
// So the leg #1944's repair stood on — "valid jsonb holding WRONG DATA is worse
// than empty because it looks repaired" — does not carry here: the data is
// right, only the shape is legacy, and the one consumer that renders it
// (SalesOrderDetailListing.formatSpecials, mirrored by check-specials-and-ocr's
// elText) handles a plain string and an object alike. NULLing those rows would
// delete a correct, currently-rendering line item from 604 historical documents
// until someone edited each one. That is a regression, not a repair.
//
// THE FIVE CLASSES, decided per ROW from the elements themselves:
//   correct  every element is an OBJECT carrying `description` and a NUMERIC
//            `surchargeSen` — the shape mfg-pricing-recompute.ts:117 declares.
//            This is what the recompute emits, so these rows are the pricing
//            engine's own output and are none of our business.
//   empty    `[]`. Honest: no specials. Not damage, not repaired.
//   codes[]  every element is a STRING and every one of them is a LIVE
//            scm.special_addons code. Legacy SHAPE, correct CONTENT. NOT a
//            repair candidate — see above.
//   text[]   every element is a STRING and at least one is NOT a live code
//            (raw slip text: BOTHWANT, FABRICHARRING, LSIDE, DAYBED, ...).
//            Wrong content — but the SAME text sits in `variants.specials`,
//            which is the field the picker actually reads, so NULLing only the
//            derived cache hides it from the report while leaving it in the
//            operator's view. Reported for an OWNER decision; APPLY refuses it
//            unless APPLY_TEXT=1 says the owner has made that call.
//   other    anything else — mixed elements, objects missing a key, a
//            surchargeSen that is not a number. Described element by element in
//            the report; never repaired blind.
//
// EVIDENCE THE REPORT CARRIES, so the verdict is not taken on faith:
//   - is each string a LIVE scm.special_addons code, or a raw slip phrase?
//     (a picker code would make the value merely misplaced; a phrase makes it
//     unpickable data that only looks repaired)
//   - is the line MIGRATED (linked_ac_docno IS NOT NULL — the marker #1946
//     settled), i.e. is it in the population the old backfill wrote to?
//   - does the line already carry picker codes in variants.specials, which is
//     the field the picker actually reads (SpecialOrders.tsx:91)? If it does,
//     NULLing the derived cache loses nothing at all.
//   - for `correct` rows, how many carry a NON-ZERO surchargeSen — those are
//     money-bearing and must never be touched by a data script.
//
// WHAT IS NEVER ON THE TABLE, WHATEVER THE CLASS. Writing the "correct" derived
// value would mean computing `surchargeSen` OUTSIDE the pricing engine and
// stamping it on historical documents. That is the repricing the owner ruled out
// on 2026-08-11, so no class is ever "upgraded" from string[] to the object
// shape here. The only edit this script can make is to NULL — which is exactly
// the state of a line that has not been recomputed yet, since the recompute
// reads variants.specials (mfg-pricing-recompute.ts:283) and re-emits
// custom_specials from it (:604), and the SO line PATCH overwrites it wholesale
// (mfg-sales-orders.ts:8234).
//
// NOTHING IS LOST (owner: 不可以删只可以 cancel). Every candidate row's current
// value is PRINTED IN FULL before any write, so the prior state survives in the
// run log; description2 — the source text it was all derived from — is
// untouched; and variants.specials carries the codes.
//
// DRY-RUN by default. APPLY=1 repairs ONLY the `string[]` class, and only when
// the run's own evidence still supports it.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
/* A second, separate switch. APPLY alone can no longer null anything, because
   the only rows with wrong CONTENT also carry that same text in
   variants.specials — nulling the derived cache would hide it from the report
   and leave it in the picker. That is an owner decision, and this is where the
   owner's answer is recorded. */
const APPLY_TEXT = process.env.APPLY_TEXT === "1";
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 800);
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

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const CLASSES = ["correct", "empty", "codes[]", "text[]", "other", "not-an-array"];

/** Decide the class of one array value, and describe it when it is `other`. */
function classify(arr, liveCodes = new Set()) {
  if (!Array.isArray(arr)) return { klass: "not-an-array", why: `jsonb_typeof said array but the driver gave ${typeof arr}` };
  if (arr.length === 0) return { klass: "empty", why: "" };

  const allStrings = arr.every((e) => typeof e === "string");
  if (allStrings) {
    const strays = arr.filter((s) => !liveCodes.has(String(s).trim().toUpperCase()));
    return strays.length
      ? { klass: "text[]", why: `not a live picker code: ${strays.map((s) => JSON.stringify(s)).join(", ")}` }
      : { klass: "codes[]", why: "" };
  }

  const allObjects = arr.every(isObj);
  if (allObjects) {
    const bad = [];
    for (const [i, e] of arr.entries()) {
      const keys = Object.keys(e);
      if (!("description" in e)) bad.push(`[${i}] no description (keys: ${keys.join("|") || "none"})`);
      else if (typeof e.description !== "string") bad.push(`[${i}] description is ${typeof e.description}`);
      if (!("surchargeSen" in e)) bad.push(`[${i}] no surchargeSen (keys: ${keys.join("|") || "none"})`);
      else if (typeof e.surchargeSen !== "number") bad.push(`[${i}] surchargeSen is ${typeof e.surchargeSen}`);
    }
    if (!bad.length) return { klass: "correct", why: "" };
    return { klass: "other", why: `objects, but ${bad.join("; ")}` };
  }

  const kinds = arr.map((e) => (e === null ? "null" : Array.isArray(e) ? "array" : typeof e));
  return { klass: "other", why: `mixed element types: ${[...new Set(kinds)].join("+")} (${kinds.join(",")})` };
}

async function rowsOf(db, t) {
  return db.unsafe(
    `SELECT i.id::text AS id,
            ${t.doc} AS doc,
            ${t.code} AS code,
            i.custom_specials AS cs,
            i.custom_specials #>> '{}' AS raw,
            (h.linked_ac_docno IS NOT NULL) AS migrated,
            i.variants -> 'specials' AS vspec,
            CASE WHEN jsonb_typeof(i.variants -> 'specials') = 'array'
                 THEN jsonb_array_length(i.variants -> 'specials') ELSE -1 END AS variant_specials_n
       FROM scm.${t.table} i ${t.join}
      WHERE h.company_id = $1 AND jsonb_typeof(i.custom_specials) = 'array'
      ORDER BY 2, 3`, [CO]);
}

async function shapeCensus(db, t) {
  return db.unsafe(
    `SELECT jsonb_typeof(i.custom_specials) AS shape, COUNT(*)::int AS n
       FROM scm.${t.table} i ${t.join}
      WHERE h.company_id = $1 AND i.custom_specials IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`, [CO]);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  // the live picker master, so a string can be tested against a REAL code
  const addons = await sql`SELECT code, label FROM scm.special_addons WHERE company_id = ${CO}`;
  const liveCodes = new Set();
  for (const r of addons) {
    liveCodes.add(String(r.code).trim().toUpperCase());
    if (r.label) liveCodes.add(String(r.label).trim().toUpperCase());
  }
  log(`live scm.special_addons codes/labels: ${liveCodes.size}`);

  const found = {};
  for (const t of TABLES) {
    const shapes = await shapeCensus(sql, t);
    log("");
    log(`scm.${t.table}.custom_specials shape census (non-null rows): ${shapes.map((r) => `${r.shape}=${r.n}`).join(" ") || "(none)"}`);

    const rows = await rowsOf(sql, t);
    const byClass = new Map();
    for (const r of rows) {
      const { klass, why } = classify(r.cs, liveCodes);
      r._class = klass; r._why = why;
      if (!byClass.has(klass)) byClass.set(klass, []);
      byClass.get(klass).push(r);
    }
    found[t.key] = { rows, byClass };

    log(`   array-shaped rows: ${rows.length}`);
    for (const klass of CLASSES) {
      const g = byClass.get(klass);
      if (!g) continue;
      const migrated = g.filter((r) => r.migrated).length;
      const withVariantCodes = g.filter((r) => r.variant_specials_n > 0).length;
      log(`      ${String(g.length).padStart(5)}  ${klass.padEnd(12)}  migrated ${migrated}  already carrying variants.specials ${withVariantCodes}`);
    }

    // money check on the class we will NEVER touch
    const correct = byClass.get("correct") || [];
    const priced = correct.filter((r) => (r.cs || []).some((e) => Number(e.surchargeSen) !== 0));
    log(`      of the 'correct' rows, ${priced.length} carry a NON-ZERO surchargeSen (money-bearing, never touched here)`);

    const strs = [...(byClass.get("codes[]") || []), ...(byClass.get("text[]") || [])];
    const allStrings = strs.flatMap((r) => r.cs);
    const known = allStrings.filter((s) => liveCodes.has(String(s).trim().toUpperCase()));
    log(`      of the ${allStrings.length} strings in the bare-string rows, ${known.length} are a LIVE picker code and ${allStrings.length - known.length} are raw slip text`);
  }

  // ── samples, so the classification is checkable and not just counted ──────
  for (const klass of CLASSES) {
    const all = TABLES.flatMap((t) => (found[t.key].byClass.get(klass) || []).map((r) => [t.key, r]));
    if (!all.length) continue;
    const n = klass === "text[]" || klass === "other" ? SHOW : 12;
    log("");
    log(`SAMPLE — ${klass} (${all.length} rows across SO+PO, showing ${Math.min(all.length, n)}):`);
    for (const [key, r] of all.slice(0, n))
      log(`   ${key.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(24)}` +
          ` mig=${r.migrated ? "Y" : "n"}  custom_specials=${r.raw}` +
          `  variants.specials=${JSON.stringify(r.vspec ?? null)}` +
          (r._why ? `   << ${r._why}` : ""));
  }

  /* THE VERDICT, recomputed from THIS run rather than quoted from the last one.
     `codes[]` is legacy shape with correct content and is never a candidate;
     `text[]` is the only wrong-content class, and even that is held behind its
     own switch because the same text sits in variants.specials. */
  const codesRows = TABLES.flatMap((t) => (found[t.key].byClass.get("codes[]") || []));
  const textRows = TABLES.map((t) => [t, found[t.key].byClass.get("text[]") || []]);
  const textTotal = textRows.reduce((a, [, g]) => a + g.length, 0);
  const textAlsoInVariants = textRows.flatMap(([, g]) => g).filter((r) => {
    const v = Array.isArray(r.vspec) ? r.vspec.map((x) => String(x)) : [];
    return (r.cs || []).some((s) => !liveCodes.has(String(s).trim().toUpperCase()) && v.includes(String(s)));
  }).length;

  log("");
  log(`NOT a repair candidate — codes[]: ${codesRows.length} rows. Legacy SHAPE, correct CONTENT: every string is a`);
  log(`   live picker code, and the renderer (SalesOrderDetailListing.formatSpecials) handles a plain string`);
  log(`   and an object alike. NULLing them would delete a correct, currently-rendering line item.`);
  log(`NOT a repair candidate — 'correct' (the pricing engine's own output), 'empty' (honest), 'other' (needs a human read).`);
  log(`ONLY wrong-content class — text[]: ${textTotal} rows; of those, ${textAlsoInVariants} carry the SAME raw text in`);
  log(`   variants.specials, the field the PICKER reads. For those, NULLing custom_specials hides the junk from`);
  log(`   the report and leaves it in the operator's view — a half-fix. That is an OWNER decision.`);

  const candidates = textRows;
  const total = textTotal;
  if (!total) { log(""); log("nothing this script is willing to repair."); await sql.end(); return; }
  if (!APPLY) { log(""); log("DRY-RUN — APPLY=1 alone does nothing here; the text[] rows also need APPLY_TEXT=1 (owner decision)."); await sql.end(); return; }
  if (!APPLY_TEXT) {
    log("");
    log(`REFUSING TO WRITE. APPLY=1 was given but APPLY_TEXT=1 was not, and the only class this script would`);
    log(`   touch is text[]. Set APPLY_TEXT=1 only once the owner has decided what should happen to the raw`);
    log(`   text in variants.specials as well — nulling the derived cache on its own is not a repair.`);
    await sql.end();
    return;
  }

  /* Print every candidate's current value IN FULL before touching it. The
     repair sets NULL, so this log is the only place the old value survives. */
  log("");
  log("PRIOR VALUES, in full, before the write:");
  for (const [t, g] of candidates)
    for (const r of g) log(`   ${t.key.toUpperCase()} ${String(r.doc ?? "").padEnd(14)} ${String(r.code ?? "").padEnd(24)} ${r.raw}`);

  /* ONE transaction; the count comes from RETURNING, never from a command tag.
     The WHERE re-tests the shape so a row that changed between the read and the
     write is left alone and shows as a shortfall, which rolls the whole thing
     back rather than half-applying. */
  const returned = {};
  await sql.begin(async (tx) => {
    for (const [t, g] of candidates) {
      const ids = g.map((r) => r.id);
      if (!ids.length) { returned[t.key] = 0; continue; }
      const rows = await tx.unsafe(
        `UPDATE scm.${t.table} SET custom_specials = NULL
          WHERE id = ANY($1::uuid[]) AND jsonb_typeof(custom_specials) = 'array'
        RETURNING id`, [ids]);
      returned[t.key] = rows.length;
      if (rows.length !== ids.length)
        throw new Error(`${t.key}: RETURNING gave ${rows.length} rows, expected ${ids.length} — rolling back`);
    }
  });
  log("");
  log(`transaction committed — RETURNING rows: SO ${returned.so ?? 0}, PO ${returned.po ?? 0}`);

  /* Read back on a SEPARATE connection. The session that just wrote is the
     worst available witness for whether the commit is visible. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let left = 0;
  try {
    for (const t of TABLES) {
      const after = await rowsOf(v, t);
      const still = after.filter((r) => classify(r.cs, liveCodes).klass === "text[]").length;
      left += still;
      log(`READ-BACK on a NEW connection — ${t.key}: ${still} text[] rows remain; array-shaped total now ${after.length}`);
      const shapes = await shapeCensus(v, t);
      log(`   post-repair shape census: ${shapes.map((r) => `${r.shape}=${r.n}`).join(" ") || "(all null)"}`);
    }
  } finally { await v.end(); }

  if (left) {
    log("");
    log(`NOT FULLY REPAIRED — ${left} rows still hold a bare string[].`);
    await sql.end();
    process.exit(1);
  }
  log("");
  log(`REPAIRED — ${(returned.so ?? 0) + (returned.po ?? 0)} rows set to NULL, PROVEN by read-back. ` +
      `Recompute regenerates custom_specials from variants.specials on the next edit.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
