#!/usr/bin/env node
// Cross-fill bedframe variants between a Sales Order and the Purchase Order
// raised for it (owner 2026-08-09: "那些SO有processing date 在autocount都要
// connection 开了什么PO的 ... 缺少的就去看PO/SO 通过relation map去看").
//
// In AutoCount a PO line carries the SO number it was raised for, and the two
// Desc2 texts describe the SAME physical bedframe — written by different people,
// so one often states what the other omits (colour on the PO, gap on the SO...).
// Where the ERP line is missing an axis and its counterpart HAS it, copy it over.
//
// Matching: PO.so_doc_no -> the AutoCount SO number we stored in
// linked_ac_docno, plus the same ERP material/item code. Only fills BLANKS —
// never overwrites a value that is already there.
// DRY-RUN by default; APPLY=1 to write.
import fs from "node:fs";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const isDivanOnly = (c) => /\bDIVAN\s*ONLY\b/i.test(c || "");

/** Merge donor values into the blanks of `into`. Returns null when nothing changed. */
function fillBlanks(into, donor) {
  const v = { ...(into.variants || {}) };
  let changed = false;
  const copy = (k) => {
    const dv = (donor.variants || {})[k];
    if ((v[k] === undefined || v[k] === null || v[k] === "") && dv != null && dv !== "") { v[k] = dv; changed = true; }
  };
  for (const k of ["fabricId", "colourId", "fabricCode", "colourLabel", "fabricLabel", "gap", "divanHeight", "legHeight", "totalHeight"]) copy(k);
  const cols = {};
  for (const [col, key] of [["gap_inches", "gap"], ["divan_height_inches", "divanHeight"], ["leg_height_inches", "legHeight"]]) {
    if (into[col] == null && donor[col] != null) { cols[col] = donor[col]; changed = true; }
    else if (into[col] == null && v[key]) { const n = parseFloat(String(v[key])); if (isFinite(n)) { cols[col] = Math.round(n); changed = true; } }
  }
  // specials: union, never lose one
  const a = Array.isArray(into.custom_specials) ? into.custom_specials : [];
  const b = Array.isArray(donor.custom_specials) ? donor.custom_specials : [];
  const merged = [...new Set([...a, ...b])];
  const specialsChanged = merged.length > a.length;
  if (specialsChanged) changed = true;
  return changed ? { variants: v, cols, specials: merged.length ? merged : null, specialsChanged } : null;
}

const complete = (r) => !!(r.variants?.colourId) && r.divan_height_inches != null && r.leg_height_inches != null && (r.gap_inches != null || isDivanOnly(r.code));

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const so = await sql`SELECT i.id, i.item_code AS code, i.variants, i.gap_inches, i.divan_height_inches, i.leg_height_inches, i.custom_specials, h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  const po = await sql`SELECT i.id, i.material_code AS code, i.variants, i.gap_inches, i.divan_height_inches, i.leg_height_inches, i.custom_specials, h.linked_ac_docno AS acpo
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  // the AutoCount PO -> SO link lives in the ERP's own AutoCount mirror
  const link = await sql`SELECT DISTINCT doc_no AS po_doc, so_doc_no AS so_doc FROM public.purchase_orders
    WHERE company_id = 1 AND so_doc_no IS NOT NULL AND so_doc_no <> ''`;
  const poToSo = new Map(link.map((r) => [r.po_doc, r.so_doc]));
  log(`SO bedframe lines ${so.length}; PO bedframe lines ${po.length}; PO->SO links ${poToSo.size}`);

  // index both sides by "<AutoCount SO no>|<erp code>"
  const soBy = new Map(), poBy = new Map();
  for (const r of so) soBy.set(`${r.ac}|${(r.code || "").toUpperCase()}`, r);
  for (const r of po) { const soNo = poToSo.get(r.acpo); if (soNo) poBy.set(`${soNo}|${(r.code || "").toUpperCase()}`, r); }
  const shared = [...soBy.keys()].filter((k) => poBy.has(k));
  log(`lines present on BOTH sides: ${shared.length}`);

  const soFix = [], poFix = [];
  for (const k of shared) {
    const s = soBy.get(k), p = poBy.get(k);
    if (!complete(s)) { const f = fillBlanks(s, p); if (f) soFix.push({ id: s.id, key: k, ...f }); }
    if (!complete(p)) { const f = fillBlanks(p, s); if (f) poFix.push({ id: p.id, key: k, ...f }); }
  }
  log(`SO lines improved from their PO: ${soFix.length}`);
  log(`PO lines improved from their SO: ${poFix.length}`);
  for (const f of [...soFix, ...poFix].slice(0, 10)) log(`   ${f.key} -> ${JSON.stringify(f.cols)} colour=${f.variants.colourId ?? "-"}`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  const write = async (table, list) => {
    for (const f of list) {
      await sql.unsafe(
        `UPDATE scm.${table} SET variants = $1::jsonb` +
        (f.specialsChanged ? `, custom_specials = $3::jsonb` : ``) +
        Object.keys(f.cols).map((c, i) => `, ${c} = ${f.cols[c]}`).join("") +
        ` WHERE id = $2`,
        // sql.json, never JSON.stringify - see BUG-HISTORY 2026-08-10. postgres.js
        // JSON-encodes any parameter it resolves to json/jsonb, so a
        // pre-stringified value is encoded twice and `variants = $1::jsonb`
        // would replace the object with a jsonb STRING.
        f.specialsChanged ? [sql.json(f.variants), f.id, sql.json(f.specials)] : [sql.json(f.variants), f.id],
      );
    }
  };
  await write("mfg_sales_order_items", soFix);
  await write("purchase_order_items", poFix);
  log(`DONE. SO lines filled ${soFix.length}; PO lines filled ${poFix.length}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
