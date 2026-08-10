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
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const refs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-gr-refs.json.gz"))).toString("utf8"));
  const byPo = new Map();
  for (const r of refs) {
    if (!byPo.has(r.PoNo)) byPo.set(r.PoNo, { gr: new Set(), pi: new Set() });
    const e = byPo.get(r.PoNo);
    if (r.GrNo) e.gr.add(r.GrNo);
    if (r.PiNo) e.pi.add(r.PiNo);
  }
  log(`AutoCount receipts in the snapshot: ${refs.length} rows / ${byPo.size} POs / ${new Set(refs.map((r) => r.GrNo)).size} GR docs / ${new Set(refs.filter((r) => r.PiNo).map((r) => r.PiNo)).size} PI docs`);

  const pos = await sql`SELECT id, po_number, linked_ac_docno, linked_ac_grn_docnos
    FROM scm.purchase_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const plan = [];
  let notImported = 0;
  const seen = new Set(pos.map((p) => p.linked_ac_docno));
  for (const [acPo] of byPo) if (!seen.has(acPo)) notImported++;
  for (const p of pos) {
    const e = byPo.get(p.linked_ac_docno);
    if (!e || !e.gr.size) continue;
    const gr = [...e.gr].sort();
    const already = (p.linked_ac_grn_docnos ?? []).slice().sort();
    if (already.length === gr.length && already.every((v, i) => v === gr[i])) continue;
    plan.push({ id: p.id, po: p.po_number, ac: p.linked_ac_docno, gr, pi: [...e.pi].sort() });
  }
  log(`imported POs: ${pos.length}; to stamp: ${plan.length}; AutoCount POs with a receipt that are NOT imported: ${notImported}`);
  for (const p of plan.slice(0, 12)) log(`   ${p.po} <- ${p.ac}: GR ${p.gr.join(", ")}${p.pi.length ? "; PI " + p.pi.join(", ") : ""}`);
  if (plan.length > 12) log(`   ... and ${plan.length - 12} more`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write. Reference only: this creates no GRN and no stock movement."); await sql.end(); return; }
  for (const p of plan) {
    await sql`UPDATE scm.purchase_orders
      SET linked_ac_grn_docnos = ${p.gr}, linked_ac_pinv_docnos = ${p.pi}
      WHERE id = ${p.id}`;
  }
  log(`DONE. POs stamped: ${plan.length}. No GRN was created and no stock moved — by design.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
