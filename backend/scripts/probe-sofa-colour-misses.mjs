#!/usr/bin/env node
/* READ-ONLY. Name the migrated SOFA lines that `refresh-sofa-colours.mjs` could
   not stamp, per DOCUMENT, so a human can act on them.

   The refresh script's own report aggregates by colour string - which is the
   right shape for judging the MATCHER, and the wrong shape for judging the
   ORDERS. "10x Modenza-Houston Cream" tells you the library is missing a
   colour; it does not tell you which customer's sofa is sitting there with no
   fabric bound. This probe prints the same misses keyed by doc_no + model.

   It re-uses the exact reads, the exact decode and the exact matcher the
   refresh script uses, so the two agree by construction rather than by a
   second hand-copied regex - that duplication is what PR #1893 removed.

   Writes nothing. No APPLY switch exists on purpose. */
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
// PENDING=1 also lists the TBC/KIV lines (a real order state, not a defect)
const SHOW_PENDING = process.env.PENDING === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const txt = (v) => (typeof v === "string" ? v.trim() : "");
const isBound = (v) => !!(txt(v?.fabricId) || txt(v?.colourId) || txt(v?.fabricCode));

async function main() {
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  /* The unlabelled-colour rule inside parseSofa is gated on this callback and
     does NOTHING without it - "MODENZA-05 (DARK OLIVE)/35”/1R+1R" writes the
     colour first with no COL: label, and this script, whose whole job is to
     stamp colours, was calling parseSofa without it. Same contract as
     import-ac-outstanding-so.mjs:177. */
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };

  log(`fabric library: ${new Set(fcRows.map((r) => r.fabric_id)).size} series / ${fcRows.length} colours`);

  const soLines = await sql`SELECT h.doc_no, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
    ORDER BY h.doc_no, i.item_code`;
  // scm.purchase_orders numbers its documents `po_number`, not `doc_no` -
  // only scm.mfg_sales_orders carries doc_no (and joins on it).
  const poLines = await sql`SELECT h.po_number AS doc_no, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
    ORDER BY h.po_number, i.item_code`;
  log(`migrated sofa lines: SO ${soLines.length}, PO ${poLines.length}`);

  const miss = [], pend = [];
  for (const [which, rows] of [["SO", soLines], ["PO", poLines]]) {
    for (const r of rows) {
      if (isBound(r.variants)) continue;
      let model = String(r.code || "").split("-")[0].toUpperCase();
      model = SOFA_MODEL_ALIAS[model] || model;
      const ps = r.d2 ? parseSofa(r.d2, model, false, { knownColour }) : null;
      const raw = txt(ps?.color) || txt(r.variants?.colourLabel);
      if (!raw) continue;                              // no colour written at all
      if (isPendingColour(raw)) { pend.push({ which, ...r, model, raw }); continue; }
      if (findColour(raw)) continue;                   // resolves - the sweep stamps it
      miss.push({ which, ...r, model, raw });
    }
  }

  log("");
  log(`UNRESOLVED sofa lines (${miss.length}) - doc / model / colour text in Desc2:`);
  for (const m of miss) log(`   ${m.which} ${m.doc_no}  ${m.model.padEnd(14)}  code=${m.code}  colour="${m.raw}"`);

  if (SHOW_PENDING) {
    log("");
    log(`TBC / KIV sofa lines (${pend.length}) - customer has not chosen yet:`);
    for (const m of pend) log(`   ${m.which} ${m.doc_no}  ${m.model.padEnd(14)}  code=${m.code}  colour="${m.raw}"`);
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
