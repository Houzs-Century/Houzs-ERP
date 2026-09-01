#!/usr/bin/env node
// Open the AutoCount sofa stock into the ERP — the ONE cell of the balance
// snapshot that W4/W5 deliberately skipped.
//
// WHY THIS EXISTS. import-ac-stock-balance.mjs filters `!isSofa(ItemCode)`
// (:54) and import-ac-stock-layers.mjs does the same (:50), so not a single
// sofa unit came in with the 2026-08-09 opening. AutoCount holds 76 whole sofas
// (ac-stock-balance.json.gz, SOFA PILLOW excluded — that is a plain accessory,
// see the report at the end); the ERP holds a handful of legacy ones, and every
// sofa sales-order line reads PENDING because there is nothing to allocate.
//
// WHY IT CANNOT JUST RUN THE BALANCE IMPORT WITH THE FILTER REMOVED.
// AutoCount tracks a sofa as ONE unit of one model ("AMN-SF9028 SOFA" x 6); the
// ERP tracks it per COMPARTMENT ({model}-1A(LHF), -CNR, -2A(RHF)...). A balance
// row carries a quantity and nothing else — no configuration, no serial, no
// batch (measured: 0 of 1,337 sofa GRDTL lines in AED_HOUZS carry SerialNoList
// or BatchNo). Six units of a model are six DIFFERENT builds and the snapshot
// cannot say which six. Decomposing a balance row would be inventing stock.
//
// SO THIS DRIVES OFF THE DOCUMENTS INSTEAD. Every on-hand sofa is made to
// order: 94 of the 97 AutoCount GR lines behind the current balance were raised
// from a customer SO line (PODTL.FromSODtlKey). Those POs are already in the
// ERP — import-ac-so-linked-pos.mjs imported them WITH `received_qty`, already
// decomposed into compartment lines by the shared parse-sofa decoder, already
// dedicated to their SO line. That is a real, per-build, per-compartment record
// of what physically came in. This script turns it into stock:
//
//   one imported sofa PO line with received_qty > 0
//     -> received_qty units of that compartment SKU
//        at the PO line's warehouse
//        with batch_no = that PO's own po_number
//
// batch_no = the PO number is not a convention invented here: it is what a GRN
// would have stamped (grns.ts resolvePoBatchByItem -> purchase_orders.po_number,
// migration 0120), it is what sofa-set-coverage.ts documents as the batch
// identity ("batch_no = source PO number = one dye lot"), and it is what
// source-po-trace.ts renders as the Source PO chip. Every compartment of one
// build shares it, so findCoveringBatch sees ONE batch covering the whole set.
//
// THE HARD CAP. AutoCount's balance is still the authority on HOW MANY exist.
// Builds are capped per AutoCount item code at the snapshot quantity (summed
// across locations, because a received sofa is routinely moved KL<->PG<->DISPLAY
// and the location drift is not evidence that the unit does not exist). Anything
// over the cap is DROPPED and printed with its PO and SO, never rounded away.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - never decomposes a balance row (see above)
//   - never creates stock for a build the decoder could not read (the
//     `SOFA UNPARSED` placeholder lines): a lot of {model}-1S standing for a
//     physical 2-seater is a wrong stock number, and a wrong number is worse
//     than a missing one. Pass PLACEHOLDER=1 to include them once a human has
//     decided. They are counted and listed either way.
//   - never creates the showroom display sofas (no PO, no configuration,
//     AutoCount Desc2 literally "DISPLAY REF: ADJ0052/00148"). Reported only.
//
// Idempotent: a (product, warehouse, batch, variant) that already carries an
// AC_CUTOVER sofa lot is skipped, so re-running tops up rather than doubles.
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const PLACEHOLDER = process.env.PLACEHOLDER === "1";
const SRC_DOC = process.env.SRC_DOC || "AC-BAL-SOFA-2026-08-10";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
/* A calendar day as YYYY-MM-DD, from either a pg `Date` or a string.
   `String(d).slice(0,10)` is WRONG on a Date: the postgres driver hands back a
   JS Date whose toString() is "Wed Jun 24 2026 08:00:00 GMT+0800", so slicing
   ten characters yields "Wed Jun 24". That value reached the INSERT as
   'Wed Jun 24T00:00:00Z' and aborted the first APPLY run (2026-08-11). */
const isoDay = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  if (m) return m[1];
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* A sofa SET, not a sofa-shaped accessory. `AMN-SOFA PILLOW` matches /SOFA/ and
   is a plain ACCESSORY in the mapping table — it has no compartments and does
   not belong to this import (it is missing from the ERP for the same reason and
   is reported at the end so it is not lost). */
const isSofaSet = (c) => /SOFA/i.test(c || "") && !/PILLOW/i.test(c || "");

/* MIRROR of sofa-set-coverage.ts findCoveringBatch, for the READ-ONLY "how many
   sets would become allocatable" projection at the end. Report path only — the
   engine's own copy stays the single source of truth for allocation. */
function coveringBatch(lines, remaining, batches) {
  const need = new Map();
  for (const ln of lines) {
    const k = `${ln.itemCode}|${ln.variantKey}`;
    need.set(k, { itemCode: ln.itemCode, variantKey: ln.variantKey, need: (need.get(k)?.need ?? 0) + ln.need });
  }
  for (const b of [...batches].sort()) {
    let all = true;
    for (const r of need.values()) {
      if ((remaining.get(`${r.itemCode}|${r.variantKey}|${b}`) ?? 0) < r.need) { all = false; break; }
    }
    if (all) return b;
  }
  return null;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${PLACEHOLDER ? " (+placeholder builds)" : ""}; source_doc_no=${SRC_DOC}`);

  /* ── 1. AutoCount's authority on HOW MANY sofas exist ───────────────────── */
  const bal = gz("ac-stock-balance.json.gz").filter((r) => r.BalQty !== 0 && isSofaSet(r.ItemCode));
  const balByItem = new Map();
  const balByCell = new Map();
  for (const r of bal) {
    const q = Math.round(r.BalQty);
    balByItem.set(norm(r.ItemCode), (balByItem.get(norm(r.ItemCode)) ?? 0) + q);
    balByCell.set(`${norm(r.ItemCode)}|${norm(r.Location)}`, q);
  }
  const balUnits = [...balByItem.values()].reduce((s, n) => s + n, 0);
  log(`AutoCount balance (whole sofas, PILLOW excluded): ${balUnits} units across ${balByCell.size} item x location cells / ${balByItem.size} item codes`);

  /* ── 2. The ERP's imported sofa PO lines that carry received goods ──────── */
  const poLines = await sql`
    SELECT i.id, i.purchase_order_id, i.item_code, i.material_name, i.supplier_sku,
           i.description2, i.notes, i.received_qty, i.qty, i.unit_price_sen,
           i.item_group, i.variants, i.warehouse_id, i.so_item_id,
           p.po_number, p.linked_ac_docno, p.po_date
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1
       AND p.linked_ac_docno IS NOT NULL
       AND i.item_group = 'sofa'
       AND i.received_qty > 0
     ORDER BY p.linked_ac_docno, i.id`;
  log(`imported sofa PO lines with received_qty > 0: ${poLines.length} across ${new Set(poLines.map((l) => l.linked_ac_docno)).size} AutoCount POs`);
  if (poLines.length === 0) {
    log("NOTHING TO DO — no imported sofa PO carries received goods. Either the SO-linked PO import has not been run for sofa, or it is still half-finished (cutover ledger section 5 item 1). Run 'Import SO-linked POs' first.");
    await sql.end();
    return;
  }

  /* ── 3. Group the lines back into BUILDS ────────────────────────────────
     One AutoCount sofa line = one build = several ERP compartment lines. The
     importer wrote the AutoCount item code + compartment into supplier_sku
     ("AMN-SF9028 SOFA 1A(LHF)") and the AutoCount Desc2 into description2, so a
     build is recoverable as (PO, AutoCount item code, Desc2). Two identical
     builds on one PO with identical text collapse into one group — that is
     correct: they are the same SKU/variant/batch, so they pool anyway. */
  const acItemOf = (l) => {
    const s = String(l.supplier_sku ?? "");
    const hit = [...balByItem.keys()].find((k) => norm(s).startsWith(k));
    return hit ?? norm(s);
  };
  const builds = new Map();
  for (const l of poLines) {
    const ac = acItemOf(l);
    const k = `${l.linked_ac_docno}|${ac}|${String(l.description2 ?? "").slice(0, 200)}`;
    if (!builds.has(k)) {
      builds.set(k, {
        key: k, acItem: ac, acPo: l.linked_ac_docno, poNumber: l.po_number,
        poDate: isoDay(l.po_date), lines: [],
      });
    }
    builds.get(k).lines.push(l);
  }
  /* A build whose decode failed carries the importer's own signature. Its lines
     are a {model}-1S placeholder standing for a physically different sofa. */
  for (const b of builds.values()) {
    b.placeholder = b.lines.some((l) => /SOFA UNPARSED/i.test(String(l.notes ?? "")));
    b.units = Math.max(...b.lines.map((l) => Math.min(Number(l.received_qty), Number(l.qty) || Number(l.received_qty))));
    b.noWh = b.lines.some((l) => !l.warehouse_id);
  }
  const allBuilds = [...builds.values()];
  log(`builds reconstructed: ${allBuilds.length} (${allBuilds.filter((b) => b.placeholder).length} placeholder / SOFA UNPARSED, ${allBuilds.filter((b) => b.noWh).length} with a line missing a warehouse)`);

  /* ── 4. Cap against the AutoCount balance, per item code ─────────────────
     Newest PO first, so an over-subscribed item drops its most recent receipt —
     the same "newest backwards until the balance is covered" convention the
     FIFO re-layering (W5) already used, and the one the balance itself is a
     snapshot of. Every drop is printed. */
  const ordered = allBuilds.slice().sort((a, b) =>
    (b.poDate ?? "").localeCompare(a.poDate ?? "") || String(b.acPo).localeCompare(String(a.acPo)));
  const usedByItem = new Map();
  const accepted = [], droppedCap = [], droppedPh = [], droppedWh = [];
  for (const b of ordered) {
    if (b.noWh) { droppedWh.push(b); continue; }
    if (b.placeholder && !PLACEHOLDER) { droppedPh.push(b); continue; }
    const cap = balByItem.get(b.acItem) ?? 0;
    const used = usedByItem.get(b.acItem) ?? 0;
    if (used + b.units > cap) { droppedCap.push({ ...b, cap, used }); continue; }
    usedByItem.set(b.acItem, used + b.units);
    accepted.push(b);
  }
  log(`builds accepted: ${accepted.length}; dropped — over AutoCount balance ${droppedCap.length}, placeholder ${droppedPh.length}, no warehouse ${droppedWh.length}`);
  for (const b of droppedCap) log(`   DROP over-balance: ${b.acItem} build from ${b.acPo} (${b.poNumber}) — AutoCount holds ${b.cap}, already covered ${b.used}`);
  for (const b of droppedPh) log(`   DROP placeholder: ${b.acItem} from ${b.acPo} (${b.poNumber}) — ${String(b.lines[0].description2 ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
  for (const b of droppedWh) log(`   DROP no-warehouse: ${b.acItem} from ${b.acPo} (${b.poNumber})`);

  /* AutoCount units the documents cannot account for — display sofas and the
     receipts whose SO has since been delivered. Reported, never invented. */
  const unbacked = [];
  for (const [item, qty] of balByItem) {
    const covered = usedByItem.get(item) ?? 0;
    if (covered < qty) unbacked.push({ item, qty, covered });
  }
  const unbackedUnits = unbacked.reduce((s, u) => s + (u.qty - u.covered), 0);
  log(`AutoCount units with NO received-PO document behind them: ${unbackedUnits} (showroom display + already-delivered receipts) — not created, listed below`);
  for (const u of unbacked) log(`   unbacked: ${u.item} — AutoCount ${u.qty}, documented ${u.covered}`);

  /* ── 5. Cost + receipt date, per build ──────────────────────────────────
     NOT from the PO line: AutoCount does not price a sofa PO (measured, live —
     121 of the 122 sofa PODTL.UnitPrice are NULL; Houzs prices a sofa on the
     purchase INVOICE). The real number is the one W5 already reconstructed:
     ac-stock-layers.json.gz holds the actual cost and receipt date of every
     receipt behind the on-hand balance, keyed by GR document. ac-sofa-gr-po
     supplies the missing hop, GR line -> its source PO, so a build priced by
     its PO gets what that receipt actually cost. Ambiguous (a PO whose receipts
     disagree) or missing -> 0 and REPORTED, never averaged into a plausible
     number. The build's cost rides its LEAD compartment and the rest carry 0,
     the same convention the SO/PO import uses to keep a set's total exact. */
  const layers = gz("ac-stock-layers.json.gz").filter((l) => isSofaSet(l.ItemCode));
  const grPo = gz("ac-sofa-gr-po.json.gz");
  const poByGr = new Map();
  for (const g of grPo) {
    if (!g.PoNo) continue;
    poByGr.set(`${norm(g.GrNo)}|${norm(g.ItemCode)}|${norm(g.Location)}`, g.PoNo);
  }
  const costByAcPo = new Map();
  for (const l of layers) {
    const po = poByGr.get(`${norm(l.SrcDoc)}|${norm(l.ItemCode)}|${norm(l.Location)}`);
    if (!po) continue;
    const cur = costByAcPo.get(po);
    const cost = Number(l.Cost ?? 0);
    if (cur === undefined) costByAcPo.set(po, { cost, date: l.Date ?? null });
    else if (cur.cost !== cost) cur.ambiguous = true;
  }
  let costed = 0, costAmbiguous = 0, costMissing = 0;

  /* ── 6. The lots to write ───────────────────────────────────────────────── */
  const plan = [];
  for (const b of accepted) {
    const c = costByAcPo.get(b.acPo);
    const costSen = c && !c.ambiguous && c.cost > 0 ? Math.round(c.cost * 100) : 0;
    if (costSen > 0) costed++;
    else if (c && c.ambiguous) costAmbiguous++;
    else costMissing++;
    let lead = true;
    for (const l of b.lines) {
      plan.push({
        code: l.item_code,
        name: l.material_name ?? l.item_code,
        whId: l.warehouse_id,
        batch: l.po_number,
        variantKey: variantKeyMirror(l.item_group, l.variants),
        qty: b.units,
        costSen: lead ? costSen : 0,
        acPo: b.acPo,
        soItemId: l.so_item_id,
        receivedAt: isoDay(c && c.date) || b.poDate,
      });
      lead = false;
    }
  }
  log(`build cost from the AutoCount receipt (layers -> GR -> PO): priced ${costed}; receipts disagree (left at 0) ${costAmbiguous}; no receipt cost found ${costMissing}`);
  log("  a build with no exact receipt cost is left at 0 rather than averaged into a plausible number — ac-last-purchase-costs.json.gz covers 44 sofa item codes and backfill-zero-cost-lots.mjs is the tool that owns that fallback (cutover ledger section 5 item 4). Run it after this.");
  /* Idempotency: this exact (code, warehouse, batch, variant) already opened by
     a previous run of this script is skipped. batch_no makes the key unique per
     build, so a top-up run adds only what is genuinely new. */
  const existing = new Set(
    (await sql`SELECT item_code, warehouse_id, batch_no, COALESCE(variant_key,'') vk
                 FROM scm.inventory_lots
                WHERE source_doc_type = 'AC_CUTOVER' AND source_doc_no = ${SRC_DOC}`)
      .map((r) => `${norm(r.item_code)}|${r.warehouse_id}|${r.batch_no}|${r.vk}`),
  );
  const todo = plan.filter((p) => !existing.has(`${norm(p.code)}|${p.whId}|${p.batch}|${p.variantKey}`));
  const skipped = plan.length - todo.length;
  const units = todo.reduce((s, p) => s + p.qty, 0);
  const zeroCost = todo.filter((p) => p.costSen === 0).length;
  log("");
  log(`LOTS TO CREATE: ${todo.length} lots / ${units} units across ${new Set(todo.map((p) => p.batch)).size} batches (already opened by an earlier run: ${skipped}; zero-cost lots: ${zeroCost} — the non-lead compartments carry 0 by design, the build's price rides its lead piece)`);
  for (const p of todo.slice(0, 30)) log(`   +${p.qty} ${p.code} [${p.variantKey || "no-variant"}] batch ${p.batch} (AC ${p.acPo}) cost ${p.costSen / 100} RM`);
  if (todo.length > 30) log(`   ... and ${todo.length - 30} more`);

  /* ── 7. Projection: how many sofa SO lines this would make allocatable ────
     Run TWICE. As-is, and again with every sofa SO line's warehouse resolved
     from the `location` text it already carries, because the second blocker is
     not stock at all: NO imported sales-order line has a warehouse_id (see the
     backfill script beside this one), and findCoveringBatch returns null for a
     null warehouse whatever the stock says. Reporting only the first number
     would hide the reason this import alone changes nothing. */
  const whRows = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(whRows.map((w) => [norm(w.code), w.id]));
  const LOC = { KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE" };
  const whFromLoc = (loc) => whByCode.get(norm(LOC[norm(loc)] ?? loc)) ?? whByCode.get(norm(loc)) ?? null;

  const soLines = await sql`
    SELECT i.id, i.doc_no, i.item_code, i.item_group, i.variants, i.qty, i.warehouse_id, i.location, i.stock_status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.item_group = 'sofa' AND i.stock_status = 'PENDING'`;
  const noWhLines = soLines.filter((l) => !l.warehouse_id).length;
  log("");
  log(`sofa SO lines currently PENDING: ${soLines.length} (${noWhLines} of them carry NO warehouse_id — those can never allocate, whatever the stock)`);

  const project = (useLocation) => {
    const remaining = new Map();
    const batches = new Set();
    for (const p of todo) {
      const k = `${p.code}|${p.variantKey}|${p.batch}`;
      remaining.set(k, (remaining.get(k) ?? 0) + p.qty);
      batches.add(p.batch);
    }
    const whByBatch = new Map(todo.map((p) => [p.batch, p.whId]));
    const whOf = (l) => l.warehouse_id ?? (useLocation ? whFromLoc(l.location) : null);
    const sets = new Map();
    for (const l of soLines) {
      const k = `${whOf(l) ?? "NOWH"}|${l.doc_no}`;
      if (!sets.has(k)) sets.set(k, []);
      sets.get(k).push(l);
    }
    let setsCovered = 0, linesCovered = 0;
    const docs = [];
    for (const group of sets.values()) {
      const whId = whOf(group[0]);
      if (!whId) continue;
      const cands = new Set([...batches].filter((b) => String(whByBatch.get(b)) === String(whId)));
      if (cands.size === 0) continue;
      const lines = group.map((l) => ({
        itemCode: l.item_code, variantKey: variantKeyMirror(l.item_group, l.variants), need: Number(l.qty ?? 0),
      }));
      const batch = coveringBatch(lines, remaining, cands);
      if (batch) {
        setsCovered++; linesCovered += group.length;
        docs.push(`${group[0].doc_no} -> ${batch}`);
        for (const ln of lines) {
          const kk = `${ln.itemCode}|${ln.variantKey}|${batch}`;
          remaining.set(kk, Math.max(0, (remaining.get(kk) ?? 0) - ln.need));
        }
      }
    }
    return { setsCovered, linesCovered, docs };
  };

  const now = project(false);
  log(`PROJECTION A — this import alone: ${now.setsCovered} sofa sets / ${now.linesCovered} PENDING sofa SO lines would go READY`);
  const withWh = project(true);
  log(`PROJECTION B — this import PLUS the SO-line warehouse backfill: ${withWh.setsCovered} sofa sets / ${withWh.linesCovered} PENDING sofa SO lines would go READY`);
  for (const d of withWh.docs.slice(0, 40)) log(`   ${d}`);
  if (withWh.docs.length > 40) log(`   ... and ${withWh.docs.length - 40} more`);
  log("(projection mirrors sofa-set-coverage.findCoveringBatch; the real flip happens on the next allocation recompute)");

  /* ── 8. The accessory this import does NOT cover ─────────────────────────── */
  /* The balance importer excludes sofa FURNITURE by the binding CSV's CATEGORY
     since the 2026-08-10 pillow incident — a code merely SPELLING "SOFA" is not
     excluded. So a pillow is only at risk when its CSV row is categorised
     SOFA. The previous message here claimed 128 units "absent from the ERP"
     without ever reading the ERP, blaming a /SOFA/ filter that no longer
     exists — measured wrong on 2026-08-28: those 128 units had imported fine
     (a delta re-run showed 0 cells left to write). Warn only on the real case. */
  const pillow = gz("ac-stock-balance.json.gz").filter((r) => r.BalQty !== 0 && /SOFA/i.test(r.ItemCode) && /PILLOW/i.test(r.ItemCode));
  // same parser + column as import-ac-stock-balance.mjs — names contain quoted commas
  const parseCsvLine = (line) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
    out.push(cur); return out;
  };
  const sofaCodes = new Set(
    fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
      .split(/\r?\n/).slice(1).map(parseCsvLine)
      .filter((f) => (f[3] || "").trim().toUpperCase() === "SOFA")
      .map((f) => norm(f[0])),
  );
  const misCat = pillow.filter((r) => sofaCodes.has(norm(r.ItemCode)));
  if (misCat.length) {
    const pu = misCat.reduce((s, r) => s + Math.round(r.BalQty), 0);
    log("");
    log(`SEPARATE FINDING — ${pu} unit(s) of ${new Set(misCat.map((r) => r.ItemCode)).size} pillow code(s) are categorised SOFA in the mapping CSV, so the balance import EXCLUDES them as furniture. Fix the CSV category to ACC and re-run the balance import (delta-based, it tops up).`);
  }

  if (!APPLY) { log(""); log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  /* ── 9. Write ───────────────────────────────────────────────────────────── */
  const mvCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  const hasCo = mvCols.includes("company_id");
  let done = 0;
  for (const p of todo) {
    /* Every value is BOUND, not interpolated. The previous version pasted the
       date straight into the SQL text as `'${p.receivedAt}T00:00:00Z'`, which is
       how a `Date` object that stringified to "Wed Jun 24" became the literal
       `'Wed Jun 24T00:00:00Z'` and aborted the run on its first insert. */
    const cols = ["movement_type", "warehouse_id", "item_code", "product_name", "variant_key",
      "qty", "unit_cost_sen", "batch_no", "source_doc_type", "source_doc_no", "notes"];
    const args = ["ADJUSTMENT", p.whId, p.code, p.name, p.variantKey, p.qty, p.costSen, p.batch,
      "AC_CUTOVER", SRC_DOC, `AutoCount sofa opening: ${p.acPo} received, batch ${p.batch}`];
    if (p.receivedAt) { cols.push("created_at"); args.push(`${p.receivedAt}T00:00:00Z`); }
    if (hasCo) { cols.push("company_id"); args.push(1); }
    await sql.unsafe(
      `INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      args);
    done++;
    if (done % 25 === 0) log(`  ..${done}/${todo.length}`);
  }
  log(`DONE. sofa opening lots written: ${done} / ${units} units.`);
  log("Run the allocation recompute afterwards — the lines flip on the next allocation pass, not here.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
