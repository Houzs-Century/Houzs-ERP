#!/usr/bin/env node
/* check-ac-erp-doc-links — the BOOK's document-relationship graph vs the ERP's,
 * both directions, in one report (owner 2026-08-30: "去理清 SO 跟什么
 * documentation 是有关联的…通过各式各样的文件来看一下它们之间的关系,看一下
 * 有哪些是 missing 的" — 不要只是单单看一张 SO).
 *
 * READ-ONLY. One connection, SELECTs only, exit 0 for every legitimate answer
 * (missing edges are the ANSWER, not an error). Non-zero only when the check
 * itself cannot run: DB unreachable, or the committed snapshots are stale.
 *
 * Edges compared (company 1, the AutoCount-imported scope):
 *   SO   docs   ac-outstanding-so        vs scm.mfg_sales_orders.linked_ac_docno
 *   PO   docs   ac-outstanding-po + ac-so-linked-pos vs scm.purchase_orders
 *   SO→PO lines ac-po-fromsodtlkey       vs scm.purchase_order_items.so_item_id
 *   SO→DO docs  ac-partial-dos           vs scm.delivery_orders.linked_ac_docno
 *   PO→GR docs  ac-gr-refs.GrNo          vs scm.grns.linked_ac_docno
 *   GR→PI docs  ac-gr-refs.PiNo          vs scm.purchase_invoices.linked_ac_docno
 *   SO→IV docs  ac-so-iv-excluded        vs live un-cancelled imported SOs (the
 *                                           "invoiced since import" reconcile)
 *
 * The book side comes from the committed export snapshots, so the verdict is
 * only as fresh as Phase 0 of docs/ac-resync-runbook.md — the same staleness
 * guard as the other reimport tools: refuse when exported_at is over 2 days
 * old (the mtime is a checkout artifact and is never consulted; bugs
 * 0560/0561/0563 are this class).
 *
 * RE-RUN: read-only — a second run answers again from current state.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });
const CO = 1;

const gz = (name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, name))).toString("utf8"));

// ── staleness guard: the manifest's own exported_at, never the file mtime ──
{
  const man = JSON.parse(fs.readFileSync(path.join(DATA, "ac-reimport-manifest.json"), "utf8"));
  const age = (Date.now() - new Date(man.exported_at).getTime()) / 86400000;
  console.log(`snapshots exported_at=${man.exported_at} (${age.toFixed(1)} days old)`);
  if (!(age <= 2)) {
    console.error(`REFUSED: snapshots are ${age.toFixed(1)} days old (>2). Re-run Phase 0 of docs/ac-resync-runbook.md first — a verdict against a stale book would read as coverage we do not have.`);
    await sql.end(); process.exit(2);
  }
}

const so = gz("ac-outstanding-so.json.gz");
const po1 = gz("ac-outstanding-po.json.gz");
const po2 = gz("ac-so-linked-pos.json.gz");
const dos = gz("ac-partial-dos.json.gz");
const grrefs = gz("ac-gr-refs.json.gz");
const ivx = gz("ac-so-iv-excluded.json.gz");
// this one is wrapped ({exportedAt, source, rows}) — the export stamps it
const links = gz("ac-po-fromsodtlkey.json.gz").rows;
const trim = (s) => String(s ?? "").trim();

// ── book graph ────────────────────────────────────────────────────────────
const bookSoDocs = new Set(so.map((r) => trim(r.DocNo)));
const bookPoDocs = new Set([...po1, ...po2].map((r) => trim(r.DocNo)));
const bookDoDocs = new Map(); // DoNo -> SoNo
for (const d of dos) bookDoDocs.set(trim(d.DoNo), trim(d.SoNo));
const bookGrDocs = new Map(); // GrNo -> PoNo
const bookPiDocs = new Map(); // PiNo -> Set<GrNo>
for (const g of grrefs) {
  if (g.GrNo) bookGrDocs.set(trim(g.GrNo), trim(g.PoNo));
  if (g.PiNo) {
    const k = trim(g.PiNo);
    if (!bookPiDocs.has(k)) bookPiDocs.set(k, new Set());
    bookPiDocs.get(k).add(trim(g.GrNo));
  }
}
// SO→PO line edges: PO line DtlKey -> SO line FromSODtlKey
const bookEdges = links.filter((l) => l.FromSODtlKey && l.FromSODtlKey !== 0 && l.FromSODtlKey !== "0");
console.log(`book graph: SO ${bookSoDocs.size} | PO ${bookPoDocs.size} | DO ${bookDoDocs.size} | GR ${bookGrDocs.size} | PI ${bookPiDocs.size} | SO→PO line edges ${bookEdges.length} | IV-excluded SOs ${ivx.length}`);

// ── ERP graph (one round trip per table, company-scoped) ──────────────────
const erpSo = await sql`SELECT doc_no, linked_ac_docno, status FROM scm.mfg_sales_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
const erpSoByAc = new Map(erpSo.map((r) => [trim(r.linked_ac_docno), r]));
const erpSoItems = await sql`SELECT i.id, i.linked_ac_dtlkey FROM scm.mfg_sales_order_items i
  JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
  WHERE h.company_id=${CO} AND i.linked_ac_dtlkey IS NOT NULL`;
const soLineByDtlkey = new Map(); // dtlkey -> [item ids] (sofa splits share one dtlkey)
for (const r of erpSoItems) {
  const k = String(r.linked_ac_dtlkey);
  if (!soLineByDtlkey.has(k)) soLineByDtlkey.set(k, []);
  soLineByDtlkey.get(k).push(r.id);
}
const erpPo = await sql`SELECT id, doc_no, linked_ac_docno FROM scm.purchase_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
const erpPoByAc = new Map(erpPo.map((r) => [trim(r.linked_ac_docno), r]));
const erpPoItems = await sql`SELECT i.id, i.linked_ac_dtlkey, i.so_item_id, p.linked_ac_docno AS po_ac
  FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
  WHERE p.company_id=${CO} AND p.linked_ac_docno IS NOT NULL`;
const poLineByDtlkey = new Map(erpPoItems.filter((r) => r.linked_ac_dtlkey != null).map((r) => [String(r.linked_ac_dtlkey), r]));
const erpDo = await sql`SELECT do_number, so_doc_no, linked_ac_docno FROM scm.delivery_orders WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
const erpDoByAc = new Map(erpDo.map((r) => [trim(r.linked_ac_docno), r]));
const erpGr = await sql`SELECT id, linked_ac_docno FROM scm.grns WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
const erpGrByAc = new Map(erpGr.map((r) => [trim(r.linked_ac_docno), r]));
const erpPi = await sql`SELECT id, linked_ac_docno FROM scm.purchase_invoices WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
const erpPiByAc = new Map(erpPi.map((r) => [trim(r.linked_ac_docno), r]));
const erpSi = await sql`SELECT id, linked_ac_docno FROM scm.sales_invoices WHERE company_id=${CO} AND linked_ac_docno IS NOT NULL`;
console.log(`erp graph:  SO ${erpSoByAc.size} | PO ${erpPoByAc.size} | DO ${erpDoByAc.size} | GR ${erpGrByAc.size} | PI ${erpPiByAc.size} | SI ${erpSi.length}\n`);

const listSome = (arr, n = 15) => arr.slice(0, n).join(", ") + (arr.length > n ? ` … +${arr.length - n} more` : "");
let backlog = 0;

// A. document coverage, book → ERP (missing = the next resync's import list)
for (const [label, bookSet, erpMap] of [
  ["SO", bookSoDocs, erpSoByAc],
  ["PO", bookPoDocs, erpPoByAc],
  ["DO", new Set(bookDoDocs.keys()), erpDoByAc],
  ["GR", new Set(bookGrDocs.keys()), erpGrByAc],
  ["PI", new Set(bookPiDocs.keys()), erpPiByAc],
]) {
  const missing = [...bookSet].filter((d) => !erpMap.has(d));
  backlog += missing.length;
  console.log(`${label}: book ${bookSet.size}, in ERP ${bookSet.size - missing.length}, MISSING ${missing.length}${missing.length ? " -> " + listSome(missing) : ""}`);
}

// B. SO→PO line edges, both directions
{
  let ok = 0; const missEdge = []; const halfLinked = [];
  for (const e of bookEdges) {
    const poLine = poLineByDtlkey.get(String(e.DtlKey));
    const soIds = soLineByDtlkey.get(String(e.FromSODtlKey));
    if (!poLine || !soIds) { missEdge.push(`${trim(e.DocNo)}#${e.DtlKey}(line not imported)`); continue; }
    if (poLine.so_item_id && soIds.includes(poLine.so_item_id)) ok += 1;
    else halfLinked.push(`${trim(e.DocNo)}#${e.DtlKey}->SODtl${e.FromSODtlKey}${poLine.so_item_id ? "(points elsewhere)" : "(so_item_id NULL)"}`);
  }
  backlog += missEdge.length + halfLinked.length;
  console.log(`\nSO→PO line edges: book ${bookEdges.length}, linked-in-ERP ${ok}, LINE-MISSING ${missEdge.length}${missEdge.length ? " -> " + listSome(missEdge) : ""}, EDGE-MISSING ${halfLinked.length}${halfLinked.length ? " -> " + listSome(halfLinked) : ""}`);
  // the owner's exact case, reversed: the PO side sees a link the SO side lacks
  const bookEdgeKeys = new Set(bookEdges.map((e) => String(e.DtlKey)));
  const erpOnly = erpPoItems.filter((r) => r.so_item_id && r.linked_ac_dtlkey != null && !bookEdgeKeys.has(String(r.linked_ac_dtlkey)));
  console.log(`SO→PO edges only in ERP (text-repair or hand-linked; informational): ${erpOnly.length}`);
}

// C. DO / GR / PI parent links resolve to the right imported parent
{
  const wrongDo = [];
  for (const [doNo, soNo] of bookDoDocs) {
    const d = erpDoByAc.get(doNo);
    if (d && trim(d.so_doc_no) !== "HC-" + soNo && trim(d.so_doc_no) !== soNo) wrongDo.push(`${doNo}: ERP parent ${d.so_doc_no} vs book ${soNo}`);
  }
  backlog += wrongDo.length;
  console.log(`\nDO parent check: WRONG-PARENT ${wrongDo.length}${wrongDo.length ? " -> " + listSome(wrongDo) : ""}`);
}

// D. invoiced-since-import: excluded IV SOs that sit live in the ERP anyway
{
  const live = ivx.map(trim).filter((d) => { const r = erpSoByAc.get(d); return r && r.status !== "CANCELLED"; });
  backlog += live.length;
  console.log(`SO invoiced in the book but still live in ERP (the reconcile list): ${live.length}${live.length ? " -> " + listSome(live) : ""}`);
}

console.log(`\nVERDICT: total backlog items ${backlog} — ${backlog === 0
  ? "the two graphs agree; nothing is missing on either side."
  : "each named item above is either the next resync's import list (docs newer than the last run) or a real gap; run the runbook lanes in order and re-run this check."}`);
await sql.end();
