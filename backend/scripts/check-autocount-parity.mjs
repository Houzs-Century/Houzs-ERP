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
  log("═══ 4. DOCUMENT FLOW — SO -> PO -> GR on both sides ═══");
  const refs = gz("ac-gr-refs.json.gz");
  const acPoGr = new Map();
  for (const r of refs) {
    if (!acPoGr.has(r.PoNo)) acPoGr.set(r.PoNo, new Set());
    if (r.GrNo) acPoGr.get(r.PoNo).add(r.GrNo);
  }
  const erpChain = await sql`SELECT p.linked_ac_docno po, g.linked_ac_docno gr, g.grn_number
    FROM scm.purchase_orders p LEFT JOIN scm.grns g ON g.purchase_order_id = p.id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  let chainOk = 0, chainNoGrn = 0, chainMismatch = 0; const chainBad = [];
  const seenPo = new Set();
  for (const r of erpChain) {
    if (seenPo.has(r.po) && !r.gr) continue;
    seenPo.add(r.po);
    const acGrs = acPoGr.get(r.po);
    if (!acGrs || !acGrs.size) { if (!r.gr) chainOk++; else { chainMismatch++; if (chainBad.length < 15) chainBad.push(`${r.po}: the ERP has GRN ${r.grn_number} but AutoCount records no receipt`); } continue; }
    if (!r.gr) { chainNoGrn++; if (chainBad.length < 15) chainBad.push(`${r.po}: AutoCount received it (${[...acGrs].join(", ")}) but the ERP has no GRN`); continue; }
    if (acGrs.has(r.gr)) chainOk++;
    else { chainMismatch++; if (chainBad.length < 15) chainBad.push(`${r.po}: the ERP's GRN points at ${r.gr}; AutoCount says ${[...acGrs].join(", ")}`); }
  }
  log(`purchase orders whose chain was compared: ${chainOk + chainNoGrn + chainMismatch}`);
  log(`   chain agrees (both received, same receipt - or neither received): ${chainOk}`);
  log(`   AutoCount received it, the ERP has no GRN: ${chainNoGrn}`);
  log(`   the two disagree about which receipt: ${chainMismatch}`);
  for (const b of chainBad) log(`   ${b}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
