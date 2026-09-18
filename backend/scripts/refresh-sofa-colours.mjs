#!/usr/bin/env node
/* Stamp the fabric colour the AutoCount slip already names onto the migrated
   SOFA lines - the sweep that did not exist.

   WHY THIS SCRIPT EXISTS. `refresh-so-variants.mjs` re-parses and re-stamps the
   migrated BEDFRAME lines (and (SP) sizes); there has never been an equivalent
   for sofa. So every improvement to the colour matcher reached NEW imports only:
   the rows already in production kept whatever the importer bound on the day
   they were created. PR #1893 then replaced five drifted hand-copies of
   `findColour` with one shared matcher and 18 genuinely-missing colours were
   created after it - and none of that could reach a single existing row,
   because nothing sweeps them.

   WHAT IT READS. The line's OWN `description2`, which is the original AutoCount
   Desc2, decoded by the shared sofa decoder (`parse-sofa.mjs`, `o.color`). Not a
   private regex: that extraction has been hand-copied enough times already, and
   the copies are what this whole repair is about. Where the line carries no
   Desc2 at all, the raw text the importer stashed in `variants.colourLabel` is
   the fallback - the unparsed-sofa import path writes the document's colour
   there verbatim with no ids beside it, and that is the same source rule the
   2026-08-10 prod scan (`probe-fabric-colours.yml`, dump=scan) counted.

   WHAT IT WRITES. Exactly the five keys the SO importer writes, with the same
   names and the same values (`import-ac-outstanding-so.mjs`, the sofa arm):

       fabricId    = row.fabric_id      colourId  = row.colour_id
       fabricCode  = row.colour_id      fabricLabel = row.fabric_id
       colourLabel = row.label

   The names are load-bearing, not cosmetic: the Fabrics picker reads
   `fabricCode`, so a value written under a near-miss key is invisible in the UI
   while looking perfectly present in the database. That has already happened
   once on this cutover, to the venue picker.

   WHAT IT WILL NOT DO.
   - It never overwrites a colour somebody already chose. A line holding any of
     fabricId / colourId / fabricCode is left exactly as it is, and the UPDATE
     repeats that condition in SQL so a pick made between the read and the write
     still wins.
   - It MERGES the colour keys into `variants` (jsonb `||`) instead of writing a
     fresh object, so seatHeight, specials, buildKey and everything else a sofa
     line carries survive untouched.
   - TBC / KIV is not a miss. It means the customer has not chosen yet, which is
     a real state of the order; those lines are counted and left blank.

   DRY-RUN by default; APPLY=1 writes.

   RE-RUN: inert. The UPDATE re-asserts that fabricId, colourId and fabricCode are all still empty, so a colour picked by a person is never overwritten. */
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const txt = (v) => (typeof v === "string" ? v.trim() : "");
// a line is already bound when ANY of the id keys is set - the picker writes
// all three together, and a half-written line must still not be re-stamped
const isBound = (v) => !!(txt(v?.fabricId) || txt(v?.colourId) || txt(v?.fabricCode));

/* The 2026-08-10 runs of this script left `variants` as an ARRAY on the rows
   they claimed to stamp: [ the original object, "the patch as a STRING", ... ],
   one appended element per run. Element 0 is the untouched original, so that is
   where a damaged row's real seatHeight / specials / colourLabel still live.
   Read through it - otherwise the colourLabel fallback below silently stops
   finding the colour on exactly the rows this sweep damaged. */
const asObject = (v) => {
  if (Array.isArray(v)) return (v[0] && typeof v[0] === "object" && !Array.isArray(v[0])) ? v[0] : {};
  return (v && typeof v === "object") ? v : {};
};
const isDamaged = (v) => Array.isArray(v) || (v != null && typeof v !== "object");

/* The one SQL expression that reads a row's variants as an OBJECT whatever
   shape it is in now. Used for both the guard and the value, so the statement
   repairs the shape in the same pass that stamps the colour. */
const BASE = `(CASE WHEN jsonb_typeof(variants) = 'array'  THEN COALESCE(variants -> 0, '{}'::jsonb)
                    WHEN jsonb_typeof(variants) = 'object' THEN variants
                    ELSE '{}'::jsonb END)`;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  /* The unlabelled-colour rule inside parseSofa is gated on this callback and
     does NOTHING without it - "MODENZA-05 (DARK OLIVE)/35”/1R+1R" writes the
     colour first with no COL: label, and this script, whose whole job is to
     stamp colours, was calling parseSofa without it. Same contract as
     import-ac-outstanding-so.mjs:177. */
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };

  const series = new Set(fcRows.map((r) => r.fabric_id));
  log(`fabric library: ${series.size} series / ${fcRows.length} colours`);

  const soLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  log(`migrated sofa lines: SO ${soLines.length}, PO ${poLines.length}`);

  const updates = { so: [], po: [] };
  const tally = { bound: 0, none: 0, pending: 0, perPiece: 0, fill: 0, miss: 0, damaged: 0 };
  const bindCounts = new Map();   // "doc string -> series / colour" -> lines
  const missCounts = new Map();   // unresolved doc string -> lines
  const pendCounts = new Map();   // TBC/KIV string -> lines

  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      if (isDamaged(r.variants)) tally.damaged++;
      const had = asObject(r.variants);
      if (isBound(had)) { tally.bound++; continue; }
      /* {model}-{compartment}; the alias table is what the importers apply, so
         the re-decode sees the same model they did. */
      let model = String(r.code || "").split("-")[0].toUpperCase();
      model = SOFA_MODEL_ALIAS[model] || model;
      const ps = r.d2 ? parseSofa(r.d2, model, false, { knownColour }) : null;
      const raw = txt(ps?.color) || txt(had.colourLabel);
      if (!raw) {
        // "colour (2S): X" - which compartment gets which colour is a human
        // reading of the slip, never something to guess from the line alone
        if (ps && Object.keys(ps.perPieceColor || {}).length) tally.perPiece++;
        tally.none++;
        continue;
      }
      if (isPendingColour(raw)) {
        tally.pending++;
        pendCounts.set(raw.toUpperCase(), (pendCounts.get(raw.toUpperCase()) || 0) + 1);
        continue;
      }
      const hit = findColour(raw);
      if (!hit) {
        tally.miss++;
        missCounts.set(raw, (missCounts.get(raw) || 0) + 1);
        continue;
      }
      tally.fill++;
      const k = `${raw}  ->  ${hit.fabric_id} / ${hit.colour_id}`;
      bindCounts.set(k, (bindCounts.get(k) || 0) + 1);
      updates[which].push({
        id: r.id,
        patch: {
          fabricId: hit.fabric_id, colourId: hit.colour_id, fabricCode: hit.colour_id,
          colourLabel: hit.label, fabricLabel: hit.fabric_id,
        },
      });
    }
  }

  // ---- report ---------------------------------------------------------------
  const scanned = soLines.length + poLines.length;
  log("");
  log(`scanned ${scanned} migrated sofa lines`);
  log(`  already set (a colour is bound - left untouched): ${tally.bound}`);
  log(`  variants NOT an object (damaged by this script on 2026-08-10): ${tally.damaged}  <- repaired by the write below`);
  log(`  no colour written on the line:                    ${tally.none}${tally.perPiece ? ` (of which per-piece "colour (2S): X": ${tally.perPiece})` : ""}`);
  log(`  TBC / KIV - not chosen yet, left blank:           ${tally.pending}`);
  log(`  TO FILL:                                          ${tally.fill}  (SO ${updates.so.length}, PO ${updates.po.length})`);
  log(`  STILL UNRESOLVED:                                 ${tally.miss}  (${missCounts.size} distinct strings)`);

  log("");
  log(`bindings (${bindCounts.size} distinct document strings):`);
  for (const [k, n] of [...bindCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    log(`   ${String(n).padStart(4)}  ${k}`);

  if (pendCounts.size) {
    log("");
    log(`TBC / KIV strings (${pendCounts.size} distinct):`);
    for (const [c, n] of [...pendCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
      log(`   ${String(n).padStart(4)}  ${c}`);
  }

  log("");
  log(`STILL UNRESOLVED - the library has nothing for these (${missCounts.size} distinct / ${tally.miss} lines):`);
  for (const [c, n] of [...missCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    log(`   ${String(n).padStart(4)}  ${c}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  /* ---- repair the shape FIRST -----------------------------------------------
     Driven by the shape, not by the fill list. A row this script damaged whose
     colour no longer resolves is still damaged, and a fill-driven sweep would
     walk straight past it. Element 0 is the original object; the trailing
     elements are the double-encoded patches this script appended and have never
     been anything a reader could use. Nothing is removed from the ORDER - this
     restores a column to the value it held before 15:42 today. Rows whose
     element 0 is not an object are left alone and reported, because that is not
     this damage and guessing at it would be a second defect. */
  let repaired = 0;
  for (const table of ["mfg_sales_order_items", "purchase_order_items"]) {
    const odd = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM scm.${table}
        WHERE jsonb_typeof(variants) = 'array' AND jsonb_typeof(variants -> 0) IS DISTINCT FROM 'object'`);
    if (odd[0].n) log(`  !! ${table}: ${odd[0].n} array-shaped rows whose element 0 is not an object - LEFT ALONE for a human`);
    const r = await sql.unsafe(
      `UPDATE scm.${table} SET variants = variants -> 0
        WHERE jsonb_typeof(variants) = 'array' AND jsonb_typeof(variants -> 0) = 'object'
        RETURNING id`);
    repaired += r.length;
    log(`  shape repair: ${table} ${r.length} rows restored to an object`);
  }
  log(`shape repair total: ${repaired} rows`);

  // ---- write ----------------------------------------------------------------
  let wrote = 0, raced = 0;
  for (const [which, table] of [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]]) {
    const list = updates[which];
    for (let i = 0; i < list.length; i += 200) {
      const b = list.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b) {
          /* Merge, never replace - and repeat the "nobody has chosen one" test
             in the UPDATE itself, so a pick made since the read above is not
             overwritten by this sweep.

             BASE also repairs the shape. The 2026-08-10 runs of this script
             turned `variants` into an ARRAY on the rows they claimed to stamp
             (see BUG-HISTORY: object || non-object concatenates in postgres,
             it does not merge), so element 0 is the untouched original object
             and everything after it is the damage. Reading through element 0
             and writing an object back is the repair, in the same statement
             that does the stamping - the rows needing repair are exactly the
             rows needing the colour. */
          const res = await tx.unsafe(
            `UPDATE scm.${table}
                SET variants = ${BASE} || $1::jsonb
              WHERE id = $2
                AND COALESCE(${BASE} ->> 'fabricId', '') = ''
                AND COALESCE(${BASE} ->> 'colourId', '') = ''
                AND COALESCE(${BASE} ->> 'fabricCode', '') = ''
              RETURNING variants ->> 'fabricId' AS f`,
            /* tx.json, NEVER JSON.stringify. postgres.js applies its own
               JSON.stringify to any parameter whose type resolves to json /
               jsonb (types.js serializers 114/3802), and with prepare:false +
               parameters it ALWAYS learns that type from the server before
               binding (connection.js:238 describeFirst). A pre-stringified
               string therefore gets encoded twice and arrives as a jsonb
               STRING. That is what broke this sweep three times. */
            [tx.json(u.patch), u.id]);
          /* Count what came BACK, not the command tag. A command tag counts
             rows the statement touched; it cannot tell you the row now holds
             what you meant. Three runs reported 127/146/146 from the tag with
             nothing to show for it. */
          if (res.length && res[0].f) wrote += res.length; else raced++;
        }
      });
      log(`  ${which} ..${Math.min(i + 200, list.length)}/${list.length}`);
    }
  }
  await sql.end();

  /* ---- the read that decides ------------------------------------------------
     A connection that has just written is the last witness to trust about
     whether the write committed. Re-open and count from scratch. */
  const fresh = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [after] = await fresh`
    WITH lines AS (
      SELECT i.variants FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
      UNION ALL
      SELECT i.variants FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
       WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
    )
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(variants->>'fabricId','') <> '')::int AS bound,
           COUNT(*) FILTER (WHERE jsonb_typeof(variants) IS DISTINCT FROM 'object'
                              AND variants IS NOT NULL)::int AS malformed
      FROM lines`;
  await fresh.end();
  log("");
  log(`APPLIED - stamped ${wrote} sofa lines${raced ? `; ${raced} skipped (a colour was chosen since the scan, or the write did not take)` : ""}.`);
  log(`POST-APPLY READ (fresh connection): ${after.bound} of ${after.total} migrated sofa lines carry a fabricId; ${after.malformed} still hold a non-object variants.`);
  log(`  before this run: ${tally.bound} bound. ${after.bound - tally.bound >= 0 ? "+" : ""}${after.bound - tally.bound}.`);
  if (after.bound <= tally.bound && wrote > 0)
    log("::error::the write reported rows but the re-read did not move - do NOT report this run as applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
