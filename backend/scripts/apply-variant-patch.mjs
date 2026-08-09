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
import zlib from "node:zlib";
import postgres from "postgres";

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

  let nItems = 0, nHdr = 0;
  for (const p of items) {
    const [row] = await sql`SELECT variants FROM scm.mfg_sales_order_items WHERE id = ${p.id}`;
    if (!row) { log(`  !! item ${p.id} not found, skipped`); continue; }
    const v = { ...(row.variants || {}), ...(p.variants || {}) };
    await sql`UPDATE scm.mfg_sales_order_items SET
        variants = ${sql.json(v)},
        custom_specials = COALESCE(${p.specials ? sql.json(p.specials) : null}, custom_specials),
        gap_inches = COALESCE(${p.gap ?? null}, gap_inches),
        divan_height_inches = COALESCE(${p.divan ?? null}, divan_height_inches),
        leg_height_inches = COALESCE(${p.leg ?? null}, leg_height_inches)
      WHERE id = ${p.id}`;
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
    const [row] = await sql`SELECT i.id, i.variants FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = 1 AND h.po_number = ${p.po_number} AND upper(i.material_code) = ${(p.code || "").toUpperCase()} LIMIT 1`;
    if (!row) { log(`  !! po item ${p.po_number} ${p.code} not found, skipped`); continue; }
    const v = { ...(row.variants || {}), ...(p.variants || {}) };
    await sql`UPDATE scm.purchase_order_items SET
        variants = ${sql.json(v)},
        custom_specials = COALESCE(${p.specials ? sql.json(p.specials) : null}, custom_specials),
        gap_inches = COALESCE(${p.gap ?? null}, gap_inches),
        divan_height_inches = COALESCE(${p.divan ?? null}, divan_height_inches),
        leg_height_inches = COALESCE(${p.leg ?? null}, leg_height_inches)
      WHERE id = ${row.id}`;
    nPo++;
  }
  log(`DONE. item patches applied ${nItems}; header patches applied ${nHdr}; po item patches applied ${nPo}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
