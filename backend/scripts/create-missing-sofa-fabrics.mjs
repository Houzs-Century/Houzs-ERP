#!/usr/bin/env node
/* Create the fabric colours the migrated sofa and bedframe lines reference and
   the library genuinely does not hold - and ONLY those.

   This is the second half of the shared-matcher work. First the matcher stopped
   losing colours the library already had (scripts/lib/fabric-colour-match.mjs);
   what is left over after that is the real gap. The candidate list below is
   what survived a live prod scan on 2026-08-10 -
   `probe-fabric-colours.yml` with target=prod, dump=scan - which re-ran the
   shared matcher over every company-1 sofa/bedframe line that carries no bound
   fabric and printed, per colour string, BINDS or MISSING.

   THE LIST IS NOT TRUSTED ON ITS OWN. Every candidate carries the document
   string it came from, and this script re-runs the shared matcher against the
   LIVE library before creating anything: a candidate the matcher now resolves
   is skipped and says what it resolved to. So the script cannot re-create a
   colour that a later matcher improvement (or a manual insert) has since made
   reachable - which is exactly how a curated list rots.

   WHAT IS DELIBERATELY NOT HERE, because the library already holds it and the
   gap is naming or data entry, not a missing fabric:
     - "Modenza-Houston Cream" (10 lines) - MODENZA-01 IS Houston Cream; the
       owner's own "Modenza 01 Houston Cream" lines bind to it. Put the name in
       MODENZA-01's label and these bind for free. Owner decision, not a create.
     - "Harring 02# beige" (3) - HIRRING GD8371-02# BEIGE exists; the document
       names the brand and omits the code. Same shape of fix.
     - "03#Straw" (4) - ambiguous between HIRRING GD8371-03# STRAW and HIVE
       GD2034-03# STRAW. Creating either would be a guess.
     - "9226-13" (2) - ARMANI J9226-13 WARM GREY exists; the document drops the J.
     - "J9833-2" (1) - J9883-2 with two digits swapped. Digits are identity.
     - "PC151-", "PC 151-", "PC-151", "PC", "P151-", "OPC151-", "NB-", "HD",
       "random", "ZanoLeather" (70+ lines) - AutoCount itself carries no colour
       number on these. There is nothing to create; a human must complete them.

   Shape: scm.fabric_colours PK is (fabric_id, colour_id) with fabric_id FK ->
   scm.fabric_library(id). A colour whose SERIES already exists inherits that
   series' fabric_id; a brand-new series gets a fabric_library row first with
   tier 'standard' / surcharge 0 - the conservative default, pricing unchanged.

   Gated like every repair here: MODE=dry-run (default, rolls back),
   MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { buildFabricColourIndex, stripColour } from "./lib/fabric-colour-match.mjs";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* series, colour_id, label, [the document strings that ask for it], live line
   count. The document strings are what the matcher is re-probed with. */
const WANT = [
  // --- the series EXISTS, this colour of it does not ---
  ["HR805", "HR805-30", "HR805-30", ["HR805-30"], 5],
  ["HR805", "HR805-20", "HR805-20", ["HR 805-20", "HR805-20"], 1],
  ["HR805", "HR805-09", "HR805-09", ["HR 805-9", "HR805-9"], 1],
  ["GD2502", "GD2502-14", "GD2502#14 SILVER", ["GD2502#14", "GD2502 # 14 silver"], 3],
  ["MODENZA", "MODENZA-04", "MODENZA-04 MUSTARD", ["MODENZA 04-MUSTARD", "modenza 04: mustard"], 3],
  ["BO315", "BO315-27", "BO315-27", ["B0315-27", "BO315-27"], 2],
  ["J9883", "J9883-1-1", "J9883-1-1 PAMA", ["J9883-1-1 PAMA"], 1],
  ["ORION", "ORION-4", "ORION-4", ["ORION 4"], 1],
  ["ZL", "ZL-11", "ZL-11 (ZANO LEATHER)", ["ZL-11"], 1],
  // NX stores its colours unhyphenated (NX007 / NX010 / NX011); follow that.
  ["NX", "NX003", "NX003 HONEY", ["NX003 (HONEY)"], 0],
  ["NX", "NX005", "NX005 AVOCADO", ["NX005 (AVOCADO)"], 0],
  /* NINJA is modelled one series per colour in this library ("NINJA 01" ..
     "NINJA 08", each holding a single colour of the same name); 06 is the hole
     in that run. Follow the shape that is there rather than inventing a
     hyphenated NINJA-06 nobody else uses. */
  ["NINJA 06", "NINJA 06", "NINJA 06", ["Ninja 06"], 1],
  // --- no such SERIES in the library at all ---
  ["CHINO", "CHINO-12", "CHINO-12", ["CHINO -12"], 1],
  ["NICCA", "NICCA-06", "NICCA-06 FOG", ["Nicca 06-Fog"], 2],
  ["PHOENIX", "PHOENIX-1", "PHOENIX-1 OYSTER", ["Phoenix-oyster1"], 2],
  ["MB", "MB-04", "MB-04", ["MB-04"], 1],
  /* HM3383 is its own series here. HN3382-6 exists and is one letter and one
     digit away, but a digit is identity (see fabric-colour-match.mjs), so this
     is created as written rather than folded onto HN3382. If the owner says
     they are the same fabric, delete this row and relabel HN3382 instead. */
  ["HM3383", "HM3383-6", "HM3383-6", ["HM 3383-6", "HM3383-6"], 3],
  ["SL", "SL0095", "SL0095", ["SL0095"], 0],
];

async function main() {
  note(`MODE=${MODE} candidates=${WANT.length}`);
  await sql.begin(async (tx) => {
    const cols = await tx`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
    const libs = await tx`SELECT id, label, tier, default_surcharge, sort_order FROM scm.fabric_library WHERE company_id = 1`;
    note(`live library: ${libs.length} series / ${cols.length} colours`);
    const { findColour } = buildFabricColourIndex(cols);
    const haveCol = new Set(cols.map((r) => stripColour(r.colour_id)));
    const libById = new Map(libs.map((r) => [r.id, r]));
    // a series is "known" when some existing colour already sits under it
    const seriesFabric = new Map();
    for (const r of cols) {
      const s = stripColour(r.colour_id).replace(/^([A-Z]+\d*).*$/, "$1");
      if (s && !seriesFabric.has(s)) seriesFabric.set(s, r.fabric_id);
    }
    let newLib = 0, newCol = 0, skipPresent = 0, skipResolved = 0;
    let sortCursor = Math.max(0, ...libs.map((r) => Number(r.sort_order) || 0));

    for (const [series, colourId, label, docStrings, lines] of WANT) {
      // (1) the matcher decides first. If a document string that motivated this
      // candidate now resolves, the library already answers it - do not create.
      const resolved = (docStrings || []).map((d) => [d, findColour(d)]).find(([, h]) => h);
      if (resolved) {
        note(`  skip (the matcher resolves it) ${colourId}: "${resolved[0]}" -> ${resolved[1].fabric_id} / ${resolved[1].colour_id}`);
        skipResolved++;
        continue;
      }
      // (2) and the exact colour_id must still be absent
      if (haveCol.has(stripColour(colourId))) { note(`  skip (already there) ${colourId}`); skipPresent++; continue; }

      let fabricId = libById.has(series) ? series : (seriesFabric.get(stripColour(series)) ?? null);
      if (!fabricId) {
        fabricId = series;
        sortCursor += 10;
        if (APPLY) await tx`INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order, company_id)
          VALUES (${fabricId}, ${series}, 'standard', 0, true, ${sortCursor}, 1) ON CONFLICT (id) DO NOTHING`;
        libById.set(fabricId, { id: fabricId });
        seriesFabric.set(stripColour(series), fabricId);
        note(`  + series ${fabricId} (new fabric_library row, tier standard / surcharge 0)`);
        newLib++;
      }
      const sameSeries = cols.filter((r) => r.fabric_id === fabricId).length + 1;
      if (APPLY) await tx`INSERT INTO scm.fabric_colours (fabric_id, colour_id, label, active, sort_order, company_id)
        VALUES (${fabricId}, ${colourId}, ${label}, true, ${sameSeries * 10}, 1)
        ON CONFLICT (fabric_id, colour_id) DO NOTHING`;
      note(`  + ${fabricId} / ${colourId}  "${label}"   (${lines} live line${lines === 1 ? "" : "s"} ask for it: ${docStrings.join(", ")})`);
      newCol++;
    }
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): fabric_library +${newLib}, fabric_colours +${newCol}; skipped ${skipPresent} already present, ${skipResolved} the matcher now resolves`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN complete: rolled back, nothing written."); });
}
main().then(() => sql.end({ timeout: 5 })).catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
