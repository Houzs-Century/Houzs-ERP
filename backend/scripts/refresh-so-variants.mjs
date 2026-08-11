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
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { mapSpecial } from "./lib/bedframe-special-map.mjs";
import {
  OWNED_SIZE_ONLY_KEYS, buildBedframeVariantPatch, buildSizeOnlyVariantPatch, mergeVariantPatch,
} from "./lib/variant-merge.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  /* AutoCount DtlKey -> the freshly parsed variant block.
     DtlKey is the LINE's own identity and is unique across the whole export
     (13,588 rows, 13,588 distinct keys). The pair (DocNo | erp_code) that this
     lookup used until 2026-08-11 is NOT unique: one order routinely carries
     several rows of the same SKU in different colours or heights, so Map.set
     kept only the LAST of them and the write below then stamped that single
     parse onto EVERY line sharing the key. 183 keys collided with a DIFFERENT
     Desc2 and 298 export lines were lost that way - see BUG-HISTORY.md.
     Keying on DtlKey also retires the AutoCount->ERP item-code CSV here: the
     line identity needs no code translation to find its own text. */
  const parsed = new Map();
  for (const r of rows) parsed.set(Number(r.DtlKey), parseBedframe(r.Desc2));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const validSpecials = new Set((await sql`SELECT code FROM scm.special_addons WHERE company_id = 1 AND 'BEDFRAME' = ANY(categories)`).map((r) => r.code));

  // (SP) special-size lines are included whatever their group — a custom-size
  // MATTRESS carries its dimensions in Desc2 too and must show them.
  const items = await sql`SELECT i.id, i.item_code, i.item_group, i.variants, i.description2, i.linked_ac_dtlkey, h.linked_ac_docno
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND (i.item_group = 'bedframe' OR i.item_code ILIKE '%(SP)%') AND h.linked_ac_docno IS NOT NULL`;
  log(`imported bedframe lines: ${items.length}`);

  const updates = []; let gained = 0; let byKey = 0, byOwnText = 0, noSource = 0;
  for (const it of items) {
    /* Resolve by the LINE's identity, never by (document + item code). A line
       with no stored DtlKey falls back to its OWN description2, which the
       import wrote per line and is therefore line-accurate too; what must never
       happen again is one line's text being applied to another's. */
    const viaKey = it.linked_ac_dtlkey != null ? parsed.get(Number(it.linked_ac_dtlkey)) : undefined;
    const bf = viaKey ?? (it.description2 ? parseBedframe(it.description2) : null);
    if (!bf) { noSource++; continue; }
    if (viaKey) byKey++; else byOwnText++;
    if (it.item_group !== "bedframe") {
      // non-bedframe (SP) line: only the dimensions apply — no fabric/gap/divan/leg
      if (!bf.size) continue;
      updates.push({ id: it.id, sizeOnly: true, patch: buildSizeOnlyVariantPatch(bf), specials: [], geometry: null });
      continue;
    }
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
    updates.push({ id: it.id, patch, specials, geometry: { gap: bf.gap, divan: bf.divan, leg: bf.leg } });
  }
  const withColour = updates.filter((u) => u.patch.colourId).length;
  const withSpecials = updates.filter((u) => u.specials.length).length;
  log(`lines to refresh: ${updates.length}; with colour: ${withColour} (newly gained ${gained}); parsed special options (REPORT ONLY, not written): ${withSpecials}`);
  log(`source of truth: ${byKey} by AutoCount DtlKey, ${byOwnText} by the line's own description2, ${noSource} skipped for having neither`);

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
          table: "mfg_sales_order_items", id: u.id, patch: u.patch, geometry: u.geometry,
          owned: u.sizeOnly ? OWNED_SIZE_ONLY_KEYS : undefined,
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
      `SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items
        WHERE id = ANY($1::uuid[]) AND jsonb_typeof(variants) = 'object'`, [ids]);
    log(`READ-BACK on a NEW connection: ${chk.n}/${ids.length} merged rows hold a jsonb OBJECT`);
    if (chk.n !== ids.length) log(`::error::${ids.length - chk.n} merged rows are NOT objects — investigate before another run`);
  } finally { await v.end(); }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
