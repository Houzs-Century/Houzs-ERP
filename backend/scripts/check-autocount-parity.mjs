#!/usr/bin/env node
// Compare the ERP against AutoCount on the four things the owner asked for
// (2026-08-10), after he told us where AutoCount actually keeps them:
//
//   "我的 Remark 2 其实就是 Stock Status ... ACC 代表 Accessories Ready,
//    Mattress 代表 Mattress Ready"
//
//   1. PO document number  — SO.UDF_ToPONo vs the PO the ERP raised for that order
//   2. Stock status        — SO.Remark2 vs the ERP's per-line stock_status
//   3. Balance             — SO.UDF_BALANCE vs the ERP's outstanding balance
//   4. Document flow       — SO -> PO -> GR chain on both sides
//
// Remark2 is FREE TEXT a human types, so it is read generously: the words in it
// name the CATEGORIES that are ready. "BEDFRAME/ACC" means bedframe and
// accessories are ready; "READY" means the whole order is; "READY (PARTIAL)"
// means some of it is. Only 404 of 2,710 outstanding orders carry one at all, so
// a blank is not a disagreement - it is a question AutoCount never answered, and
// this reports it as such rather than scoring it.
//
// Read-only.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* Which ERP item_groups a Remark2 phrase claims are ready. A phrase can name
   several ("BEDFRAME/ACC"). READY claims the whole order; READY (PARTIAL) claims
   only that something is, which no per-category comparison can falsify, so it is
   counted apart rather than scored. */
function claimedGroups(remark) {
  const r = (remark || "").toUpperCase();
  if (!r) return null;
  if (/PARTIAL/.test(r)) return { partial: true, groups: [] };
  const groups = [];
  if (/\bACC\b/.test(r)) groups.push("accessory");
  if (/BEDFRAME|B\/?FRAME/.test(r)) groups.push("bedframe");
  if (/MATTRESS|MATT\b/.test(r)) groups.push("mattress");
  if (/\bSOFA\b/.test(r)) groups.push("sofa");
  if (/^READY$|^READY\b/.test(r) && !groups.length) return { all: true, groups: [] };
  return groups.length ? { groups } : { unreadable: r };
}

async function main() {
  const acStatus = gz("ac-so-status.json.gz");
  const byAcDoc = new Map(acStatus.map((r) => [r.DocNo, r]));

  // ── ERP side: per order, the stock status of each item group ───────────────
  const lines = await sql`SELECT h.linked_ac_docno ac, h.doc_no, i.item_group, i.stock_status,
      COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
      AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
    GROUP BY 1,2,3,4`;
  const erp = new Map();   // ac doc -> { group -> {READY:n, PENDING:n, ...} }
  for (const r of lines) {
    if (!erp.has(r.ac)) erp.set(r.ac, { doc: r.doc_no, g: new Map() });
    const g = erp.get(r.ac).g;
    if (!g.has(r.item_group)) g.set(r.item_group, {});
    g.get(r.item_group)[r.stock_status ?? "(null)"] = r.n;
  }
  const groupReady = (e, group) => {
    const s = e.g.get(group);
    if (!s) return null;                       // that order has no line of this group
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    return (s.READY ?? 0) === total;
  };

  log("═══ 2. STOCK STATUS — AutoCount Remark2 vs the ERP ═══");
  let agree = 0, disagree = 0, noLines = 0, partial = 0, unreadable = 0;
  const misses = [];      // full set, uncapped — the printout is capped, the analysis is not
  for (const r of acStatus) {
    const claim = claimedGroups(r.Remark2);
    if (!claim) continue;                       // blank: AutoCount never said
    if (claim.unreadable) { unreadable++; continue; }
    const e = erp.get(r.DocNo);
    if (!e) { noLines++; continue; }
    if (claim.partial) { partial++; continue; }
    const groups = claim.all ? [...e.g.keys()].filter((g) => g !== "service") : claim.groups;
    const bad = [];
    for (const g of groups) {
      const ready = groupReady(e, g);
      if (ready === null) continue;             // AutoCount named a group this order has none of
      if (!ready) bad.push(g);
    }
    if (bad.length) {
      disagree++;
      misses.push({ ac: r.DocNo, erp: e.doc, remark: r.Remark2, bad: bad.slice(), detail: [...e.g.entries()].map(([g, s]) => `${g}:${Object.entries(s).map(([k, v]) => k + "=" + v).join("/")}`).join(" | ") });
    } else agree++;
  }
  log(`orders where AutoCount states a status: ${acStatus.filter((r) => r.Remark2).length} of ${acStatus.length}`);
  log(`   ERP agrees: ${agree}`);
  log(`   ERP DISAGREES: ${disagree}`);
  log(`   "READY (PARTIAL)" - not falsifiable per category, counted apart: ${partial}`);
  log(`   order not in the ERP as an open order: ${noLines}; phrase not understood: ${unreadable}`);
  for (const m of misses.slice(0, 25)) log(`   ${m.ac} (${m.erp}) says "${m.remark}" but ${m.bad.join(",")} is not all READY -> ${m.detail}`);

  /* ── LENS (B): which item_group actually blocks each disagreement ───────────
     Several of these look like a CLASSIFICATION problem rather than a stock
     problem: a delivery charge or a free gift sitting in item_group 'others'
     counts toward readiness and can never BE ready, so the order can never
     agree with AutoCount no matter what the warehouse does. Report which group
     blocks, and name the exact item codes in 'others'/'service' so the owner can
     decide whether they should count at all. This lens only REPORTS. */
  log("");
  log("   ── which item_group blocks the disagreement ──");
  const blockHist = new Map(), comboHist = new Map();
  for (const m of misses) {
    for (const g of m.bad) blockHist.set(g, (blockHist.get(g) ?? 0) + 1);
    const k = [...m.bad].sort().join("+");
    comboHist.set(k, (comboHist.get(k) ?? 0) + 1);
  }
  for (const [g, n] of [...blockHist.entries()].sort((a, b) => b[1] - a[1])) log(`   blocked by ${g}: ${n} order(s)`);
  log("   ── exact blocking combination (an order can be blocked by several) ──");
  for (const [k, n] of [...comboHist.entries()].sort((a, b) => b[1] - a[1])) log(`   blocked by exactly {${k}}: ${n} order(s)`);
  const SOFT = new Set(["others", "service"]);
  const softOnly = misses.filter((m) => m.bad.every((g) => SOFT.has(g))).length;
  log(`   orders blocked ONLY by 'others'/'service' (a classification question, not a stock question): ${softOnly} of ${misses.length}`);

  if (misses.length) {
    const docs = misses.map((m) => m.erp);
    const blockLines = await sql`SELECT i.doc_no, i.item_group, i.item_code,
        COALESCE(NULLIF(i.description,''), '(no description)') description,
        COALESCE(i.stock_status,'(null)') stock_status, COUNT(*)::int n
      FROM scm.mfg_sales_order_items i
      WHERE i.doc_no = ANY(${docs}) AND COALESCE(i.cancelled,false) = false
        AND COALESCE(i.stock_status,'(null)') <> 'READY'
      GROUP BY 1,2,3,4,5`;
    const softAgg = new Map();
    for (const r of blockLines) {
      if (!SOFT.has(r.item_group)) continue;
      const k = `${r.item_group}|${r.item_code}|${r.description}`;
      const cur = softAgg.get(k) ?? { group: r.item_group, code: r.item_code, desc: r.description, lines: 0, orders: new Set(), statuses: new Set() };
      cur.lines += r.n; cur.orders.add(r.doc_no); cur.statuses.add(r.stock_status);
      softAgg.set(k, cur);
    }
    log("");
    log(`   ── every not-READY line in item_group 'others'/'service' inside those ${misses.length} orders ──`);
    log(`   distinct item codes: ${softAgg.size}`);
    for (const v of [...softAgg.values()].sort((a, b) => b.lines - a.lines).slice(0, 60)) {
      log(`   [${v.group}] ${v.code} — "${v.desc}" : ${v.lines} line(s) across ${v.orders.size} order(s), status ${[...v.statuses].join("/")}`);
    }
  }

  log("");
  log("═══ 1. PO DOCUMENT NUMBER — AutoCount UDF_ToPONo vs the ERP's raised PO ═══");
  /* UDF_ToPONo is a COMMA-JOINED STRING when one order was converted to several
     POs ("PO-009566, PO-009555, PO-009556"). Testing that whole string for
     membership of a Set of individual doc numbers can NEVER match, so every
     multi-PO order was reported as "the ERP links a DIFFERENT PO" while printing
     two identical lists — and poExtra was suppressed to 0 in the process.
     Compare as SETS, order-insensitive, and separate the three real outcomes. */
  const acPoSet = (s) => new Set(String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean));

  /* No `p.linked_ac_docno IS NOT NULL` filter here: a PO the ERP raised ITSELF
     carries no AutoCount doc number, and excluding it made a natively-purchased
     order look like "the ERP links NO PO at all". Keep both kinds and say which. */
  const poLink = await sql`SELECT DISTINCT h.linked_ac_docno ac, p.po_number, p.linked_ac_docno po
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
    JOIN scm.mfg_sales_orders h ON h.doc_no = si.doc_no
    WHERE p.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  const erpPos = new Map();       // AC SO doc -> Set(AC PO doc) — comparable to UDF_ToPONo
  const erpNative = new Map();    // AC SO doc -> Set(ERP po_number) for POs with no AC doc
  for (const r of poLink) {
    const m = r.po ? erpPos : erpNative;
    if (!m.has(r.ac)) m.set(r.ac, new Set());
    m.get(r.ac).add(r.po ?? r.po_number);
  }

  let poExactSame = 0, poSuperset = 0, poShort = 0, poNone = 0;
  const poBad = [], noneRows = [], shortRows = [];
  for (const r of acStatus) {
    if (!r.ToPONo) continue;
    const want = acPoSet(r.ToPONo);
    const have = erpPos.get(r.DocNo) ?? new Set();
    const missing = [...want].filter((p) => !have.has(p));
    const extra = [...have].filter((p) => !want.has(p));
    if (!have.size) { poNone++; noneRows.push({ ac: r.DocNo, want: [...want] }); continue; }
    if (!missing.length && !extra.length) { poExactSame++; continue; }
    if (!missing.length) { poSuperset++; continue; }
    poShort++;
    shortRows.push({ ac: r.DocNo, want: [...want], have: [...have], missing, extra });
    if (poBad.length < 20) poBad.push(`${r.DocNo}: AutoCount names ${[...want].join(", ")}; the ERP links ${[...have].join(", ")} -> MISSING ${missing.join(", ")}${extra.length ? `; EXTRA ${extra.join(", ")}` : ""}`);
  }
  const multiPo = acStatus.filter((r) => r.ToPONo && acPoSet(r.ToPONo).size > 1).length;
  log(`orders where AutoCount names a PO: ${acStatus.filter((r) => r.ToPONo).length} (of which ${multiPo} name SEVERAL, comma-joined)`);
  log(`   exact match, same set of POs both sides: ${poExactSame}`);
  log(`   the ERP links every PO AutoCount names, plus extra ones: ${poSuperset}`);
  log(`   the ERP is MISSING at least one PO AutoCount names: ${poShort}`);
  log(`   the ERP links NO PO at all: ${poNone}`);
  for (const b of poBad) log(`   ${b}`);

  /* ── LENS (A): why does the ERP link no PO for those orders? ────────────────
     Three candidate causes, and only one of them is an import gap:
       - the SO itself never landed in the ERP;
       - the named PO is absent from scm.purchase_orders entirely (import gap);
       - the PO IS present but no line of it carries so_item_id, so a query that
         walks SO -> so_item_id -> PO is blind to it (a DEDICATION gap — the
         known root cause: import-ac-outstanding-po.mjs has no so_item_id column
         in its INSERT at all).
     Split the population across those, and count the dedication gap system-wide
     so the size of any repair is a number and not an impression. */
  log("");
  log("   ── LENS (A): for each order where the ERP links no PO, WHY ──");
  const poRows = await sql`SELECT p.linked_ac_docno ac_po, COUNT(i.id)::int lines,
      COUNT(i.so_item_id)::int dedicated
    FROM scm.purchase_orders p LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
    GROUP BY 1`;
  const poPresent = new Map(poRows.map((r) => [r.ac_po, r]));
  const soRows = await sql`SELECT linked_ac_docno ac, doc_no, status::text status
    FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const soByAc = new Map(soRows.map((r) => [r.ac, r]));

  const cause = new Map();
  const bump = (k) => cause.set(k, (cause.get(k) ?? 0) + 1);
  const causeEx = new Map();
  const example = (k, s) => { const a = causeEx.get(k) ?? []; if (a.length < 4) a.push(s); causeEx.set(k, a); };
  const noneStatus = new Map();
  for (const n of noneRows) {
    const so = soByAc.get(n.ac);
    if (!so) { bump("the SO itself is not in the ERP"); example("the SO itself is not in the ERP", `${n.ac} -> ${n.want.join(", ")}`); continue; }
    noneStatus.set(so.status, (noneStatus.get(so.status) ?? 0) + 1);
    if (erpNative.has(n.ac)) {
      bump("the ERP DOES link a PO, but one it raised itself (no AutoCount doc no)");
      example("the ERP DOES link a PO, but one it raised itself (no AutoCount doc no)", `${n.ac} (${so.doc_no}) -> ${[...erpNative.get(n.ac)].join(", ")}`);
      continue;
    }
    const present = n.want.filter((p) => poPresent.has(p));
    const absent = n.want.filter((p) => !poPresent.has(p));
    if (!present.length) { bump("the PO is absent from the ERP entirely (import gap)"); example("the PO is absent from the ERP entirely (import gap)", `${n.ac} (${so.doc_no}) -> ${absent.join(", ")}`); continue; }
    if (absent.length) { bump("mixed: some named POs present, some absent"); example("mixed: some named POs present, some absent", `${n.ac} (${so.doc_no}) present ${present.join(", ")} absent ${absent.join(", ")}`); continue; }
    const anyDedicated = present.some((p) => poPresent.get(p).dedicated > 0);
    const k = anyDedicated
      ? "the PO is present and HAS dedicated lines, but none point at this SO"
      : "the PO is present but NOT ONE of its lines carries so_item_id (dedication gap)";
    bump(k);
    example(k, `${n.ac} (${so.doc_no}) -> ${present.map((p) => `${p}[${poPresent.get(p).dedicated}/${poPresent.get(p).lines} lines dedicated]`).join(", ")}`);
  }
  log(`   orders in this bucket: ${noneRows.length}`);
  for (const [k, n] of [...cause.entries()].sort((a, b) => b[1] - a[1])) {
    log(`   ${n} — ${k}`);
    for (const s of causeEx.get(k) ?? []) log(`        e.g. ${s}`);
  }
  log(`   ERP status of those orders: ${[...noneStatus.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(", ") || "(none)"}`);

  const [ded] = await sql`SELECT COUNT(*)::int lines, COUNT(i.so_item_id)::int dedicated
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  log(`   system-wide on AutoCount-imported POs: ${ded.lines} line(s), of which ${ded.dedicated} carry so_item_id -> ${ded.lines - ded.dedicated} undedicated`);
  const dedGrp = await sql`SELECT i.item_group, COUNT(*)::int lines, COUNT(i.so_item_id)::int dedicated
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC`;
  for (const r of dedGrp) log(`        ${r.item_group ?? "(null)"}: ${r.dedicated}/${r.lines} dedicated`);
  /* The same lens applied to the orders that are only PARTIALLY linked, since
     those POs are missing for exactly the same reasons. */
  const shortMissing = shortRows.flatMap((s) => s.missing);
  const shortAbsent = shortMissing.filter((p) => !poPresent.has(p)).length;
  log(`   for the ${poShort} partially-linked orders: ${shortMissing.length} named PO(s) not linked, of which ${shortAbsent} are absent from the ERP and ${shortMissing.length - shortAbsent} are present but undedicated to that SO`);

  /* check-line-supply-trace reports "bound lines not READY with NO purchase
     order raised at all". That is measured purely by so_item_id, and the lens
     above just proved so_item_id is systematically absent on imported POs — so
     the number must be split by whether AUTOCOUNT names a PO for the order
     before anyone reads it as a buyer's backlog. This is the only place both
     facts are available at once. */
  log("");
  log("   ── is \"bound lines with NO purchase order\" a backlog or a dedication artefact? ──");
  const bnp = await sql`SELECT h.linked_ac_docno ac, COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY' AND poi.id IS NULL
    GROUP BY 1`;
  let bnpNamed = 0, bnpUnnamed = 0, bnpNotInSnapshot = 0, bnpNoAcLink = 0, bnpTotal = 0;
  for (const r of bnp) {
    bnpTotal += r.n;
    if (!r.ac) { bnpNoAcLink += r.n; continue; }
    const acRow = byAcDoc.get(r.ac);
    if (!acRow) { bnpNotInSnapshot += r.n; continue; }
    if (acRow.ToPONo) bnpNamed += r.n; else bnpUnnamed += r.n;
  }
  log(`   bound (bedframe/sofa) lines not READY with no dedicated PO line: ${bnpTotal}`);
  log(`      AutoCount names a PO for that order (so a PO exists and only the dedication is missing): ${bnpNamed}`);
  log(`      AutoCount names NO PO for that order (nothing was ordered on either side): ${bnpUnnamed}`);
  log(`      order is not in the outstanding-SO snapshot at all: ${bnpNotInSnapshot}; ERP-native order with no AutoCount link: ${bnpNoAcLink}`);
  const [{ n: undedBound }] = await sql`SELECT COUNT(*)::int n
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND i.so_item_id IS NULL AND i.item_group IN ('bedframe','sofa')`;
  log(`   ceiling on how many of those could be hidden by the dedication gap: ${undedBound} undedicated bedframe/sofa PO line(s) exist company-wide`);

  /* ── The dedication gap has TWO populations and they are not the same number.
     A prior finding recorded "274 of 714 processed bedframe/sofa lines are
     undedicated"; the PO-line measure above says 382 of 864 (181 of 625 in the
     bedframe/sofa groups). Both can be true — one counts SALES-ORDER lines that
     ought to point at a PO, the other counts PURCHASE-ORDER lines that ought to
     point back at an SO. Printing them together, each with its exact predicate,
     is the only way the two stop looking like a contradiction.

     "Processed" is the ERP's own definition, not a new one: an order past DRAFT
     and not CANCELLED (mfg-sales-orders.ts soProcessingLocked). Both the
     status-based and the proceeded_at-based readings are printed, because the
     original 714 could have used either. */
  log("");
  log("   ── the dedication gap, both populations, side by side ──");
  /* COUNT(DISTINCT i.id), not COUNT(*): one SO line can carry several dedicated
     PO lines, and a plain count would inflate BOTH sides of this ratio. */
  const [soPop] = await sql`SELECT
      COUNT(DISTINCT i.id)::int processed_lines,
      COUNT(DISTINCT i.id) FILTER (WHERE poi.id IS NOT NULL)::int dedicated,
      COUNT(DISTINCT i.id) FILTER (WHERE h.proceeded_at IS NOT NULL)::int proceeded_lines,
      COUNT(DISTINCT i.id) FILTER (WHERE h.proceeded_at IS NOT NULL AND poi.id IS NOT NULL)::int proceeded_dedicated
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND i.item_group IN ('bedframe','sofa')
      AND h.status::text NOT IN ('DRAFT','CANCELLED')`;
  log(`   POPULATION 1 — SALES-ORDER lines that ought to point at a PO`);
  log(`      predicate: item_group IN (bedframe,sofa), not cancelled, order status NOT IN (DRAFT,CANCELLED)`);
  log(`      ${soPop.processed_lines} line(s); ${soPop.dedicated} have a dedicated PO line; ${soPop.processed_lines - soPop.dedicated} UNDEDICATED`);
  log(`      same, narrowed to orders actually stamped proceeded_at: ${soPop.proceeded_lines} line(s); ${soPop.proceeded_dedicated} dedicated; ${soPop.proceeded_lines - soPop.proceeded_dedicated} UNDEDICATED`);
  const [poPop] = await sql`SELECT COUNT(*)::int lines, COUNT(i.so_item_id)::int dedicated
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')`;
  log(`   POPULATION 2 — PURCHASE-ORDER lines that ought to point back at an SO line`);
  log(`      predicate: item_group IN (bedframe,sofa) on any company-${CO} purchase order`);
  log(`      ${poPop.lines} line(s); ${poPop.dedicated} carry so_item_id; ${poPop.lines - poPop.dedicated} UNDEDICATED`);
  log(`   the two measure opposite ends of the SAME missing link: a PO line without so_item_id is exactly why an SO line has no dedicated PO.`);

  log("");
  log("═══ 3. BALANCE — AutoCount UDF_BALANCE vs the ERP ═══");
  const so = gz("ac-outstanding-so.json.gz");
  const acBal = new Map();
  for (const r of so) if (r.UDF_BALANCE != null && !acBal.has(r.DocNo)) acBal.set(r.DocNo, Number(r.UDF_BALANCE) || 0);
  /* `h.total_centi` does not exist and crashed this section with 42703 on
     2026-08-10. The header total is `local_total_centi`; more to the point, the
     ERP already HAS an outstanding balance and this comparison should use it
     rather than re-deriving total-minus-payments, which is a second
     implementation of the same rule that can silently disagree with the screen.
     `balance_centi_live` is the VIEW's computed column and is exactly what the
     SO list renders (see the VIEW-TRAP note in scm/routes/mfg-sales-orders.ts).
     The view is joined on doc_no rather than selected from directly, because the
     view froze its column set at CREATE VIEW time and `linked_ac_docno` was
     added to the base table afterwards — it is NOT guaranteed to be visible
     through the view. Column presence is printed, not assumed. */
  const viewCols = new Set((await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders_with_payment_totals'`).map((r) => r.column_name));
  log(`view mfg_sales_orders_with_payment_totals: balance_centi_live=${viewCols.has("balance_centi_live")} paid_total_centi=${viewCols.has("paid_total_centi")} local_total_centi=${viewCols.has("local_total_centi")} linked_ac_docno=${viewCols.has("linked_ac_docno")}`);
  const [{ n: dupDoc }] = await sql`SELECT COUNT(*)::int n FROM (
      SELECT doc_no FROM scm.mfg_sales_orders GROUP BY doc_no HAVING COUNT(*) > 1) t`;
  log(`doc_no values shared by more than one sales order (would fan the join out): ${dupDoc}`);

  const erpBal = await sql`WITH v AS (
      SELECT doc_no, paid_total_centi, balance_centi_live FROM scm.mfg_sales_orders_with_payment_totals)
    SELECT h.linked_ac_docno ac, h.doc_no, h.local_total_centi, h.balance_centi,
      v.paid_total_centi, v.balance_centi_live, h.status::text status
    FROM scm.mfg_sales_orders h LEFT JOIN v ON v.doc_no = h.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
      AND h.status::text NOT IN ('CANCELLED','CLOSED')`;
  let balMatch = 0, balDiff = 0, balNoLive = 0; const balBad = [];
  const seenDoc = new Set();
  for (const r of erpBal) {
    if (seenDoc.has(r.doc_no)) continue;
    seenDoc.add(r.doc_no);
    const ac = acBal.get(r.ac);
    if (ac == null) continue;
    if (r.balance_centi_live == null) balNoLive++;
    const erpOutstanding = Number(r.balance_centi_live ?? r.local_total_centi ?? 0) / 100;
    if (Math.abs(erpOutstanding - ac) < 0.01) balMatch++;
    else {
      balDiff++;
      if (balBad.length < 15) balBad.push(`${r.ac} (${r.doc_no}): AutoCount balance ${ac.toFixed(2)}; ERP balance_centi_live ${erpOutstanding.toFixed(2)} (total ${(Number(r.local_total_centi ?? 0) / 100).toFixed(2)}, paid ${(Number(r.paid_total_centi ?? 0) / 100).toFixed(2)})`);
    }
  }
  log(`orders compared: ${balMatch + balDiff}; balance agrees: ${balMatch}; differs: ${balDiff}`);
  if (balNoLive) log(`   orders with no balance_centi_live from the view (fell back to local_total_centi): ${balNoLive}`);
  for (const b of balBad) log(`   ${b}`);

  log("");
  log("═══ 4. DOCUMENT FLOW — SO -> PO -> GR -> PI on both sides ═══");
  /* This section compared `scm.grns.linked_ac_docno` against AutoCount GR
     numbers and reported 291 of 449 POs as "disagree about which receipt",
     printing `PO-009304: the ERP's GRN points at PO-009304; AutoCount says
     GR-004996` — a PO number tested against a GR number, so it could only ever
     disagree. That column holds the PO's AutoCount number, not the receipt's
     (create-migrated-documents.mjs writes `g.po.linked_ac_docno` into it, which
     contradicts migration 0276's own COMMENT — reported, not changed here).

     The ERP's real statement about which AutoCount receipts a PO carries is
     `scm.purchase_orders.linked_ac_grn_docnos` (stamp-ac-grn-refs.mjs), backed
     up by the migrated GRN's number, which is minted as `HC-<AC GR>` when that
     receipt covers one imported PO and `HC-<AC GR>-<AC PO>` when it covers
     several. ONE AutoCount receipt legitimately spans many POs — 1250 of them do
     — so the test is SET MEMBERSHIP, never string equality. Migrated GRNs
     (migrated_no_stock) are real documents and count as received: they carry no
     stock movement on purpose, which is a costing fact, not a paperwork one. */
  const normDoc = (s) => String(s ?? "").trim().replace(/\s+/g, "-");
  const refs = gz("ac-gr-refs.json.gz");
  const acPoGr = new Map(), acPoPi = new Map();
  for (const r of refs) {
    const po = normDoc(r.PoNo);
    if (!acPoGr.has(po)) { acPoGr.set(po, new Set()); acPoPi.set(po, new Set()); }
    if (r.GrNo) acPoGr.get(po).add(normDoc(r.GrNo));
    if (r.PiNo) acPoPi.get(po).add(normDoc(r.PiNo));
  }
  const acGrSpan = new Map();
  for (const r of refs) { if (!r.GrNo) continue; const g = normDoc(r.GrNo); if (!acGrSpan.has(g)) acGrSpan.set(g, new Set()); acGrSpan.get(g).add(normDoc(r.PoNo)); }
  log(`AutoCount snapshot: ${refs.length} receipt rows over ${acPoGr.size} PO(s), ${acGrSpan.size} GR doc(s), of which ${[...acGrSpan.values()].filter((s) => s.size > 1).length} span more than one PO`);

  /* 4a — the reference data itself. If the stamp never ran, every "disagreement"
     below would be an artefact of an empty column, so this is checked FIRST and
     the section refuses to draw a conclusion it has not earned. */
  const pos = await sql`SELECT p.linked_ac_docno ac_po, p.po_number,
      COALESCE(p.linked_ac_grn_docnos, '{}') ac_grs, COALESCE(p.linked_ac_pinv_docnos, '{}') ac_pis
    FROM scm.purchase_orders p
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const stamped = pos.filter((p) => (p.ac_grs ?? []).length).length;
  const expected = pos.filter((p) => (acPoGr.get(p.ac_po) ?? new Set()).size).length;
  log("");
  log("   ── 4a. is the AutoCount receipt reference actually stamped? ──");
  log(`   imported POs: ${pos.length}; carrying a non-empty linked_ac_grn_docnos: ${stamped}; the snapshot says ${expected} of them were received`);
  const stampWrong = pos.filter((p) => {
    const want = acPoGr.get(p.ac_po) ?? new Set();
    const have = new Set((p.ac_grs ?? []).map(normDoc));
    return want.size !== have.size || [...want].some((g) => !have.has(g));
  });
  log(`   stamped value disagrees with the snapshot on: ${stampWrong.length} PO(s)`);
  for (const p of stampWrong.slice(0, 6)) log(`      ${p.po_number} (${p.ac_po}): stamped {${(p.ac_grs ?? []).join(", ")}}; snapshot {${[...(acPoGr.get(p.ac_po) ?? [])].join(", ")}}`);
  if (stamped === 0) log("   VERDICT: stamp-ac-grn-refs has NOT been run — no receipt comparison below can be trusted.");

  /* 4b — PO -> GR. What the ERP NAMES as the AutoCount receipt behind a GRN is
     read from the stamp and cross-checked against the number the GRN was minted
     with, so a stamp that drifted from the document is visible rather than
     silently believed. */
  const grns = await sql`SELECT p.linked_ac_docno ac_po, g.grn_number, g.status::text st,
      COALESCE(g.migrated_no_stock,false) migrated
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const erpGrn = new Map();
  for (const r of grns) {
    if (!erpGrn.has(r.ac_po)) erpGrn.set(r.ac_po, []);
    erpGrn.get(r.ac_po).push(r);
  }
  /* `HC-GR-004913` -> GR-004913; `HC-GR-000017-PO-000038` -> GR-000017;
     `HC-GRN-000001` -> null, an ERP-native receipt that names no AutoCount doc. */
  const grIdentity = (grnNumber, acPo) => {
    if (!grnNumber || !grnNumber.startsWith("HC-")) return null;
    let s = grnNumber.slice(3);
    if (acPo && s.endsWith(`-${acPo}`)) s = s.slice(0, -(acPo.length + 1));
    return /^G+R-\d+$/.test(s) ? s : null;
  };

  let cAgree = 0, cAcOnly = 0, cErpOnly = 0, cDiffer = 0, cPartial = 0, cNative = 0;
  const chainBad = [];
  for (const p of pos) {
    const acGrs = acPoGr.get(p.ac_po) ?? new Set();
    const rows = erpGrn.get(p.ac_po) ?? [];
    const named = new Set();
    for (const g of rows) {
      const id = grIdentity(g.grn_number, p.ac_po);
      if (id) named.add(id);
    }
    for (const g of (p.ac_grs ?? [])) named.add(normDoc(g));
    if (!acGrs.size && !rows.length) { cAgree++; continue; }               // neither received
    if (acGrs.size && !rows.length) {
      cAcOnly++;
      if (chainBad.length < 12) chainBad.push(`${p.po_number} (${p.ac_po}): AutoCount received it (${[...acGrs].join(", ")}) but the ERP has no GRN`);
      continue;
    }
    if (!acGrs.size && rows.length) {
      cErpOnly++;
      if (chainBad.length < 12) chainBad.push(`${p.po_number} (${p.ac_po}): the ERP has GRN ${rows.map((r) => r.grn_number).join(", ")} but AutoCount records no receipt for it`);
      continue;
    }
    if (!named.size) { cNative++; continue; }                              // received both sides, ERP names no AC doc
    const stray = [...named].filter((g) => !acGrs.has(g));
    if (stray.length) {
      cDiffer++;
      if (chainBad.length < 12) chainBad.push(`${p.po_number} (${p.ac_po}): the ERP names receipt(s) ${[...named].join(", ")}; AutoCount says ${[...acGrs].join(", ")} -> not in AutoCount: ${stray.join(", ")}`);
      continue;
    }
    cAgree++;
    if ([...acGrs].some((g) => !named.has(g))) cPartial++;
  }
  log("");
  log("   ── 4b. PO -> GR ──");
  log(`purchase orders whose chain was compared: ${pos.length}`);
  log(`   chain agrees (same receipt by set membership, or neither side received it): ${cAgree}`);
  log(`      of those, the ERP names only SOME of AutoCount's receipts for that PO: ${cPartial}`);
  log(`   AutoCount received it, the ERP has no GRN: ${cAcOnly}`);
  log(`   the ERP has a GRN AutoCount does not know: ${cErpOnly}`);
  log(`   the two name DIFFERENT receipts: ${cDiffer}`);
  log(`   both received, but the ERP's GRN names no AutoCount document (ERP-native receipt): ${cNative}`);
  for (const b of chainBad) log(`   ${b}`);
  const migrated = grns.filter((g) => g.migrated).length;
  log(`   GRN rows on imported POs: ${grns.length}, of which migrated_no_stock (paperwork carried over, counted as received): ${migrated}`);

  /* 4c — PO -> PI. The ERP was never given AutoCount's purchase invoices as
     documents; the cutover kept them as a POINTER on the PO. Stating both makes
     the absence a design decision on the report rather than a silent zero. */
  log("");
  log("   ── 4c. PO -> PI ──");
  const [{ n: hasPiTable }] = await sql`SELECT COUNT(*)::int n FROM information_schema.tables
    WHERE table_schema = 'scm' AND table_name = 'purchase_invoices'`;
  const acPiPos = pos.filter((p) => (acPoPi.get(p.ac_po) ?? new Set()).size).length;
  const piStamped = pos.filter((p) => (p.ac_pis ?? []).length).length;
  log(`   POs AutoCount has a purchase invoice for: ${acPiPos}; POs carrying linked_ac_pinv_docnos in the ERP: ${piStamped}`);
  if (!hasPiTable) log("   scm.purchase_invoices does not exist in this database");
  else {
    const pis = await sql`SELECT p.linked_ac_docno ac_po, COUNT(*)::int n
      FROM scm.purchase_invoices i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      WHERE i.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL GROUP BY 1`;
    log(`   imported POs carrying an actual ERP purchase-invoice document: ${pis.length}`);
    log(`   -> ${pis.length === 0 ? "none: AutoCount's invoices live in the ERP as a reference on the PO, not as documents (cutover design)" : "some invoices were created as ERP documents"}`);
  }

  /* 4d — the whole chain, for the orders AutoCount names a PO for. Two different
     questions, and conflating them is what made section 1 and section 4 look
     like they contradicted each other: does the DOCUMENT exist in the ERP, and
     is it LINKED to the order. Lens (A) proved the link is what is missing. */
  log("");
  log("   ── 4d. full chain SO -> PO -> GR, for the orders AutoCount names a PO for ──");
  let full = 0, chainSoMissing = 0, chainPoMissing = 0, chainGrMissing = 0, chainLinkMissing = 0;
  for (const r of acStatus) {
    if (!r.ToPONo) continue;
    const want = [...acPoSet(r.ToPONo)].map(normDoc);
    if (!soByAc.has(r.DocNo)) { chainSoMissing++; continue; }
    if (want.some((p) => !poPresent.has(p))) { chainPoMissing++; continue; }
    const grMissing = want.some((p) => (acPoGr.get(p) ?? new Set()).size && !(erpGrn.get(p) ?? []).length);
    if (grMissing) { chainGrMissing++; continue; }
    if (!(erpPos.get(r.DocNo) ?? new Set()).size) { chainLinkMissing++; continue; }
    full++;
  }
  log(`   orders AutoCount names a PO for: ${acStatus.filter((r) => r.ToPONo).length}`);
  log(`   every document exists AND the SO->PO link is present: ${full}`);
  log(`   the SO is not in the ERP: ${chainSoMissing}`);
  log(`   a named PO document is not in the ERP: ${chainPoMissing}`);
  log(`   AutoCount received a named PO but the ERP has no GRN for it: ${chainGrMissing}`);
  log(`   every document exists but the SO->PO link is missing (the dedication gap from lens A): ${chainLinkMissing}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
