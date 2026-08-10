#!/usr/bin/env node
// Re-parse the AutoCount Desc2 with the CURRENT parser and UPDATE the already
// imported company-1 bedframe lines in place. No wipe, no re-import: the orders,
// payments and the backfilled processing/delivery dates all stay exactly as they
// are — only the variant fields are recomputed.
//
// Owner 2026-08-09: "为什么要清旧的SO 不能update进去用旧的" — right, an UPDATE is
// safer than wipe+reload, so parser improvements land this way from now on.
//
// Writes: variants (fabricId/colourId/fabricCode/colourLabel/gap/divanHeight/
// legHeight/totalHeight/specials/size), gap_inches, divan_height_inches,
// leg_height_inches, custom_specials (mapped to REAL scm.special_addons codes).
// DRY-RUN by default; APPLY=1 to write.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { mapSpecial } from "./lib/bedframe-special-map.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-po.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  /* AutoCount DtlKey -> the freshly parsed variant block. The LINE's own
     identity, unique across the export; (DocNo | erp_code) is not, and keying
     on it collapsed several rows of one SKU onto the last one's parse. The SO
     arm is where that did the visible damage - see BUG-HISTORY.md - but this
     arm carried the identical defect and is fixed with it, because a defect
     class half-fixed is the one that bites next. */
  const parsed = new Map();
  for (const r of rows) parsed.set(Number(r.DtlKey), parseBedframe(r.Desc2));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const validSpecials = new Set((await sql`SELECT code FROM scm.special_addons WHERE company_id = 1 AND 'BEDFRAME' = ANY(categories)`).map((r) => r.code));

  const items = await sql`SELECT i.id, i.material_code AS item_code, i.variants, i.description2, i.linked_ac_dtlkey, h.linked_ac_docno
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  log(`imported PO bedframe lines: ${items.length}`);

  const updates = []; let gained = 0; let byKey = 0, byOwnText = 0, noSource = 0;
  for (const it of items) {
    /* Fall back to the line's OWN Desc2 when the outstanding-PO export has no
       entry for it. The SO-linked PO import (already-received POs, which that
       export excludes by definition) stores the same AutoCount text on the
       line, so a lookup miss must not mean "leave this bedframe without
       variants" — the owner's rule is that a raised PO always has them. That
       per-line fallback is also why this arm mostly escaped the collision: the
       export holds only ~338 rows, so most lines never reached the bad key. */
    const viaKey = it.linked_ac_dtlkey != null ? parsed.get(Number(it.linked_ac_dtlkey)) : undefined;
    const bf = viaKey ?? (it.description2 ? parseBedframe(it.description2) : null);
    if (!bf) { noSource++; continue; }
    if (viaKey) byKey++; else byOwnText++;
    const pending = isPendingColour(bf.color);
    const fc = pending ? null : findColour(bf.color);
    const codes = new Set();
    for (const raw of bf.specials || []) {
      if (validSpecials.has(raw)) { codes.add(raw); continue; }        // already a real code
      for (const c of mapSpecial(raw)) if (validSpecials.has(c)) codes.add(c);
    }
    const specials = [...codes];
    const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
    const variants = {
      fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
      fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : null,
      fabricLabel: fc ? fc.fabric_id : null,
      gap: bf.gap != null ? bf.gap + '"' : null, divanHeight: bf.divan != null ? bf.divan + '"' : null,
      legHeight: bf.leg != null ? bf.leg + '"' : null, totalHeight: tot ? tot + '"' : null,
      size: bf.size || null, specials,
    };
    const had = it.variants || {};
    if (!had.colourId && variants.colourId) gained++;
    updates.push({ id: it.id, variants, specials, gap: bf.gap, divan: bf.divan, leg: bf.leg });
  }
  const withColour = updates.filter((u) => u.variants.colourId).length;
  const withSpecials = updates.filter((u) => u.specials.length).length;
  log(`lines to refresh: ${updates.length}; with colour: ${withColour} (newly gained ${gained}); with real special options: ${withSpecials}`);
  log(`source of truth: ${byKey} by AutoCount DtlKey, ${byOwnText} by the line's own description2, ${noSource} skipped for having neither`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (let i = 0; i < updates.length; i += 200) {
    const b = updates.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        await tx`UPDATE scm.purchase_order_items SET
                   variants = ${sql.json(u.variants)},
                   custom_specials = ${u.specials.length ? sql.json(u.specials) : null},
                   gap_inches = ${u.gap != null ? Math.round(u.gap) : null},
                   divan_height_inches = ${u.divan != null ? Math.round(u.divan) : null},
                   leg_height_inches = ${u.leg != null ? Math.round(u.leg) : null}
                 WHERE id = ${u.id}`;
      }
    });
    log(`  ..${Math.min(i + 200, updates.length)}/${updates.length}`);
  }
  log(`DONE. refreshed ${updates.length} bedframe lines`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
