#!/usr/bin/env node
// Re-parse the AutoCount Desc2 with the CURRENT parser and UPDATE the already
// imported company-1 bedframe lines in place. No wipe, no re-import: the orders,
// payments and the backfilled processing/delivery dates all stay exactly as they
// are — only the variant fields are recomputed.
//
// Owner 2026-08-09: "为什么要清旧的SO 不能update进去用旧的" — right, an UPDATE is
// safer than wipe+reload, so parser improvements land this way from now on.
//
// WHAT IT MAY CHANGE, and what it may not. The sweep owns exactly the keys in
// OWNED_VARIANT_KEYS (lib/variant-merge.mjs) — the fabric/colour block, the
// gap/divan/leg heights and the size — plus the three geometry columns that
// mirror them. It MERGES that patch into the existing `variants` jsonb; every
// other key in that column belongs to another writer and survives untouched.
// It used to rebuild the whole object and write the column wholesale, which
// deleted any key it had not heard of (BUG-HISTORY.md, "The variant refresh
// scripts REPLACE the whole variants jsonb"; PR #1926 recorded it, this fixes
// it).
//
// It no longer writes `variants.specials` or `custom_specials`. Both now belong
// to backfill-specials-into-variants.mjs, which is the money-guarded pipeline —
// see the rationale on OWNED_VARIANT_KEYS. This sweep still REPORTS what the
// Desc2 re-parse would map, so the parse is still visible in the run log.
//
// DRY-RUN by default; APPLY=1 to write.
//
// RE-RUN: by design, repeatedly. This is a SWEEP: it re-parses Desc2 and re-stamps only the keys in OWNED_VARIANT_KEYS, so running it after every parser change is the point.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { mapSpecial } from "./lib/bedframe-special-map.mjs";
import { buildBedframeVariantPatch, mergeVariantPatch } from "./lib/variant-merge.mjs";

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

  const items = await sql`SELECT i.id, i.item_code AS item_code, i.variants, i.description2, i.linked_ac_dtlkey, h.linked_ac_docno
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  log(`imported PO bedframe lines: ${items.length}`);

  const updates = []; let gained = 0; let byKey = 0, byOwnText = 0, noSource = 0;
  let fills = 0, changes = 0; const changeSamples = [];
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
    const patch = buildBedframeVariantPatch(bf, fc);
    const had = it.variants || {};
    if (!had.colourId && patch.colourId) gained++;
    /* FILLING A BLANK AND CHANGING AN ANSWER ARE NOT THE SAME RISK, and until
       now this sweep reported only the first. A fill is a value the row never
       had; a CHANGE overwrites something a person or an earlier parse already
       put there, and that is the number you want in front of you before
       APPLY=1. Counted per OWNED key, so one line can contribute to both. */
    for (const k of Object.keys(patch)) {
      const before = had[k], after = patch[k];
      if (after == null || String(after) === "") continue;
      if (before == null || String(before) === "") { fills++; continue; }
      if (String(before) !== String(after)) {
        changes++;
        if (changeSamples.length < 15) changeSamples.push(`   ${it.item_code}  ${k}: "${before}" -> "${after}"`);
      }
    }
    updates.push({ id: it.id, patch, specials, geometry: { gap: bf.gap, divan: bf.divan, leg: bf.leg } });
  }
  const withColour = updates.filter((u) => u.patch.colourId).length;
  const withSpecials = updates.filter((u) => u.specials.length).length;
  log(`lines to refresh: ${updates.length}; with colour: ${withColour} (newly gained ${gained}); parsed special options (REPORT ONLY, not written): ${withSpecials}`);
  log(`source of truth: ${byKey} by AutoCount DtlKey, ${byOwnText} by the line's own description2, ${noSource} skipped for having neither`);
  log(`WHAT THE WRITE WOULD DO, per owned key: ${fills} would FILL a blank; ${changes} would CHANGE a value that is already there`);
  if (changes) { log(`the changes (up to 15) — read these before APPLY=1:`); for (const ln of changeSamples) log(ln); }

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  /* Merged, never replaced: `variants = variants || patch` overwrites only the
     keys this sweep owns. A row whose `variants` is not a jsonb object is
     SKIPPED by the statement's own WHERE (jsonb || non-object concatenates into
     an array rather than merging — docs/jsonb-double-encoding-coe.md) and
     counted here, never coerced. The count is RETURNING, not a command tag. */
  let merged = 0; const skipped = new Set();
  for (let i = 0; i < updates.length; i += 200) {
    const b = updates.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        const n = await mergeVariantPatch(tx, {
          table: "purchase_order_items", id: u.id, patch: u.patch, geometry: u.geometry,
        });
        if (n) merged += n; else skipped.add(u.id);
      }
    });
    log(`  ..${Math.min(i + 200, updates.length)}/${updates.length}`);
  }
  if (skipped.size) {
    log(`SKIPPED ${skipped.size} line(s) whose variants jsonb is not an object — left untouched for #1938's shape repair:`);
    for (const id of [...skipped].slice(0, 50)) log(`   ${id}`);
  }
  log(`DONE. merged ${merged} of ${updates.length} bedframe lines (RETURNING)`);

  /* Read back on a SEPARATE connection. The session that just wrote is the
     worst available witness for what the rows now hold. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  try {
    const ids = updates.map((u) => u.id).filter((id) => !skipped.has(id));
    const [chk] = await v.unsafe(
      `SELECT COUNT(*)::int AS n FROM scm.purchase_order_items
        WHERE id = ANY($1::uuid[]) AND jsonb_typeof(variants) = 'object'`, [ids]);
    log(`READ-BACK on a NEW connection: ${chk.n}/${ids.length} merged rows hold a jsonb OBJECT`);
    if (chk.n !== ids.length) log(`::error::${ids.length - chk.n} merged rows are NOT objects — investigate before another run`);
  } finally { await v.end(); }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
