#!/usr/bin/env node
/* Repair the migrated bedframe SO lines that hold ANOTHER line's build.
   DRY-RUN by default; APPLY=1 writes.

   WHAT WENT WRONG. refresh-so-variants.mjs looked its parsed Desc2 up by
   (AutoCount DocNo | ERP item code). That pair is not a line identity: one
   order routinely carries several rows of the same SKU in different colours or
   heights, so Map.set kept only the LAST of them and the write stamped that
   single parse onto EVERY line sharing the key. See BUG-HISTORY.md.

   WHAT THIS REPAIRS, and the two gates that keep it honest. A row is touched
   only when BOTH hold:

     1. its variants DISAGREE with the AutoCount text of its OWN line, reached
        by linked_ac_dtlkey -> DtlKey (an exact key, not a positional guess at
        read time), and
     2. its variants are EXACTLY what the collided key would have produced.

   Gate 2 is the proof of provenance. Without it this would be a general
   "re-parse everything" sweep that could overwrite a value a human chose; with
   it, every row written is one we can show came from another line's text.

   MERGE, NEVER REPLACE. The column is patched with `variants || patch` so keys
   this script does not own - specials above all - survive untouched. Rebuilding
   the whole block from a fixed key list is what drops unknown keys, and the
   refresh scripts' habit of doing that is NOT copied here. The UPDATE also
   requires jsonb_typeof(variants) = 'object', because object || non-object
   CONCATENATES INTO AN ARRAY rather than merging - the failure in
   docs/jsonb-double-encoding-coe.md.

   Values are bound with tx.json(), never JSON.stringify: postgres.js applies
   its own JSON.stringify to anything it resolves to jsonb, so a pre-serialized
   string is encoded twice and lands a jsonb string scalar.

   Rows are counted from RETURNING, never from the command tag, and the result
   is re-read on a FRESH CONNECTION at the end - the connection that just wrote
   is the worst available witness.

     SCOPE=named    (default) only the 14 documents the chain audit named, each
                    independently corroborated by the PO built from it
     SCOPE=collided every row satisfying both gates */
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
const SCOPE = (process.env.SCOPE || "named").toLowerCase();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const err = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* The 14 the chain audit named. Every one was re-verified against production on
   2026-08-11: all 14 are collided, and the line's own Desc2 backs the PO on
   every conflicting axis - including HC-SO-012781, which the handover had
   listed as an exception. It is not one: "Hydraulic2pcs12”inner" states the
   INNER depth, and the owner's rule (#1883) converts an inner-only figure at
   +2, so that bed's divan is 14" and the PO was right. 27 axes of 27. */
const NAMED = new Set([
  "HC-SO-011850", "HC-SO-010777", "HC-SO-011886", "HC-SO-006945", "HC-SO-006572",
  "HC-SO-008117", "HC-SO-012685", "HC-SO-012781", "HC-SO-012209", "HC-SO-012419",
  "HC-SO-012943", "HC-SO-012964", "HC-SO-012949",
]);

const norm2 = (s) => (s || "").replace(/\s+/g, " ").trim();
const asObj = (v) => {
  let x = v;
  if (typeof x === "string") { try { x = JSON.parse(x); } catch { return null; } }
  if (Array.isArray(x)) return null;                 // damaged shape - not ours to guess at
  return x && typeof x === "object" ? x : null;
};

function blockFor(bf, findColour) {
  const fc = isPendingColour(bf.color) ? null : findColour(bf.color);
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return {
    fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
    fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : null,
    fabricLabel: fc ? fc.fabric_id : null,
    gap: bf.gap != null ? bf.gap + '"' : null, divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null, totalHeight: tot ? tot + '"' : null,
    size: bf.size || null,
    _n: { gap: bf.gap ?? null, divan: bf.divan ?? null, leg: bf.leg ?? null },
  };
}
const COLOUR_KEYS = ["fabricId", "colourId", "fabricCode", "colourLabel", "fabricLabel"];
const SHAPE_KEYS = ["gap", "divanHeight", "legHeight", "totalHeight", "size"];
const CMP = ["colourId", "gap", "divanHeight", "legHeight", "size"];
const differs = (a, b) => CMP.filter((k) => (a[k] ?? null) !== (b[k] ?? null));

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} scope=${SCOPE}`);
  const byDtl = new Map();
  for (const r of [...gz("ac-outstanding-so.json.gz"), ...gz("ac-outstanding-po.json.gz")]) byDtl.set(Number(r.DtlKey), r);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);

  // the collided key, rebuilt exactly as the defect built it
  const csvLines = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csvLines.shift();
  const byAc = new Map();
  for (const ln of csvLines) {
    const f = []; let cur = ""; let q = false;
    for (let i = 0; i < ln.length; i++) { const c = ln[i];
      if (q) { if (c === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ",") { f.push(cur); cur = ""; } else cur += c; } }
    f.push(cur);
    if (f[0]) byAc.set(f[0].trim().toUpperCase().replace(/\s+/g, " "), (f[1] || "").trim());
  }
  const collidedKey = new Map();
  for (const r of gz("ac-outstanding-so.json.gz")) {
    const erp = byAc.get((r.ItemCode || "").trim().toUpperCase().replace(/\s+/g, " "));
    if (erp) collidedKey.set(`${r.DocNo}|${erp.toUpperCase()}`, r);
  }

  const items = await sql`SELECT i.id::text AS id, i.doc_no, i.item_code, i.linked_ac_dtlkey, i.description2 AS d2,
                                 i.variants, i.gap_inches, i.divan_height_inches, i.leg_height_inches,
                                 h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
   WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;

  const plan = []; let skippedShape = 0, notCollided = 0, agrees = 0;
  for (const it of items) {
    if (it.linked_ac_dtlkey == null) continue;
    const ex = byDtl.get(Number(it.linked_ac_dtlkey));
    const own = ex ? ex.Desc2 : it.d2;
    if (own == null) continue;
    const cur = asObj(it.variants);
    if (!cur) { skippedShape++; continue; }
    const want = blockFor(parseBedframe(own), findColour);
    const d = differs(cur, want);
    if (!d.length) { agrees++; continue; }
    // gate 2: the row must hold exactly what the collided key would have produced
    const bad = collidedKey.get(`${it.ac}|${(it.item_code || "").toUpperCase()}`);
    if (!bad || norm2(bad.Desc2) === norm2(own)) { notCollided++; continue; }
    const wouldBe = blockFor(parseBedframe(bad.Desc2), findColour);
    if (differs(cur, wouldBe).length) { notCollided++; continue; }
    if (SCOPE === "named" && !NAMED.has(it.doc_no)) continue;

    const patch = {};
    if (d.includes("colourId")) for (const k of COLOUR_KEYS) patch[k] = want[k];
    if (d.some((k) => ["gap", "divanHeight", "legHeight"].includes(k))) for (const k of SHAPE_KEYS) patch[k] = want[k];
    else if (d.includes("size")) patch.size = want.size;
    plan.push({ id: it.id, doc: it.doc_no, code: it.item_code, dtl: it.linked_ac_dtlkey, axes: d, patch, n: want._n,
                from: Object.fromEntries(d.map((k) => [k, cur[k] ?? null])), to: Object.fromEntries(d.map((k) => [k, want[k] ?? null])) });
  }

  log(`bedframe SO lines: ${items.length}; agree with own line text: ${agrees}; not attributable to the collision: ${notCollided}; damaged variants shape (left alone): ${skippedShape}`);
  log(`TO REPAIR (scope=${SCOPE}): ${plan.length}`);
  for (const p of plan) log(`   ${p.doc} ${p.code} dtl=${p.dtl} ${p.axes.join(",")}  ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}`);

  if (!APPLY) { log(""); log("DRY-RUN - set APPLY=1 to write."); await sql.end(); return; }

  let returned = 0, refused = 0;
  for (let i = 0; i < plan.length; i += 100) {
    const batch = plan.slice(i, i + 100);
    await sql.begin(async (tx) => {
      for (const p of batch) {
        /* MERGE into the existing object. The jsonb_typeof guard is what stops
           object || non-object silently concatenating into an array. */
        const res = await tx`UPDATE scm.mfg_sales_order_items
             SET variants = variants || ${tx.json(p.patch)},
                 gap_inches = ${p.n.gap != null ? Math.round(p.n.gap) : null},
                 divan_height_inches = ${p.n.divan != null ? Math.round(p.n.divan) : null},
                 leg_height_inches = ${p.n.leg != null ? Math.round(p.n.leg) : null}
           WHERE id = ${p.id} AND jsonb_typeof(variants) = 'object'
       RETURNING id::text AS id`;
        if (res.length) returned += res.length; else refused++;
      }
    });
  }
  log(`rows returned by the UPDATE (not the command tag): ${returned}; refused by the shape guard: ${refused}`);
  await sql.end();

  // ---- independent read-back, FRESH CONNECTION -------------------------------
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const ids = plan.map((p) => p.id);
  const back = ids.length ? await verify`SELECT id::text AS id, variants, gap_inches, divan_height_inches, leg_height_inches
                                           FROM scm.mfg_sales_order_items WHERE id IN ${verify(ids)}` : [];
  const seen = new Map(back.map((r) => [r.id, r]));
  let ok = 0; const bad = [];
  for (const p of plan) {
    const r = seen.get(p.id);
    const v = r ? asObj(r.variants) : null;
    if (!v) { bad.push(`${p.doc} ${p.code}: row missing or variants not an object`); continue; }
    const wrong = Object.entries(p.patch).filter(([k, want]) => (v[k] ?? null) !== (want ?? null));
    if (wrong.length) bad.push(`${p.doc} ${p.code}: still ${JSON.stringify(Object.fromEntries(wrong.map(([k]) => [k, v[k] ?? null])))}, wanted ${JSON.stringify(Object.fromEntries(wrong))}`);
    else ok++;
  }
  log("");
  log(`READ-BACK on a fresh connection: ${ok}/${plan.length} rows hold the repaired value`);
  for (const b of bad) err(`READ-BACK FAILED - ${b}`);
  if (bad.length) { err(`${bad.length} rows did not take the write`); await verify.end(); process.exit(1); }
  log("DONE. Every repaired row was re-read on a separate connection and holds what was written.");
  await verify.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
