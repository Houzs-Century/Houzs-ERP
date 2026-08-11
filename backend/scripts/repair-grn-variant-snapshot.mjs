#!/usr/bin/env node
/* Restore a goods-receipt line's variant SNAPSHOT where the value it holds
   could not have been a measurement. DRY-RUN by default; APPLY=1 writes.

   WHY THIS ARM EXISTS AT ALL. refresh-so-variants.mjs writes
   mfg_sales_order_items and refresh-po-variants.mjs writes
   purchase_order_items. NOTHING has ever written grn_items.variants after
   create-migrated-documents.mjs copied it off the PO line at receipt. It is an
   unswept third arm: a value that was wrong at the moment the snapshot was
   taken stays wrong forever, even after the PO line itself is repaired, and no
   existing check looks at it.

   WHAT MAY BE CORRECTED, and why that is restoring rather than rewriting. A
   goods receipt is a SNAPSHOT of the purchase order at receipt, so a genuine
   difference between the two is history and must be preserved. A row is
   therefore touched only when BOTH hold:

     1. the GRN's own figure could not be a measurement - it is outside the
        observed range for that axis, or it equals a digit run of the fabric
        code bound on the SAME row (the "PC151-01 -> 1 inch" shape, which no
        bounds check can see), and
     2. the parent PO line AGREES with its own AutoCount text on every numeric
        axis, so there is a sound value to restore from.

   Anything else - including every case where both sides are plausible and the
   difference could be a real change at receipt - is LEFT ALONE and listed.
   Measured on production 2026-08-11: 442 GRN lines carry variants, 331 already
   agree with their parent, 110 differ plausibly and are untouched, and exactly
   ONE qualifies.

   MERGE, NEVER REPLACE. `variants || patch` keeps every key this script does
   not own. The UPDATE requires jsonb_typeof(variants) = 'object' because
   object || non-object CONCATENATES INTO AN ARRAY instead of merging - the
   failure in docs/jsonb-double-encoding-coe.md. Values are bound with
   tx.json(), never JSON.stringify, since postgres.js serialises jsonb itself
   and a pre-serialised string lands as a jsonb string scalar. Rows are counted
   from RETURNING, never the command tag, and re-read on a FRESH CONNECTION. */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const err = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const j = (v) => JSON.stringify(v);

const NUMAX = ["gap", "divanHeight", "legHeight", "totalHeight"];
/* Ranges are the OBSERVED spread of every other GRN line, not an opinion:
   divans run 6-16 inches, gaps 9-16, legs 0-6, totals 19-30. */
const RANGE = { gap: [1, 24], divanHeight: [1, 24], legHeight: [0, 12], totalHeight: [1, 48] };
const numOf = (v) => { const m = /^\s*(\d+(?:\.\d+)?)/.exec(String(v ?? "")); return m ? parseFloat(m[1]) : null; };
const asObj = (v) => {
  let x = v;
  if (typeof x === "string") { try { x = JSON.parse(x); } catch { return null; } }
  if (Array.isArray(x)) return null;
  return x && typeof x === "object" ? x : null;
};
const codeNums = (v) => new Set(([v.colourId, v.fabricCode, v.fabricId, v.colourLabel]
  .filter((x) => typeof x === "string").join(" ").match(/\d+/g) ?? []).map(Number));

function blockFor(bf, findColour) {
  const fc = isPendingColour(bf.color) ? null : findColour(bf.color);
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return {
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: tot ? tot + '"' : null,
    colourId: fc ? fc.colour_id : null,
  };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const byDtl = new Map();
  for (const r of [...gz("ac-outstanding-so.json.gz"), ...gz("ac-outstanding-po.json.gz")]) byDtl.set(Number(r.DtlKey), r);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);

  const rows = await sql`
    SELECT gi.id::text AS id, g.grn_number, gi.material_code AS code, gi.variants AS gv,
           pi.variants AS pv, pi.description2 AS pd2, pi.linked_ac_dtlkey AS pdtl, p.po_number
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
     WHERE g.company_id = 1 AND jsonb_typeof(gi.variants) = 'object'`;

  const plan = []; const left = [];
  for (const r of rows) {
    const gv = asObj(r.gv); const pv = asObj(r.pv);
    if (!gv || !pv) continue;
    const cn = codeNums(gv);
    const suspect = NUMAX.filter((k) => gv[k] != null
      && (() => { const n = numOf(gv[k]); if (n == null) return false;
                  const [lo, hi] = RANGE[k]; return n < lo || n > hi || cn.has(n); })());
    if (!suspect.length) continue;

    const pex = r.pdtl != null ? byDtl.get(Number(r.pdtl)) : null;
    const text = pex ? pex.Desc2 : r.pd2;
    const should = text != null ? blockFor(parseBedframe(text), findColour) : null;
    const parentSound = should && !NUMAX.some((k) => (pv[k] ?? null) !== (should[k] ?? null));
    const drift = suspect.filter((k) => (gv[k] ?? null) !== (pv[k] ?? null));

    const desc = `${r.grn_number} <- ${r.po_number} ${r.code} suspect=${suspect.join(",")} GRN=${j(suspect.reduce((o, k) => (o[k] = gv[k] ?? null, o), {}))} PO=${j(suspect.reduce((o, k) => (o[k] = pv[k] ?? null, o), {}))} text=${j((text || "").replace(/\s+/g, " ").trim())}`;
    if (!parentSound) { left.push(`${desc}  LEFT: parent PO line does not agree with its own text`); continue; }
    if (!drift.length) { left.push(`${desc}  LEFT: GRN already equals its parent on the suspect axes`); continue; }

    /* Restore the whole numeric block from the parent, not only the offending
       axis: totalHeight is derived from the other three, so correcting a divan
       and leaving the total is a new inconsistency. */
    const patch = {};
    for (const k of NUMAX) patch[k] = pv[k] ?? null;
    plan.push({ id: r.id, desc, patch });
  }

  log(`GRN lines with an object variants block: ${rows.length}`);
  log(`LEFT UNTOUCHED (listed, never guessed at): ${left.length}`);
  for (const l of left) log(`   ${l}`);
  log(`TO RESTORE: ${plan.length}`);
  for (const p of plan) log(`   ${p.desc}\n      patch ${j(p.patch)}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let returned = 0, refused = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const res = await tx`UPDATE scm.grn_items
           SET variants = variants || ${tx.json(p.patch)}
         WHERE id = ${p.id} AND jsonb_typeof(variants) = 'object'
     RETURNING id::text AS id`;
      if (res.length) returned += res.length; else refused++;
    }
  });
  log(`rows returned by the UPDATE (not the command tag): ${returned}; refused by the shape guard: ${refused}`);
  await sql.end();

  // ---- independent read-back, FRESH CONNECTION -------------------------------
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const back = plan.length
    ? await verify`SELECT id::text AS id, variants FROM scm.grn_items WHERE id IN ${verify(plan.map((p) => p.id))}`
    : [];
  const seen = new Map(back.map((r) => [r.id, r]));
  let ok = 0; const bad = [];
  for (const p of plan) {
    const v = asObj(seen.get(p.id)?.variants);
    if (!v) { bad.push(`${p.desc}: row missing or variants not an object`); continue; }
    const wrong = Object.entries(p.patch).filter(([k, want]) => (v[k] ?? null) !== (want ?? null));
    if (wrong.length) bad.push(`${p.desc}: still ${j(Object.fromEntries(wrong.map(([k]) => [k, v[k] ?? null])))}`);
    else ok++;
  }
  log("");
  log(`READ-BACK on a fresh connection: ${ok}/${plan.length} rows hold the restored value`);
  for (const b of bad) err(`READ-BACK FAILED - ${b}`);
  if (bad.length) { err(`${bad.length} rows did not take the write`); await verify.end(); process.exit(1); }
  log("DONE. Every restored row was re-read on a separate connection.");
  await verify.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
