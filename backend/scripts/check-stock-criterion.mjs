#!/usr/bin/env node
// READ-ONLY census of the three structural gaps that hold back the owner's
// go-live criterion 3 (stock). SELECT only — no writes, no DDL, no transaction.
//
// WHY A SEPARATE SCRIPT RATHER THAN READING THE APPLY SCRIPTS' OWN OUTPUT.
// A script in this repo printed "APPLIED - stamped 146 sofa lines" three times
// while writing nothing. An apply script reporting on its own work is not
// evidence. This is a different code path with a different query set, run
// before and after every apply, so a number that did not actually land shows up
// as an unchanged census rather than as a confident log line.
//
// WHAT IT MEASURES
//   A  migrated SO lines and their warehouse_id, cross-checked line by line
//      against the AutoCount export (linked_ac_dtlkey -> DtlKey), so "the ERP
//      says KL" is only believed where AutoCount says KL for the same line.
//   B  per-line stock_status census by item_group — the acceptance test for the
//      sofa work (docs/stock-reconciliation.md 7.3 measured sofa 0 READY /
//      272 PENDING).
//   C  open sofa lots and how many carry a batch_no — findCoveringBatch matches
//      on batch_no alone, so a lot without one can never cover a set (D6).
//   D  ERP stock balance per warehouse — the dimension check-ac-vs-erp-reconcile
//      folds away by grouping on product_code alone.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const TOP = Number(process.env.TOP || 40);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* The AutoCount SalesLocation -> ERP warehouse table every AutoCount importer
   carries (import-ac-outstanding-so.mjs SALESLOC). Sales locations only: a
   display or service location has never been one, so it is deliberately absent
   rather than guessed. */
const SALESLOC = { KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE" };

const pad = (s, n) => String(s ?? "").padEnd(n);
const num = (s, n) => String(s ?? "").padStart(n);

async function main() {
  log("=== STOCK CRITERION CENSUS (read-only) ===");
  log(`taken: ${new Date().toISOString()}`);
  log("");

  const whs = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whById = new Map(whs.map((w) => [String(w.id), w.code]));
  const whByCode = new Map(whs.map((w) => [norm(w.code), String(w.id)]));
  const resolve = (loc) => whByCode.get(norm(SALESLOC[norm(loc)] ?? loc)) ?? whByCode.get(norm(loc)) ?? null;

  /* ── A. Migrated SO lines: warehouse_id, and the AutoCount evidence ─────── */
  log("---------------- A. MIGRATED SO LINE warehouse_id ----------------");
  const lines = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_group, i.item_code, i.location,
           i.warehouse_id, i.stock_status, i.linked_ac_dtlkey, i.cancelled,
           h.linked_ac_docno, h.proceeded_at
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  const withWh = lines.filter((l) => l.warehouse_id).length;
  log(`migrated SO lines total: ${lines.length}`);
  log(`  with a warehouse_id: ${withWh}`);
  log(`  with warehouse_id NULL: ${lines.length - withWh}`);

  const byLoc = new Map();
  for (const l of lines) {
    const k = `${String(l.location ?? "(null)")}|${l.warehouse_id ? "SET" : "NULL"}`;
    byLoc.set(k, (byLoc.get(k) ?? 0) + 1);
  }
  log("  by location text x warehouse_id:");
  for (const [k, n] of [...byLoc].sort((a, b) => b[1] - a[1])) {
    const [loc, state] = k.split("|");
    log(`    ${pad(loc, 12)} ${pad(state, 5)} ${num(n, 6)}  -> ${resolve(loc) ? whById.get(resolve(loc)) : "UNRESOLVED"}`);
  }

  /* The independent half: what does AutoCount say for the SAME line? The
     importer transcribed SODTL.Location into the ERP's `location` text, so
     believing that text on its own is believing the importer. linked_ac_dtlkey
     is an exact join back to AutoCount's own DtlKey. */
  let acRows = [];
  try { acRows = gz("ac-outstanding-so.json.gz"); } catch { log("  (ac-outstanding-so.json.gz missing — cross-check skipped)"); }
  if (acRows.length) {
    const acByDtl = new Map(acRows.map((r) => [String(r.DtlKey), r]));
    const acHdrLoc = new Map();
    for (const r of acRows) if (!acHdrLoc.has(norm(r.DocNo))) acHdrLoc.set(norm(r.DocNo), r.SalesLocation);
    const verdict = new Map();
    const conflicts = [], noEvidence = [];
    for (const l of lines) {
      if (l.warehouse_id) { verdict.set("ALREADY SET", (verdict.get("ALREADY SET") ?? 0) + 1); continue; }
      const ac = l.linked_ac_dtlkey != null ? acByDtl.get(String(l.linked_ac_dtlkey)) : null;
      const acLoc = ac ? ac.Location : acHdrLoc.get(norm(l.linked_ac_docno));
      const via = ac ? "dtlkey" : (acLoc ? "header" : null);
      let v;
      if (!acLoc) { v = "NO AC EVIDENCE"; noEvidence.push(l); }
      else if (!resolve(acLoc)) v = "AC LOC UNRESOLVED";
      else if (norm(acLoc) !== norm(l.location)) { v = "CONFLICT erp!=ac"; conflicts.push({ ...l, acLoc, via }); }
      else v = `CONFIRMED (${via})`;
      verdict.set(v, (verdict.get(v) ?? 0) + 1);
    }
    log("");
    log(`  AutoCount cross-check (${acRows.length} AC detail rows loaded):`);
    for (const [v, n] of [...verdict].sort((a, b) => b[1] - a[1])) log(`    ${pad(v, 22)} ${num(n, 6)}`);
    if (conflicts.length) {
      log(`  CONFLICT lines (ERP location text disagrees with AutoCount for the same line) — first ${Math.min(TOP, conflicts.length)}:`);
      for (const c of conflicts.slice(0, TOP)) log(`    ${c.doc_no} line ${c.line_no} ${c.item_code}: ERP ${JSON.stringify(c.location)} vs AC ${JSON.stringify(c.acLoc)} (via ${c.via})`);
    }
    if (noEvidence.length) {
      const g = new Map();
      for (const l of noEvidence) g.set(l.linked_ac_docno, (g.get(l.linked_ac_docno) ?? 0) + 1);
      log(`  NO AC EVIDENCE lines: ${noEvidence.length} across ${g.size} AutoCount documents — first ${Math.min(TOP, g.size)} docs:`);
      for (const [doc, n] of [...g].slice(0, TOP)) log(`    ${doc}: ${n} line(s)`);
    }
  }

  /* ── B. stock_status census — the acceptance test ───────────────────────── */
  log("");
  log("---------------- B. PER-LINE stock_status ----------------");
  /* IDENTICAL filter to check-ac-vs-erp-reconcile.mjs:62-66, which is the run
     docs/stock-reconciliation.md 7.3 tabulated (sofa 0 READY / 272 PENDING).
     A different filter here would produce a different baseline and the
     before/after comparison would measure the filter, not the repair. */
  const cen = await sql`
    SELECT COALESCE(i.item_group,'(none)') g, COALESCE(i.stock_status,'(null)') s, count(*)::int n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.proceeded_at IS NOT NULL
       AND COALESCE(i.cancelled,false) = false
       AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
     GROUP BY 1,2 ORDER BY 1,2`;
  const groups = [...new Set(cen.map((r) => r.g))].sort();
  const cell = (g, s) => cen.filter((r) => r.g === g && r.s === s).reduce((a, r) => a + r.n, 0);
  log("  PROCESSED, still-open orders — the set the allocator acts on (7.3 baseline):");
  log(`    ${pad("group", 12)}${num("READY", 8)}${num("PENDING", 9)}${num("PARTIAL", 9)}`);
  for (const g of groups) log(`    ${pad(g, 12)}${num(cell(g, "READY"), 8)}${num(cell(g, "PENDING"), 9)}${num(cell(g, "PARTIAL"), 9)}`);
  const [hdrs] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'READY_TO_SHIP')::int ready,
           COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int confirmed
      FROM scm.mfg_sales_orders
     WHERE company_id = 1 AND proceeded_at IS NOT NULL
       AND status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`  processed order headers: READY_TO_SHIP ${hdrs.ready}; CONFIRMED ${hdrs.confirmed}`);

  /* The lines the warehouse gap actually strands: PENDING, on a processed open
     order, with NO warehouse_id. These can never allocate whatever the stock. */
  const [stranded] = await sql`
    SELECT count(*)::int n, count(*) FILTER (WHERE i.item_group = 'sofa')::int sofa
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND h.proceeded_at IS NOT NULL
       AND COALESCE(i.cancelled,false) = false
       AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
       AND i.stock_status = 'PENDING' AND i.warehouse_id IS NULL`;
  log(`  PENDING lines with NO warehouse_id (cannot allocate at all): ${stranded.n} (sofa ${stranded.sofa})`);

  /* ── C. Sofa lots and their batch attribution (D6) ──────────────────────── */
  log("");
  log("---------------- C. OPEN SOFA LOTS / batch_no ----------------");
  /* A sofa lot is identified by the PRODUCT's category, the same predicate
     check-shipped-sofa-batch.mjs uses — not by the spelling of the code, which
     is the mistake that dropped AMN-SOFA PILLOW out of the old reconcile
     checker (docs/stock-reconciliation.md D7). */
  const lots = await sql`
    SELECT l.id, l.product_code, l.warehouse_id, l.batch_no, l.qty_remaining,
           l.source_doc_type, l.source_doc_no, l.variant_key
      FROM scm.inventory_lots l
      JOIN scm.mfg_products p ON p.code = l.product_code
                            AND p.company_id = COALESCE(l.company_id, 1)
     WHERE l.qty_remaining > 0 AND COALESCE(l.company_id, 1) = 1
       AND UPPER(COALESCE(p.category::text, '')) = 'SOFA'`;
  const batched = lots.filter((l) => l.batch_no != null && String(l.batch_no).trim() !== "");
  log(`open sofa lots: ${lots.length} (${lots.reduce((s, l) => s + Number(l.qty_remaining), 0)} units)`);
  log(`  carrying a batch_no: ${batched.length}`);
  log(`  batch_no NULL/blank: ${lots.length - batched.length}  <- findCoveringBatch can never match these`);
  const bySrc = new Map();
  for (const l of lots) bySrc.set(`${l.source_doc_type ?? "(null)"}/${batched.includes(l) ? "batched" : "unbatched"}`, (bySrc.get(`${l.source_doc_type ?? "(null)"}/${batched.includes(l) ? "batched" : "unbatched"}`) ?? 0) + 1);
  for (const [k, n] of [...bySrc].sort((a, b) => b[1] - a[1])) log(`    ${pad(k, 30)} ${num(n, 5)} lot(s)`);

  /* ── D. ERP balance per warehouse — the folded-away dimension ───────────── */
  log("");
  log("---------------- D. ERP BALANCE PER WAREHOUSE ----------------");
  const bal = await sql`
    SELECT warehouse_id, count(*)::int cells, SUM(qty)::int units
      FROM scm.inventory_balances
     WHERE COALESCE(company_id,1) = 1 AND qty <> 0
     GROUP BY 1 ORDER BY 3 DESC NULLS LAST`;
  log(`    ${pad("warehouse", 22)}${num("cells", 8)}${num("units", 9)}`);
  let tc = 0, tu = 0;
  for (const r of bal) {
    log(`    ${pad(whById.get(String(r.warehouse_id)) ?? `(unknown ${r.warehouse_id})`, 22)}${num(r.cells, 8)}${num(r.units, 9)}`);
    tc += r.cells; tu += r.units;
  }
  log(`    ${pad("TOTAL", 22)}${num(tc, 8)}${num(tu, 9)}`);
  log(`  warehouses holding non-zero stock: ${bal.length} of ${whs.length} defined`);

  log("");
  log("=== END CENSUS (nothing was written) ===");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
