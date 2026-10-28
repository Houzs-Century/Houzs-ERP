#!/usr/bin/env node
// Take the duplicated sofa build photos back off the compartment rows.
//
// Owner 2026-08-10: "沙发的照片不需要每个 SKU 都进的 ... 我开 PO 每个 SKU 的
// 照片都一样,留第一个就可以了."
//
// One AutoCount sofa line is ONE photograph of ONE build. The importers fanned
// it onto every compartment row the build decomposed into, so a 5-piece build
// stored the same image 5 times and the operator scrolled past four duplicates.
// The importers now anchor it on the first piece; this removes what the earlier
// runs already wrote.
//
// A key is only pruned when the SAME key is still attached to an EARLIER row of
// the same build, so nothing can ever be the last copy of a photo. The R2
// objects are left alone: the key is deterministic, so re-attaching is free,
// and deleting an object no row points at buys nothing.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. The de-duplicated photo_urls array it writes has no duplicates left to prune.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const modelOf = (c) => { const x = norm(c); const d = x.indexOf("-"); return d < 0 ? x : x.slice(0, d); };

/* Keys minted by the AutoCount photo import look like ac-<DtlKey>-<n>.jpg, and
   the DtlKey identifies the AutoCount LINE - i.e. the build. Two rows carrying
   the same DtlKey are the same photograph. Operator-uploaded keys have no such
   prefix and are never touched. */
const acKey = (k) => /\/ac-\d+-\d+\.jpg$/.test(k || "");
const dtlOf = (k) => (/\/ac-(\d+)-\d+\.jpg$/.exec(k || "") || [])[1] ?? null;

async function pass(label, rows, idCol, docCol, codeCol, table) {
  const builds = new Map(); // doc|model -> rows in document order
  for (const r of rows) {
    const k = `${r[docCol]}|${modelOf(r[codeCol])}`;
    if (!builds.has(k)) builds.set(k, []);
    builds.get(k).push(r);
  }
  const edits = []; // {id, next[], dropped[]}
  for (const [, b] of builds) {
    const keptDtl = new Set();
    for (const r of b) {
      const urls = r.photo_urls ?? [];
      if (!urls.length) continue;
      const next = [], dropped = [];
      for (const k of urls) {
        const d = acKey(k) ? dtlOf(k) : null;
        if (d === null) { next.push(k); continue; }          // not ours - leave it
        if (keptDtl.has(d)) { dropped.push(k); continue; }   // an earlier row already holds this build's photo
        keptDtl.add(d); next.push(k);
      }
      if (dropped.length) edits.push({ id: r[idCol], next, dropped, doc: r[docCol], code: r[codeCol] });
    }
  }
  const nKeys = edits.reduce((s, e) => s + e.dropped.length, 0);
  log(`${label}: ${rows.length} sofa lines / ${builds.size} builds — ${edits.length} rows would lose ${nKeys} duplicate keys`);
  for (const e of edits.slice(0, 25)) log(`   ${e.doc} ${e.code}: -${e.dropped.length} (keeps ${e.next.length})`);
  if (edits.length > 25) log(`   ... ${edits.length - 25} more rows`);
  if (!APPLY) return 0;
  let n = 0;
  for (const e of edits) {
    await sql.unsafe(`UPDATE ${table} SET photo_urls = $1 WHERE id = $2`, [e.next, e.id]);
    n++;
  }
  log(`${label}: APPLIED — ${n} rows updated, ${nKeys} keys removed`);
  return nKeys;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);
  const so = await sql`
    SELECT i.id, i.doc_no, i.item_code, i.photo_urls
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.item_group = 'sofa'
     ORDER BY i.doc_no, i.line_no`;
  const po = await sql`
    SELECT i.id, p.po_number, i.item_code, i.photo_urls
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND i.item_group = 'sofa'
     ORDER BY p.po_number, i.id`;
  await pass("SALES ORDER", so, "id", "doc_no", "item_code", "scm.mfg_sales_order_items");
  await pass("PURCHASE ORDER", po, "id", "po_number", "item_code", "scm.purchase_order_items");
  if (!APPLY) log("DRY-RUN — set APPLY=1 to write.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
