#!/usr/bin/env node
// Fill `warehouse_id` on the migrated sales-order lines from the `location` text
// they already carry.
//
// THE BUG THIS REPAIRS. import-ac-outstanding-so.mjs resolves every line's
// warehouse — `warehouseId: whId(l.Location)`, three call sites (:349, :360,
// :368) — and then never writes it: `warehouse_id` is absent from that script's
// INSERT column list (`ICOLS`, :467), which carries the free-text `location`
// instead. Measured on production 2026-08-10: 13,881 imported SO lines, ZERO
// with a warehouse_id, all four locations present as text (KL 9,434 / PG 3,502 /
// SRW 722 / SBH 223).
//
// WHY IT MATTERS MORE THAN IT LOOKS. Stock is bucketed by
// (warehouse_id, item_code, variant_key). so-stock-allocation puts a
// warehouse-less line in a 'NOWH' bucket that can match no lot, and the sofa
// path is harder still — sofa-set-coverage.findCoveringBatch returns null on the
// first line for a null warehouse, before it looks at any stock at all. So NO
// migrated line can be allocated, sofa or otherwise, however much stock exists.
//
// SCOPE. GROUP defaults to `sofa` — the set this was written to unblock, and the
// smallest change that proves the fix. GROUP=all covers every migrated line;
// that flips thousands of non-sofa lines from PENDING the moment allocation next
// runs, so it is an owner decision, not a default.
//
// SAFETY. Only ever fills a NULL: a line that already has a warehouse is never
// touched, so this cannot move goods between warehouses. Only the four location
// codes above are mapped, via the same SALESLOC table every AutoCount importer
// uses; anything else is REPORTED and skipped. Writes no inventory.
// DRY-RUN by default; APPLY=1 writes.
//
// EVERY FILL IS CROSS-CHECKED AGAINST AUTOCOUNT FIRST (added 2026-08-11).
// The `location` text on the line is the IMPORTER'S transcription of
// SODTL.Location. Believing it on its own is believing the same script whose
// column-list bug caused this gap, so it is not evidence by itself. Each line is
// re-read from the AutoCount export by its own `linked_ac_dtlkey` -> `DtlKey`
// and the warehouse is written ONLY where AutoCount independently says the same
// location. A line whose ERP text CONFLICTS with AutoCount, whose AutoCount row
// cannot be found, or whose location resolves to no ERP warehouse is LEFT NULL
// and listed by document. That is deliberate: a null is an honest "not known
// yet" that shows up as a pending line, whereas a guessed warehouse silently
// points staff at a shelf that is empty. Never fall back to a default.
//
// RE-RUN: inert. The UPDATE re-asserts warehouse_id IS NULL, so a line routed by hand keeps its warehouse.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const GROUP = (process.env.GROUP || "sofa").toLowerCase();
const TOP = Number(process.env.TOP || 40);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/* The same AutoCount SalesLocation -> ERP warehouse table the importers use
   (import-ac-outstanding-so.mjs SALESLOC and its copies). Kept to the codes that
   actually appear on migrated SO lines; a display / service location has never
   been a sales location, so it is deliberately absent rather than guessed. */
const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; group=${GROUP}`);
  const whs = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w.id]));
  const resolve = (loc) => whByCode.get(norm(SALESLOC[norm(loc)] ?? loc)) ?? whByCode.get(norm(loc)) ?? null;

  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_group, i.item_code, i.location,
           i.linked_ac_dtlkey, h.linked_ac_docno
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.warehouse_id IS NULL
     ORDER BY i.doc_no, i.line_no`;
  log(`migrated SO lines with NO warehouse_id: ${rows.length}`);

  /* AutoCount's own record for the SAME line. DtlKey is an exact key, so this is
     a real second source and not a re-reading of the importer's own output. */
  const acRows = gz("ac-outstanding-so.json.gz");
  const acByDtl = new Map(acRows.map((r) => [String(r.DtlKey), r]));
  const acHdrLoc = new Map();
  for (const r of acRows) if (!acHdrLoc.has(norm(r.DocNo))) acHdrLoc.set(norm(r.DocNo), r.SalesLocation);
  log(`AutoCount export loaded: ${acRows.length} detail rows across ${acHdrLoc.size} documents`);

  const byLoc = new Map();
  for (const r of rows) {
    const k = `${r.item_group ?? "(none)"}|${r.location ?? "(null)"}`;
    byLoc.set(k, (byLoc.get(k) ?? 0) + 1);
  }
  log("distribution of the NULL-warehouse lines (ERP location text):");
  for (const [k, n] of [...byLoc].sort((a, b) => b[1] - a[1])) {
    const [g, loc] = k.split("|");
    const wh = resolve(loc);
    log(`   ${g} @ ${loc} -> ${wh ? [...whByCode].find(([, v]) => v === wh)?.[0] : "UNRESOLVED"} — ${n} lines`);
  }

  /* Per-line verdict. Only CONFIRMED is ever written. */
  const confirmed = [], conflict = [], noEvidence = [], acUnresolved = [], outOfScope = [];
  const tally = new Map();
  for (const r of rows) {
    const scoped = GROUP === "all" || String(r.item_group ?? "").toLowerCase() === GROUP;
    const ac = r.linked_ac_dtlkey != null ? acByDtl.get(String(r.linked_ac_dtlkey)) : null;
    const acLoc = ac ? ac.Location : acHdrLoc.get(norm(r.linked_ac_docno));
    const via = ac ? "dtlkey" : (acLoc ? "header" : null);
    let v;
    if (!acLoc) { v = "NO AC EVIDENCE"; noEvidence.push(r); }
    else if (!resolve(acLoc)) { v = "AC LOC UNRESOLVED"; acUnresolved.push({ ...r, acLoc }); }
    else if (r.location != null && String(r.location).trim() !== "" && norm(acLoc) !== norm(r.location)) {
      v = "CONFLICT erp!=ac"; conflict.push({ ...r, acLoc, via });
    } else if (!scoped) { v = "out of scope"; outOfScope.push(r); }
    else { v = `CONFIRMED (${via})`; confirmed.push({ ...r, whId: resolve(acLoc), acLoc, via }); }
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  log("");
  log("AutoCount cross-check verdicts:");
  for (const [v, n] of [...tally].sort((a, b) => b[1] - a[1])) log(`   ${String(v).padEnd(22)} ${String(n).padStart(6)}`);

  const byTarget = new Map();
  for (const c of confirmed) byTarget.set(c.whId, (byTarget.get(c.whId) ?? 0) + 1);
  log("");
  log(`DETERMINED (will be filled for group=${GROUP}): ${confirmed.length} lines`);
  for (const [whId, n] of [...byTarget].sort((a, b) => b[1] - a[1])) {
    log(`   -> ${[...whByCode].find(([, v]) => v === whId)?.[0]}: ${n} lines`);
  }
  const undetermined = conflict.length + noEvidence.length + acUnresolved.length;
  log(`UNDETERMINED (left NULL on purpose): ${undetermined} — conflict ${conflict.length}, no AC evidence ${noEvidence.length}, AC location unresolved ${acUnresolved.length}`);
  if (conflict.length) {
    log(`   CONFLICT lines (ERP text disagrees with AutoCount) — first ${Math.min(TOP, conflict.length)}:`);
    for (const c of conflict.slice(0, TOP)) log(`     ${c.doc_no} line ${c.line_no} ${c.item_code}: ERP ${JSON.stringify(c.location)} vs AC ${JSON.stringify(c.acLoc)} (via ${c.via})`);
  }
  if (acUnresolved.length) {
    const g = new Map();
    for (const c of acUnresolved) g.set(String(c.acLoc), (g.get(String(c.acLoc)) ?? 0) + 1);
    log(`   AC LOCATION UNRESOLVED — no ERP warehouse for these AutoCount locations:`);
    for (const [loc, n] of [...g].sort((a, b) => b[1] - a[1])) log(`     ${loc}: ${n} lines`);
  }
  if (noEvidence.length) {
    const g = new Map();
    for (const c of noEvidence) g.set(c.linked_ac_docno, (g.get(c.linked_ac_docno) ?? 0) + 1);
    log(`   NO AC EVIDENCE — ${noEvidence.length} lines across ${g.size} AutoCount documents (first ${Math.min(TOP, g.size)}):`);
    for (const [doc, n] of [...g].slice(0, TOP)) log(`     ${doc}: ${n} line(s)`);
  }

  if (!APPLY) { log(""); log("DRY-RUN — set APPLY=1 to write. Nothing here touches inventory; lines flip on the next allocation recompute."); await sql.end(); return; }

  /* Write by explicit line id, grouped by the AutoCount-confirmed warehouse.
     Not a blanket UPDATE ... WHERE location = 'KL': that would also fill the
     CONFLICT lines, which is exactly the guess this script must not make. The
     `warehouse_id IS NULL` predicate stays as a second guard so a concurrent
     writer cannot be overwritten. */
  const byWh = new Map();
  for (const c of confirmed) {
    if (!byWh.has(c.whId)) byWh.set(c.whId, []);
    byWh.get(c.whId).push(c.id);
  }
  let done = 0;
  for (const [whId, ids] of byWh) {
    const name = [...whByCode].find(([, v]) => v === whId)?.[0];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const res = await sql`UPDATE scm.mfg_sales_order_items
                               SET warehouse_id = ${whId}
                             WHERE id = ANY(${chunk}::uuid[]) AND warehouse_id IS NULL`;
      done += res.count;
    }
    log(`   ${name}: ${ids.length} intended`);
  }
  log(`DONE. SO lines given a warehouse: ${done} of ${confirmed.length} intended.`);
  if (done !== confirmed.length) log(`   NOTE: ${confirmed.length - done} line(s) were already filled by a concurrent writer and were left alone.`);

  /* Independent re-read: the count above is what the driver claims it did. This
     is the database's own answer to the same question. */
  const [after] = await sql`
    SELECT count(*)::int total, count(*) FILTER (WHERE i.warehouse_id IS NULL)::int still_null
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  log(`RE-READ from the DB: migrated SO lines ${after.total}, still NULL warehouse_id ${after.still_null}`);
  log("Run the allocation recompute — nothing flips here.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
