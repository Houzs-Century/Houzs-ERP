#!/usr/bin/env node
// Give every migrated document the AutoCount number it came from.
//
// Owner 2026-08-10: "我们从 AutoCount 搬进来的东西全部 numbering 都跟着 AutoCount
// 的不是吗？" — yes, and the sales-order import and the outstanding-PO import
// have always done it. Two later importers did not: the SO-linked PO import and
// the migrated GR/DO generator minted fresh sequences, so PO-000596 arrived as
// HC-PO-009844 and nobody could find it by the number printed on the AutoCount
// document in their hand. That is the whole point of keeping the number.
//
// This renames what is already in the database. The importers were fixed at the
// same time, so a re-run cannot reintroduce it.
//
// A GRN belongs to ONE purchase order while an AutoCount receipt can span
// several, so a bare AC GR number is not always unique: where a receipt covers
// more than one imported PO the ERP number carries the PO as well. The number a
// human reads always starts from the AutoCount document.
//
// DRY-RUN by default; APPLY=1 renames. Refuses any rename that would collide.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const plan = [];   // { table, col, id, from, to }
  const clash = [];

  // ── purchase orders ────────────────────────────────────────────────────────
  const pos = await sql`SELECT id, po_number, linked_ac_docno FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const poTaken = new Set(pos.map((r) => r.po_number));
  for (const p of pos) {
    const want = "HC-" + p.linked_ac_docno;
    if (p.po_number === want) continue;
    if (poTaken.has(want)) { clash.push(`PO ${p.po_number} -> ${want} (taken)`); continue; }
    poTaken.delete(p.po_number); poTaken.add(want);
    plan.push({ table: "purchase_orders", col: "po_number", id: p.id, from: p.po_number, to: want });
  }

  // ── delivery orders (migrated only) — one AutoCount note = one ERP DO ───────
  const dos = await sql`SELECT id, do_number, linked_ac_docno FROM scm.delivery_orders
    WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL`;
  const doTaken = new Set((await sql`SELECT do_number FROM scm.delivery_orders WHERE company_id = ${CO}`).map((r) => r.do_number));
  for (const d of dos) {
    const want = "HC-" + d.linked_ac_docno;
    if (d.do_number === want) continue;
    if (doTaken.has(want)) { clash.push(`DO ${d.do_number} -> ${want} (taken)`); continue; }
    doTaken.delete(d.do_number); doTaken.add(want);
    plan.push({ table: "delivery_orders", col: "do_number", id: d.id, from: d.do_number, to: want });
  }

  // ── goods receipts (migrated only) — AC GR number, disambiguated by PO ──────
  const grns = await sql`SELECT g.id, g.grn_number, p.linked_ac_docno AS ac_po, p.linked_ac_grn_docnos AS ac_grs
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const grUse = new Map();
  for (const g of grns) for (const gr of (g.ac_grs ?? [])) grUse.set(gr, (grUse.get(gr) ?? 0) + 1);
  const grnTaken = new Set((await sql`SELECT grn_number FROM scm.grns WHERE company_id = ${CO}`).map((r) => r.grn_number));
  let noAcGr = 0;
  for (const g of grns) {
    const acGrs = g.ac_grs ?? [];
    if (!acGrs.length) { noAcGr++; continue; }   // no AutoCount receipt recorded: leave the sequence
    const want = (acGrs.length === 1 && grUse.get(acGrs[0]) === 1)
      ? "HC-" + acGrs[0]
      : "HC-" + acGrs[0] + "-" + g.ac_po;
    if (g.grn_number === want) continue;
    if (grnTaken.has(want)) { clash.push(`GRN ${g.grn_number} -> ${want} (taken)`); continue; }
    grnTaken.delete(g.grn_number); grnTaken.add(want);
    plan.push({ table: "grns", col: "grn_number", id: g.id, from: g.grn_number, to: want });
  }

  const byTable = new Map();
  for (const r of plan) byTable.set(r.table, (byTable.get(r.table) ?? 0) + 1);
  log(`to rename: ${plan.length} (${[...byTable].map(([t, n]) => `${t} ${n}`).join(", ") || "none"})`);
  log(`migrated GRNs with no AutoCount receipt number recorded (left on their sequence): ${noAcGr}`);
  for (const r of plan.slice(0, 15)) log(`   ${r.table}: ${r.from} -> ${r.to}`);
  if (plan.length > 15) log(`   ... and ${plan.length - 15} more`);
  if (clash.length) {
    log(`REFUSING ${clash.length} rename(s) that would collide with an existing number:`);
    for (const c of clash.slice(0, 10)) log(`   ${c}`);
  }
  if (!plan.length) { await sql.end(); return; }
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to rename. Only the document number changes; no link, quantity or stock is touched."); await sql.end(); return; }

  /* Renamed inside one transaction and in two passes: every row first moves to a
     parking name, then to its target. A direct rename can collide with a number
     another row in the SAME batch is about to vacate, and the unique index would
     abort the whole run on an ordering accident. */
  await sql.begin(async (tx) => {
    for (const r of plan) {
      await tx.unsafe(`UPDATE scm.${r.table} SET ${r.col} = $1 WHERE id = $2`, [`__renum__${r.id}`, r.id]);
    }
    for (const r of plan) {
      await tx.unsafe(`UPDATE scm.${r.table} SET ${r.col} = $1 WHERE id = $2`, [r.to, r.id]);
    }
  });
  log(`DONE. renamed: ${plan.length}. Numbers now match the AutoCount documents they came from.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
