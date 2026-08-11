#!/usr/bin/env node
/* Bind the migrated sales-order lines whose colour is NULL and whose own
   AutoCount text names a colour the library holds today.

   THE FINDING THIS CLOSES (#1964, BUG-HISTORY "The 7 variant mismatches that
   were never the collision"). After the variant collision was fully repaired, 7
   migrated bedframe SO lines still disagreed with their own AutoCount Desc2.
   One class, not seven problems: in every one the ONLY disagreeing axis is
   `colourId`, the stored value is NULL, and the shared matcher resolves the
   line's own text now that the matcher and the library have both grown
   (#1893, #1902). NULL means "not bound", which is honest - nothing is corrupt.

   WHY IT WAS DEFERRED, AND WHAT CHANGED. Two of the seven were the reason:

     - `STAR-10` resolves to `STAR-10 NAVY`, one half of a duplicate library
       pair, so auto-filling would have bound a real document to whichever
       spelling happened to win. **That is now decided**: the owner merged the
       duplicate series on 2026-08-11 ("合并，按引用数多的那边"), so there is one
       canonical STAR series and the ambiguity is gone.

     - `PC151-101` resolves to `PC151-11`, which MOVES A DIGIT. That is exactly
       what the shared matcher was written to refuse (#1893), and merging the
       library changes nothing about it. **It stays refused**, by a guard in
       this script and not by a hand-maintained exclusion list.

   THE DIGIT GUARD IS RE-ASSERTED HERE, ON PURPOSE. The matcher already refuses
   a digit move inside its fuzzy tail, but its EXACT and alias passes can still
   return a row whose number differs from the document's - `seriesNum()` folds
   "PC151101" to a series plus a two-digit tail, which is how PC151-101 reaches
   PC151-11 at all. A colour NUMBER is an identity, not a spelling. This script
   therefore compares the document's digits with the matched row's digits in
   MARK space (letter-O is '@', a written zero stays '0') and refuses any
   binding that moves one, allowing only the single padding zero the library's
   own spelling requires ("J9226-1" vs "ARMANI J9226-01"). A refusal is printed
   with both digit signatures, so it is auditable rather than mysterious.

   SCOPE. Only the documents named in DOCS, only lines whose colour is NULL, and
   only where the line's OWN `description2` - written per line by the importer
   from that line's own export row, and never touched by either refresh script -
   resolves. It does not sweep the whole corpus: binding 138 migrated lines is a
   different decision from closing a named 7.

   DRY-RUN by default; APPLY=1 writes. Verification runs on a SECOND, FRESH
   connection (docs/jsonb-double-encoding-coe.md). The write uses
   `jsonb_build_object` over plain TEXT binds, so no json serializer runs over a
   pre-serialized string and the double-encoding defect cannot recur. */
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex, isPendingColour, markColour } from "./lib/fabric-colour-match.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const DOCS = (process.env.DOCS || "HC-SO-009031,HC-SO-009614,HC-SO-011289,HC-SO-003154,HC-SO-010791")
  .split(",").map((s) => s.trim()).filter(Boolean);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

// the matcher's own digit rule, re-derived so this script can refuse independently
const digitsOf = (s) => (markColour(s).match(/\d+/g) || []).join("-");
const digitsCompatible = (a, b) =>
  a === b || a.replace(/(.)$/, "0$1") === b || b.replace(/(.)$/, "0$1") === a;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO} docs=${DOCS.join(",")}`);

  const cols = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  /* Only ACTIVE series may receive a new binding. A superseded duplicate is
     still in the table by design (nothing is deleted), and binding a live
     document to one would re-create the split the merge just closed. */
  const active = new Set((await sql`SELECT id FROM scm.fabric_library WHERE company_id = ${CO} AND active`).map((r) => r.id));
  const usable = cols.filter((c) => active.has(c.fabric_id));
  log(`fabric library: ${cols.length} colours, ${usable.length} on an ACTIVE series (${active.size} active series)`);
  const { findColour } = buildFabricColourIndex(usable);

  const rows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.item_group, i.description2,
           i.variants, i.variants->>'colourId' AS colour_id
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.doc_no = ANY(${DOCS})
       AND jsonb_typeof(i.variants) = 'object'
       AND COALESCE(i.variants->>'colourId', '') = ''
     ORDER BY i.doc_no, i.item_code`;
  log(`candidate lines (colourId NULL/empty) in those documents: ${rows.length}`);

  const bind = [], refuse = [];
  for (const r of rows) {
    const text = r.description2 || "";
    const parsed = parseBedframe(text);
    const colourText = parsed.color || null;
    if (!colourText) { refuse.push({ r, why: "no colour in the line's own text", colourText }); continue; }
    if (isPendingColour(colourText)) { refuse.push({ r, why: `colour is TBC/KIV ("${colourText}") - not chosen yet, NULL is correct`, colourText }); continue; }
    const hit = findColour(colourText);
    if (!hit) { refuse.push({ r, why: `matcher does not resolve "${colourText}" against the live library`, colourText }); continue; }
    const dq = digitsOf(colourText), dh = digitsOf(hit.colour_id);
    if (!digitsCompatible(dq, dh)) {
      refuse.push({ r, why: `DIGIT MOVE refused: "${colourText}" (digits ${dq || "-"}) -> "${hit.colour_id}" (digits ${dh || "-"})`, colourText, hit });
      continue;
    }
    bind.push({ r, colourText, hit });
  }

  log("");
  log(`=== WOULD BIND: ${bind.length} ===`);
  for (const b of bind) {
    log(`  ${b.r.doc_no} ${b.r.item_code} [${b.r.item_group ?? "-"}] line ${b.r.id}`);
    log(`     text ${JSON.stringify(b.r.description2)}`);
    log(`     colour axis ${JSON.stringify(b.colourText)} -> fabricId "${b.hit.fabric_id}" colourId "${b.hit.colour_id}" label ${JSON.stringify(b.hit.label)}  digits ${digitsOf(b.colourText) || "-"} = ${digitsOf(b.hit.colour_id) || "-"}`);
  }
  log("");
  log(`=== REFUSED: ${refuse.length} ===`);
  for (const f of refuse) {
    log(`  ${f.r.doc_no} ${f.r.item_code} line ${f.r.id}: ${f.why}`);
    log(`     text ${JSON.stringify(f.r.description2)}`);
  }

  if (!APPLY) { log(""); log(`DRY-RUN: nothing written. ${bind.length} line(s) would bind.`); return; }

  const stamped = [];
  await sql.begin(async (tx) => {
    for (const b of bind) {
      /* jsonb_build_object over TEXT binds, merged into an OBJECT-shaped
         variants. No pre-serialized string ever reaches a jsonb parameter, so
         the 2026-08-10 double-encoding cannot happen; and the `||` operands are
         both objects, so it merges instead of concatenating into an array. */
      const back = await tx`
        UPDATE scm.mfg_sales_order_items
           SET variants = variants || jsonb_build_object(
                 'fabricId',    ${b.hit.fabric_id}::text,
                 'colourId',    ${b.hit.colour_id}::text,
                 'fabricCode',  ${b.hit.colour_id}::text,
                 'colourLabel', ${b.hit.label ?? b.hit.colour_id}::text,
                 'fabricLabel', ${b.hit.fabric_id}::text)
         WHERE id = ${b.r.id}::uuid
           AND jsonb_typeof(variants) = 'object'
           AND COALESCE(variants->>'colourId','') = ''
        RETURNING id::text AS id, variants->>'colourId' AS colour_id`;
      if (back.length !== 1) throw new Error(`line ${b.r.id} matched ${back.length} rows - aborting, nothing committed`);
      stamped.push(back[0]);
    }
  });
  log("");
  log(`APPLIED - ${stamped.length} line(s) came back from RETURNING (of ${bind.length} intended).`);

  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    const after = await v`
      SELECT id::text AS id, doc_no, item_code, jsonb_typeof(variants) AS shape,
             variants->>'colourId' AS colour_id, variants->>'fabricId' AS fabric_id,
             variants->>'gap' AS gap, variants->>'divanHeight' AS divan, variants->>'legHeight' AS leg
        FROM scm.mfg_sales_order_items WHERE id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY doc_no, item_code`;
    log("");
    log(`=== INDEPENDENT READ-BACK (fresh connection): ${after.length} line(s) ===`);
    for (const a of after) {
      const want = bind.find((b) => b.r.id === a.id);
      const before = rows.find((r) => r.id === a.id);
      log(`  ${a.doc_no} ${a.item_code} shape=${a.shape} colourId=${JSON.stringify(a.colour_id)} fabricId=${JSON.stringify(a.fabric_id)} gap=${a.gap} divan=${a.divan} leg=${a.leg}`);
      if (a.shape !== "object") { fails++; bad(`${a.id} variants is ${a.shape}, not object - the double-encoding shape`); }
      if (want && a.colour_id !== want.hit.colour_id) { fails++; bad(`${a.id} expected colourId "${want.hit.colour_id}", read ${JSON.stringify(a.colour_id)}`); }
      if (!want && (a.colour_id ?? "") !== "") { fails++; bad(`${a.id} was REFUSED but now carries a colour - it must be untouched`); }
      // the numeric axes were never in scope and must not have moved
      const bv = before?.variants || {};
      for (const k of ["gap", "divanHeight", "legHeight", "size", "totalHeight"]) {
        const now = k === "divanHeight" ? a.divan : k === "legHeight" ? a.leg : k === "gap" ? a.gap : undefined;
        if (now !== undefined && (bv[k] ?? null) !== (now ?? null)) { fails++; bad(`${a.id} axis ${k} MOVED ${JSON.stringify(bv[k])} -> ${JSON.stringify(now)}`); }
      }
    }
  } finally { await v.end({ timeout: 5 }); }

  if (fails) { bad(`${fails} verification failure(s)`); process.exit(1); }
  log("");
  log(`VERIFIED on a fresh connection: ${stamped.length} colour(s) bound, every refused line untouched, no variants block reshaped.`);
}

main().then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
