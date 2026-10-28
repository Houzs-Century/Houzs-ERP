#!/usr/bin/env node
// Apply a reviewed hand-parse patch to the imported company-1 orders. The patch
// arrives as gzip+base64 JSON via a workflow input, so one-off fixes — lines
// whose Desc2 the regex parser can't read but a human/AI reading the text can,
// or a Phone2 re-export — land without a code PR per batch.
//
// Patch shape:
//   { "so_items":   [{ "id": 123, "variants": {..merged in..}, "specials": [..],
//                      "gap": 2, "divan": 8, "leg": 0 }],
//     "so_headers": [{ "doc_no": "HC-SO-...", "set": { "emergency_contact_phone": "..",
//                      "building_type": "..", "venue": ".." } }] }
// Only whitelisted header columns are writable; item variants MERGE into the
// existing JSON (never replace wholesale); numeric axes use COALESCE so a
// missing field never nulls an existing value. DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: convergent. A hand-written patch list, re-applied verbatim; the rows land on the same values. Not keyed on anything, so it also overwrites a human edit made since - check the list before a second run.
//
// THE MERGE HAPPENS IN THE DATABASE, and this script was the last of its family
// where it did not. It used to SELECT `variants`, spread it in JavaScript
// (`{...row.variants, ...p.variants}`) and assign the whole column back. That
// preserved keys, which is why it never showed up as the "refresh scripts
// REPLACE the whole variants jsonb" bug - but it carried the two failures
// docs/jsonb-double-encoding-coe.md is about:
//
//   1. NO SHAPE GUARD. Spreading a `variants` that is an ARRAY - the shape the
//      double-encoding defect left behind, and which #1938's repair owns - gives
//      `{"0":..,"1":..}`, a valid object. The write would have turned a
//      detectably damaged row into an undetectably damaged one.
//   2. NO READ-BACK, AND NO RETURNING. `nItems++` counted attempts. The colour
//      sweep reported three successful applies a day while destroying the column,
//      because a command tag answers "did a row change", never "does the row hold
//      what I meant".
//
// Both are closed: the write is `variants || patch` guarded on
// jsonb_typeof(...) = 'object' (lib/variant-merge.mjs mergeReviewedVariantPatch),
// counted from RETURNING, and every patched key is re-read on a FRESH CONNECTION
// before the script reports success.
import zlib from "node:zlib";
import postgres from "postgres";
import { mergeReviewedVariantPatch } from "./lib/variant-merge.mjs";

const DST = process.env.DATABASE_URL;
const PATCH = process.env.PATCH_B64;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
if (!PATCH) { console.error("need PATCH_B64"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const HEADER_COLS = new Set(["emergency_contact_phone", "building_type", "venue"]);

async function main() {
  const patch = JSON.parse(zlib.gunzipSync(Buffer.from(PATCH.trim(), "base64")).toString("utf8"));
  const items = patch.so_items || [];
  const headers = patch.so_headers || [];
  const poItems = patch.po_items || []; // {po_number, code, variants?, specials?, gap?, divan?, leg?}
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; item patches: ${items.length}; header patches: ${headers.length}; po item patches: ${poItems.length}`);
  for (const p of items.slice(0, 15)) log(`  item ${p.id}: ${JSON.stringify({ ...p, id: undefined })}`);
  for (const p of headers.slice(0, 15)) log(`  hdr ${p.doc_no}: ${JSON.stringify(p.set)}`);
  for (const p of poItems.slice(0, 15)) log(`  po ${p.po_number} ${p.code}: ${JSON.stringify({ ...p, po_number: undefined, code: undefined })}`);
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  /* Every merged row, with the patch it was given, so the read-back at the end
     can assert the VALUE landed rather than that a statement ran. */
  const applied = [];
  let nItems = 0, nHdr = 0, refused = 0;
  for (const p of items) {
    // address by uuid OR by (doc_no + item code) — the metrics report speaks
    // doc+code, so hand-parse patches shouldn't need an id lookup round-trip
    if (!p.id && p.doc_no && p.code) {
      const [hit] = await sql`SELECT id FROM scm.mfg_sales_order_items
        WHERE doc_no = ${p.doc_no} AND upper(item_code) = ${(p.code || "").toUpperCase()}
          AND (${p.desc_like ?? null}::text IS NULL OR description2 ILIKE '%' || ${p.desc_like ?? ""} || '%')
        LIMIT 1`;
      if (!hit) { log(`  !! item ${p.doc_no} ${p.code} not found, skipped`); continue; }
      p.id = hit.id;
    }
    const n = await mergeReviewedVariantPatch(sql, {
      table: "mfg_sales_order_items", id: p.id, patch: p.variants || {},
      geometry: { gap: p.gap ?? null, divan: p.divan ?? null, leg: p.leg ?? null },
    });
    if (!n) { refused++; log(`  !! item ${p.id} not merged - row missing, or its variants is not a jsonb object (#1938 owns that shape)`); continue; }
    /* custom_specials is a plain column, not jsonb-merged, and stays a separate
       statement so a specials-only patch cannot be mistaken for a variant one. */
    if (p.specials) await sql`UPDATE scm.mfg_sales_order_items
        SET custom_specials = ${sql.json(p.specials)} WHERE id = ${p.id}`;
    applied.push({ table: "mfg_sales_order_items", id: String(p.id), label: `item ${p.id}`, patch: p.variants || {} });
    nItems++;
  }
  for (const p of headers) {
    const cols = Object.entries(p.set || {}).filter(([k, val]) => HEADER_COLS.has(k) && val != null && val !== "");
    if (!cols.length) continue;
    const sets = cols.map(([k], i) => `${k} = $${i + 1}`).join(", ");
    const r = await sql.unsafe(
      `UPDATE scm.mfg_sales_orders SET ${sets} WHERE company_id = 1 AND doc_no = $${cols.length + 1}`,
      [...cols.map(([, val]) => val), p.doc_no]);
    if (r.count) nHdr++; else log(`  !! header ${p.doc_no} not found, skipped`);
  }
  let nPo = 0;
  for (const p of poItems) {
    // id lookup only - `variants` is never read into JavaScript any more
    const [row] = await sql`SELECT i.id FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = 1 AND (h.po_number = ${p.po_number} OR h.linked_ac_docno = ${p.po_number})
        AND upper(i.item_code) = ${(p.code || "").toUpperCase()} LIMIT 1`;
    if (!row) { log(`  !! po item ${p.po_number} ${p.code} not found, skipped`); continue; }
    const n = await mergeReviewedVariantPatch(sql, {
      table: "purchase_order_items", id: row.id, patch: p.variants || {},
      geometry: { gap: p.gap ?? null, divan: p.divan ?? null, leg: p.leg ?? null },
    });
    if (!n) { refused++; log(`  !! po item ${p.po_number} ${p.code} not merged - its variants is not a jsonb object (#1938 owns that shape)`); continue; }
    if (p.specials) await sql`UPDATE scm.purchase_order_items
        SET custom_specials = ${sql.json(p.specials)} WHERE id = ${row.id}`;
    applied.push({ table: "purchase_order_items", id: String(row.id), label: `po ${p.po_number} ${p.code}`, patch: p.variants || {} });
    nPo++;
  }
  log(`merged (counted from RETURNING, not the command tag): items ${nItems}, po items ${nPo}; header patches applied ${nHdr}; refused by the shape guard ${refused}`);
  await sql.end();

  /* ---- READ-BACK ON A FRESH CONNECTION -------------------------------------
     The session that just wrote is the worst available witness for what the rows
     now hold - that is the whole lesson of the colour sweep, which reported
     "APPLIED - stamped 146 sofa lines" three times while appending a string to
     an array. Re-open, re-read, and assert the intended VALUE. */
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let failed = 0;
  try {
    let ok = 0; const bad = [];
    for (const table of ["mfg_sales_order_items", "purchase_order_items"]) {
      const mine = applied.filter((a) => a.table === table);
      if (!mine.length) continue;
      const rows = await verify.unsafe(
        `SELECT id::text AS id, variants FROM scm.${table} WHERE id::text = ANY($1::text[])`,
        [mine.map((a) => a.id)]);
      const seen = new Map(rows.map((r) => [r.id, r.variants]));
      for (const a of mine) {
        const v = seen.get(a.id);
        if (!v || typeof v !== "object" || Array.isArray(v)) { bad.push(`${a.label}: row missing, or variants is not an object`); continue; }
        const wrong = Object.entries(a.patch).filter(([k, want]) => JSON.stringify(v[k] ?? null) !== JSON.stringify(want ?? null));
        if (wrong.length) bad.push(`${a.label}: holds ${JSON.stringify(Object.fromEntries(wrong.map(([k]) => [k, v[k] ?? null])))}, wanted ${JSON.stringify(Object.fromEntries(wrong))}`);
        else ok++;
      }
    }
    log(`READ-BACK on a fresh connection: ${ok}/${applied.length} patched rows hold the value that was written`);
    for (const b of bad) console.log(process.env.GITHUB_ACTIONS ? `::error::READ-BACK FAILED - ${b}` : `ERROR: READ-BACK FAILED - ${b}`);
    failed = bad.length;
  } finally { await verify.end(); }
  if (failed) process.exit(1);
  log(`DONE. item patches applied ${nItems}; header patches applied ${nHdr}; po item patches applied ${nPo}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
