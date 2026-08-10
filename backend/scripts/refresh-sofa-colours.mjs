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

   DRY-RUN by default; APPLY=1 writes. */
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

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const series = new Set(fcRows.map((r) => r.fabric_id));
  log(`fabric library: ${series.size} series / ${fcRows.length} colours`);

  const soLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, i.material_code AS code, i.description2 AS d2, i.variants
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  log(`migrated sofa lines: SO ${soLines.length}, PO ${poLines.length}`);

  const updates = { so: [], po: [] };
  const tally = { bound: 0, none: 0, pending: 0, perPiece: 0, fill: 0, miss: 0 };
  const bindCounts = new Map();   // "doc string -> series / colour" -> lines
  const missCounts = new Map();   // unresolved doc string -> lines
  const pendCounts = new Map();   // TBC/KIV string -> lines

  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      const had = r.variants || {};
      if (isBound(had)) { tally.bound++; continue; }
      /* {model}-{compartment}; the alias table is what the importers apply, so
         the re-decode sees the same model they did. */
      let model = String(r.code || "").split("-")[0].toUpperCase();
      model = SOFA_MODEL_ALIAS[model] || model;
      const ps = r.d2 ? parseSofa(r.d2, model, false) : null;
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
             overwritten by this sweep. */
          const res = await tx.unsafe(
            `UPDATE scm.${table}
                SET variants = COALESCE(variants, '{}'::jsonb) || $1::jsonb
              WHERE id = $2
                AND COALESCE(variants->>'fabricId', '') = ''
                AND COALESCE(variants->>'colourId', '') = ''
                AND COALESCE(variants->>'fabricCode', '') = ''`,
            [JSON.stringify(u.patch), u.id]);
          if (res.count) wrote += res.count; else raced++;
        }
      });
      log(`  ${which} ..${Math.min(i + 200, list.length)}/${list.length}`);
    }
  }
  log(`APPLIED - stamped ${wrote} sofa lines${raced ? `; ${raced} skipped (a colour was chosen since the scan)` : ""}.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
