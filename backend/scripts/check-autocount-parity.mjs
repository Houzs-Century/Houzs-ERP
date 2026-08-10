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
  const misses = [];
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
      if (misses.length < 25) misses.push({ ac: r.DocNo, erp: e.doc, remark: r.Remark2, bad: bad.join(","), detail: [...e.g.entries()].map(([g, s]) => `${g}:${Object.entries(s).map(([k, v]) => k + "=" + v).join("/")}`).join(" | ") });
    } else agree++;
  }
  log(`orders where AutoCount states a status: ${acStatus.filter((r) => r.Remark2).length} of ${acStatus.length}`);
  log(`   ERP agrees: ${agree}`);
  log(`   ERP DISAGREES: ${disagree}`);
  log(`   "READY (PARTIAL)" - not falsifiable per category, counted apart: ${partial}`);
  log(`   order not in the ERP as an open order: ${noLines}; phrase not understood: ${unreadable}`);
  for (const m of misses) log(`   ${m.ac} (${m.erp}) says "${m.remark}" but ${m.bad} is not all READY -> ${m.detail}`);

  log("");
  log("═══ 1. PO DOCUMENT NUMBER — AutoCount UDF_ToPONo vs the ERP's raised PO ═══");
  const poLink = await sql`SELECT DISTINCT h.linked_ac_docno ac, p.linked_ac_docno po
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
    JOIN scm.mfg_sales_orders h ON h.doc_no = si.doc_no
    WHERE p.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`;
  const erpPos = new Map();
  for (const r of poLink) {
    if (!erpPos.has(r.ac)) erpPos.set(r.ac, new Set());
    erpPos.get(r.ac).add(r.po);
  }
  let poMatch = 0, poMissing = 0, poDiff = 0, poExtra = 0;
  const poBad = [];
  for (const r of acStatus) {
    if (!r.ToPONo) continue;
    const have = erpPos.get(r.DocNo);
    if (!have || !have.size) {
      poMissing++;
      if (poBad.length < 20) poBad.push(`${r.DocNo}: AutoCount says ${r.ToPONo}; the ERP has NO purchase order linked to that order`);
      continue;
    }
    if (have.has(r.ToPONo)) { poMatch++; if (have.size > 1) poExtra++; }
    else {
      poDiff++;
      if (poBad.length < 20) poBad.push(`${r.DocNo}: AutoCount says ${r.ToPONo}; the ERP links ${[...have].join(", ")}`);
    }
  }
  log(`orders where AutoCount names a PO: ${acStatus.filter((r) => r.ToPONo).length}`);
  log(`   the ERP links that same PO: ${poMatch} (of which ${poExtra} link additional POs too, which is legitimate)`);
  log(`   the ERP links a DIFFERENT PO: ${poDiff}`);
  log(`   the ERP links NO PO at all: ${poMissing}`);
  for (const b of poBad) log(`   ${b}`);

  log("");
  log("═══ 3. BALANCE — AutoCount UDF_BALANCE vs the ERP ═══");
  const so = gz("ac-outstanding-so.json.gz");
  const acBal = new Map();
  for (const r of so) if (r.UDF_BALANCE != null && !acBal.has(r.DocNo)) acBal.set(r.DocNo, Number(r.UDF_BALANCE) || 0);
  const erpBal = await sql`SELECT h.linked_ac_docno ac, h.total_centi, h.doc_no,
      COALESCE((SELECT SUM(p.amount_centi) FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = h.doc_no), 0) AS paid
    FROM scm.mfg_sales_orders h
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
      AND h.status NOT IN ('CANCELLED','CLOSED')`;
  let balMatch = 0, balDiff = 0; const balBad = [];
  for (const r of erpBal) {
    const ac = acBal.get(r.ac);
    if (ac == null) continue;
    const erpOutstanding = (Number(r.total_centi) - Number(r.paid)) / 100;
    if (Math.abs(erpOutstanding - ac) < 0.01) balMatch++;
    else {
      balDiff++;
      if (balBad.length < 15) balBad.push(`${r.ac} (${r.doc_no}): AutoCount balance ${ac.toFixed(2)}; ERP ${erpOutstanding.toFixed(2)}`);
    }
  }
  log(`orders compared: ${balMatch + balDiff}; balance agrees: ${balMatch}; differs: ${balDiff}`);
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
