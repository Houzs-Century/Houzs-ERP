#!/usr/bin/env node
// Stamp each imported purchase order with the AutoCount goods-received (and
// purchase-invoice) documents that actually received it.
//
// WHY THIS AND NOT A GRN (owner left the call to me, 2026-08-10: "也行，你决定。
// 最重要是你要把这些 transfer / migrate 记录全部写下来"):
//
// The tempting version is to create ERP GRN documents so the paperwork matches
// AutoCount one-for-one. It is the wrong trade. A GRN in this system IS an
// inventory event — posting one builds lots and movements, and the costing
// engine reads it. The migrated units are ALREADY in stock from the balance
// snapshot, so a GRN carrying them would double the stock; and a GRN that
// deliberately posts nothing is worse, because it is a live landmine: any
// future repair sweep that reconciles GRNs against movements will either flag
// it forever or "fix" it by creating the movements it is missing.
//
// So the receipt stays where it really happened, in AutoCount, and the ERP
// carries a POINTER to it. A human on the PO screen can read the GR number and
// look it up; nothing in the ERP can mistake it for stock.
//
// ── THE SOURCE IS THE WHOLE BOOK, NOT THE OUTSTANDING CUT (2026-09-08) ──────
//
// This job used to read `ac-gr-refs.json.gz`, and that file is cut by
// `export-ac-reimport.py` with `WHERE po.DocNo IN (<the POs being exported>)` —
// the purchase orders that were OUTSTANDING on the day of that cut. A purchase
// order that has since been fully received DROPS OUT of the outstanding cut,
// so the receipts and invoices that closed it are never exported, and this job
// could not stamp them however often it ran. The ERP keeps the purchase order
// forever; the cut does not keep its receipts.
//
// That is not a theory. On 2026-09-08 the manifest recorded the last export as
// `sections: ["hdr"]` — every other file, `ac-gr-refs.json.gz` included, was
// left at the `reimport-v3 2026-08-28` round, carrying 214 receipt documents
// and 186 purchase invoices. The book records 521 in-scope receipt edges and
// 448 in-scope invoice edges for the very same purchase orders. The convert
// symmetry matrix read the difference as 24 missing GR<-PO edges and 54 missing
// PI<-GR edges, and the shapes it saw follow from the mechanism exactly:
//
//   * the 24 receipts are dated 2026-08-28 .. 2026-09-07 — after that cut;
//   * the 54 invoices are spread 2026-01-16 .. 2026-09-02, which looked like it
//     ruled a backlog out. It does not. What decides membership is not the
//     INVOICE's date but whether its PURCHASE ORDER was still outstanding on
//     2026-08-28; when an order leaves that population its whole invoice
//     history leaves with it, whatever the dates on it.
//
// So the source is now `ac-convert-edges.json.gz` — the same live book, cut
// 2026-09-07 16:39 local with NO filtering at all. Every GR line naming a
// purchase order, and every PI line naming one of those receipts, in the book's
// own numbering. `ac-gr-refs.json.gz` stays where it is used for something it
// can answer (the receipt's own Location, lib/ac-gr-location.mjs) and is read
// here only to PRINT how far short of the book it falls, so the next person
// sees the regression instead of re-deriving it.
//
// UNION, NEVER REPLACE. An existing stamp is added to, never dropped. The book
// is the authority on what SHOULD be there and this job's job is to close the
// gap; deciding that a stamp already on the row is wrong is a different
// question with a different blast radius, and one this file refuses to answer
// silently. Anything held that the book does not record is PRINTED and left
// alone — the symmetry check reads 0 of those and a non-zero is news.
//
// WHAT THIS DOES NOT DO. It writes two pointer arrays on scm.purchase_orders
// and nothing else. Neither column is read anywhere in the Worker request path
// — the only mentions in backend/src are comments — so this moves no stock, no
// readiness and no money. It also does NOT create the migrated receipt
// documents those new pointers name: `create-migrated-documents.mjs` (KIND=grn)
// reads `linked_ac_grn_docnos` to decide what to create, so a longer list means
// that job would create more receipts next time it runs. That is the goods
// receipt lane's decision, not this one's, and the count is printed below so
// whoever owns it is deciding with a number.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: convergent. Same book, same union, same result.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 3);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));

/** The book's GR<-PO and PI<-GR edges, live documents only, in AutoCount's own
 *  numbering. Composition of PI<-GR with GR<-PO is what gives a PO its invoice
 *  list, and it is the same composition check-ac-convert-symmetry.mjs measures
 *  — deliberately, so what this writes is exactly what that reads. */
function bookEdges(edges) {
  const li = Object.fromEntries(edges.line_fields.map((n, i) => [n, i]));
  const hi = Object.fromEntries(edges.header_fields.map((n, i) => [n, i]));
  const cancelled = (t) => {
    const m = new Set();
    for (const r of edges.types[t].headers) if (r[hi.cancelled] === "T") m.add(String(r[hi.docNo]).trim());
    return m;
  };
  const deadPO = cancelled("PO"), deadGR = cancelled("GR"), deadPI = cancelled("PI");

  /* A receipt drawing on more than one purchase order yields one edge per
     order — 1,291 of 5,353 receipts do, and collapsing them to a single parent
     drops real edges. */
  const grParents = new Map();
  for (const r of edges.types.GR.lines) {
    if (r[li.fromDocType] !== "PO") continue;
    const from = String(r[li.fromDocNo] || "").trim();
    if (!from) continue;
    const gr = String(r[li.docNo]).trim();
    if (!grParents.has(gr)) grParents.set(gr, new Set());
    grParents.get(gr).add(from);
  }

  const byPo = new Map();
  const need = (p) => { if (!byPo.has(p)) byPo.set(p, { gr: new Set(), pi: new Set() }); return byPo.get(p); };
  for (const [gr, parents] of grParents) {
    if (deadGR.has(gr)) continue;
    for (const p of parents) if (!deadPO.has(p)) need(p).gr.add(gr);
  }
  let piNoParent = 0;
  for (const r of edges.types.PI.lines) {
    if (r[li.fromDocType] !== "GR") continue;
    const gr = String(r[li.fromDocNo] || "").trim();
    if (!gr) continue;
    const pi = String(r[li.docNo]).trim();
    if (deadPI.has(pi)) continue;
    const parents = grParents.get(gr);
    if (!parents) { piNoParent++; continue; }
    for (const p of parents) if (!deadPO.has(p)) need(p).pi.add(pi);
  }
  return { byPo, piNoParent };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const edges = gz("ac-convert-edges.json.gz");
  const ageDays = (Date.now() - Date.parse(edges.exported_at)) / 86_400_000;
  log(`book snapshot: ac-convert-edges.json.gz exported_at=${edges.exported_at} (${ageDays.toFixed(2)} days old), source=${edges.source}`);
  if (!(ageDays <= MAX_AGE_DAYS)) {
    /* The same refusal check-ac-convert-symmetry.mjs makes, for the same
       reason: a stale book answered confidently is how this job came to write
       a 2026-08-28 population onto a 2026-09-08 tree in the first place. */
    console.error(`REFUSED: the book snapshot is ${ageDays.toFixed(2)} days old, over MAX_SNAPSHOT_AGE_DAYS=${MAX_AGE_DAYS}. Re-cut it from the office network before stamping.`);
    await sql.end();
    process.exit(2);
  }

  const { byPo, piNoParent } = bookEdges(edges);
  const totalGr = [...byPo.values()].reduce((n, e) => n + e.gr.size, 0);
  const totalPi = [...byPo.values()].reduce((n, e) => n + e.pi.size, 0);
  log(`book: ${byPo.size} purchase orders carry a receipt; ${totalGr} GR<-PO edge(s), ${totalPi} composed PI<-PO edge(s); ${piNoParent} PI line(s) name a receipt that names no purchase order`);

  /* What the OLD source could see, printed so the regression is visible rather
     than a thing someone has to re-derive from the export SQL. */
  try {
    const refs = gz("ac-gr-refs.json.gz");
    const rGr = new Set(), rPi = new Set(), rPo = new Set();
    for (const r of refs) {
      const p = String(r.PoNo || "").trim(); if (p) rPo.add(p);
      if (r.GrNo) rGr.add(String(r.GrNo).trim());
      if (r.PiNo) rPi.add(String(r.PiNo).trim());
    }
    log(`for comparison, the OUTSTANDING cut this job used to read (ac-gr-refs.json.gz): ${rPo.size} purchase orders, ${rGr.size} receipt documents, ${rPi.size} purchase invoices`);
  } catch { log("ac-gr-refs.json.gz not readable — skipping the comparison line only; the stamp does not depend on it"); }

  const pos = await sql`SELECT id, po_number, linked_ac_docno, linked_ac_grn_docnos, linked_ac_pinv_docnos
    FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;

  const plan = [];
  let notImported = 0, addedGr = 0, addedPi = 0, grOnly = 0, piOnly = 0;
  const heldNotInBook = [];
  const seen = new Set(pos.map((p) => String(p.linked_ac_docno).trim()));
  for (const acPo of byPo.keys()) if (!seen.has(acPo)) notImported++;

  for (const p of pos) {
    const ac = String(p.linked_ac_docno).trim();
    const e = byPo.get(ac);
    const haveGr = (p.linked_ac_grn_docnos ?? []).map((x) => String(x).trim()).filter(Boolean);
    const havePi = (p.linked_ac_pinv_docnos ?? []).map((x) => String(x).trim()).filter(Boolean);

    /* Held but not recorded by the book. Printed, never dropped — see UNION
       above. The symmetry check reads 0 of these in both directions. */
    for (const g of haveGr) if (!e?.gr.has(g)) heldNotInBook.push(`GR ${g} <- ${ac} (${p.po_number})`);
    for (const i of havePi) if (!e?.pi.has(i)) heldNotInBook.push(`PI ${i} <- ${ac} (${p.po_number})`);

    if (!e) continue;
    const gr = [...new Set([...haveGr, ...e.gr])].sort();
    const pi = [...new Set([...havePi, ...e.pi])].sort();
    const dGr = gr.length - haveGr.length, dPi = pi.length - havePi.length;
    if (!dGr && !dPi) continue;
    addedGr += dGr; addedPi += dPi;
    if (dGr && !dPi) grOnly++;
    if (dPi && !dGr) piOnly++;
    plan.push({ id: p.id, po: p.po_number, ac, gr, pi, dGr, dPi });
  }

  log(`imported POs: ${pos.length}; to stamp: ${plan.length} (${grOnly} receipts only, ${piOnly} invoices only, ${plan.length - grOnly - piOnly} both)`);
  log(`edges this ADDS: ${addedGr} GR<-PO, ${addedPi} PI<-PO. AutoCount POs with a receipt that the ERP did not import: ${notImported} (out of cutover scope, correctly)`);
  log(`held by the ERP but NOT recorded in the book: ${heldNotInBook.length} — left exactly as they are`);
  for (const h of heldNotInBook.slice(0, 12)) log(`   held-not-in-book: ${h}`);
  for (const p of plan.slice(0, 12)) log(`   ${p.po} <- ${p.ac}: +${p.dGr} GR, +${p.dPi} PI -> GR ${p.gr.join(", ")}${p.pi.length ? "; PI " + p.pi.join(", ") : ""}`);
  if (plan.length > 12) log(`   ... and ${plan.length - 12} more`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write. Reference only: this creates no GRN and no stock movement."); await sql.end(); return; }
  for (const p of plan) {
    await sql`UPDATE scm.purchase_orders
      SET linked_ac_grn_docnos = ${p.gr}, linked_ac_pinv_docnos = ${p.pi}
      WHERE id = ${p.id}`;
  }
  log(`DONE. POs stamped: ${plan.length} (+${addedGr} GR, +${addedPi} PI). No GRN was created and no stock moved — by design.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
