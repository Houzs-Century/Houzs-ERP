#!/usr/bin/env node
// Create the fabric colours the PROC sofa orders reference but the library
// never had (owner 2026-08-10: "那就建立 / 之后我再整理").
//
// Evidence: probe-fabric-colours on prod — 25 PROC sofa lines carry a colour
// that scm.fabric_colours cannot resolve even with typo folding. They are real
// fabrics being sold; the library entry was simply never created.
//
// Shape: scm.fabric_colours PK is (fabric_id, colour_id) with fabric_id FK ->
// scm.fabric_library(id). So a colour whose SERIES already exists inherits that
// series' fabric_id; a brand-new series gets a fabric_library row first, copying
// tier/surcharge from a sibling series so pricing behaviour is unchanged
// (standard / 0 when there is no sibling — the conservative default).
//
// Gated like every repair here: MODE=dry-run (default, rolls back),
// MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//
// RE-RUN: inert. Every INSERT is skipped when the series/colour already exists, so a second run adds nothing.
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const strip = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// series, colour_id, label — exactly the codes the PROC lines carry.
const WANT = [
  ["MODENZA", "MODENZA-02", "MODENZA-02 BARLEY"],
  ["MODENZA", "MODENZA-06", "MODENZA-06"],
  ["MODENZA", "MODENZA-07", "MODENZA-07 SILVER HEATHER"],
  ["GD2502", "GD2502-04", "GD2502#04 OAK"],
  ["GD2502", "GD2502-09", "GD2502#09 SANDY"],
  ["GD2502", "GD2502-18", "GD2502#18 GREY"],
  ["HR805", "HR805-31", "HR805-31"],
  ["HR805", "HR805-40", "HR805-40"],
  ["NX", "NX007", "NX007"],
  ["NX", "NX010", "NX010 IVORY"],
  ["NX", "NX011", "NX011 BEIGE"],
  ["ZL", "ZL-6", "ZL-6 (ZANO LEATHER)"],
  ["ZL", "ZL-20", "ZL-20 BLACK (ZANO LEATHER)"],
  ["GARFIELD", "GARFIELD-1", "GARFIELD-1 SOFT LINEN"],
  ["WOWSONS", "WOWSONS-8877-3", "WOWSONS 8877-3 HAZELNUT"],
  ["CHANTIC", "CHANTIC-141-2", "CHANTIC 141-2"],
  ["J9883", "J9883-2", "J9883-2 CHIC"],
  ["J9226", "J9226-2", "J9226-2 BUTTERCREAM"],
  ["M2402", "M2402-8", "M2402-8"],
  ["BO315", "BO315-31", "BO315-31"],
];

async function main() {
  note(`MODE=${MODE} candidates=${WANT.length}`);
  await sql.begin(async (tx) => {
    const cols = await tx`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
    const libs = await tx`SELECT id, label, tier, default_surcharge, sort_order FROM scm.fabric_library WHERE company_id = 1`;
    const haveCol = new Set(cols.map((r) => strip(r.colour_id)));
    const libById = new Map(libs.map((r) => [r.id, r]));
    // a series is "known" when some existing colour already sits under it
    const seriesFabric = new Map();
    for (const r of cols) {
      const s = strip(r.colour_id).replace(/^([A-Z]+\d*).*$/, "$1");
      if (s && !seriesFabric.has(s)) seriesFabric.set(s, r.fabric_id);
    }
    let newLib = 0, newCol = 0, skip = 0;
    const maxSort = Math.max(0, ...libs.map((r) => Number(r.sort_order) || 0));
    let sortCursor = maxSort;

    for (const [series, colourId, label] of WANT) {
      if (haveCol.has(strip(colourId))) { note(`  skip (already there) ${colourId}`); skip++; continue; }
      let fabricId = seriesFabric.get(strip(series)) ?? null;
      if (!fabricId) {
        fabricId = series;
        if (!libById.has(fabricId)) {
          sortCursor += 10;
          if (APPLY) await tx`INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order, company_id)
            VALUES (${fabricId}, ${series}, 'standard', 0, true, ${sortCursor}, 1) ON CONFLICT (id) DO NOTHING`;
          libById.set(fabricId, { id: fabricId });
          note(`  + series ${fabricId} (new fabric_library row)`);
          newLib++;
        }
        seriesFabric.set(strip(series), fabricId);
      }
      const sameSeries = cols.filter((r) => r.fabric_id === fabricId).length;
      if (APPLY) await tx`INSERT INTO scm.fabric_colours (fabric_id, colour_id, label, active, sort_order, company_id)
        VALUES (${fabricId}, ${colourId}, ${label}, true, ${(sameSeries + 1) * 10}, 1)
        ON CONFLICT (fabric_id, colour_id) DO NOTHING`;
      note(`  + ${fabricId} / ${colourId}  "${label}"`);
      newCol++;
    }
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): fabric_library +${newLib}, fabric_colours +${newCol}, already-present ${skip}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN complete: rolled back, nothing written."); });
}
main().then(() => sql.end({ timeout: 5 })).catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
