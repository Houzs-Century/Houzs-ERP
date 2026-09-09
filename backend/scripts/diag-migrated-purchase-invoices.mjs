#!/usr/bin/env node
/* diag-migrated-purchase-invoices — ONE NAMED CAUSE for every in-scope
 * AutoCount purchase invoice the ERP does not hold.
 *
 * WHY THIS EXISTS. `check-ac-erp-reconcile.mjs` ends its purchase-invoice
 * section with a number — "21 (GAP)" — and a list of document numbers. A number
 * is not a remedy: 21 invoices missing for 21 different reasons need 21
 * different fixes, and the one thing that must never happen is lumping them,
 * because the remedies are OPPOSITE. An invoice we cannot reach because the
 * supplier billed goods on receipts outside the migration is CORRECTLY absent
 * and needs no repair at all; an invoice we cannot reach because our receipt
 * lost its price needs the price put back. Reading both as "the money gate
 * refuses it" would send someone to repair the first one, and repairing a price
 * that was never wrong is how RM 13,068.55 of fabricated discount landed on
 * PO-009335 (docs/bugs/0665).
 *
 * TWO LANES, ANSWERED SEPARATELY, because "the ERP holds this invoice" means
 * two different things here and they have different remedies:
 *
 *   LANE A — the POINTER. `scm.purchase_orders.linked_ac_pinv_docnos` names the
 *            AutoCount invoices raised against that order. It is what the
 *            reconcile counts as presence, and it is what `stamp-ac-grn-refs`
 *            writes. Cheap, carries no money, and closes the reconcile's count.
 *
 *   LANE B — the DOCUMENT. A real `scm.purchase_invoices` row mirroring the
 *            AutoCount invoice, written by `create-migrated-invoices.mjs` and
 *            gated on the total agreeing to the sen. This is the one the money
 *            has to be right for.
 *
 * The AutoCount side is the COMMITTED snapshot, never a live query: the book is
 * reachable only over the owner's ZeroTier link, a heavy read there starves the
 * ERP -> AutoCount write-back, and a check that reads a moving target cannot be
 * re-run to reproduce a past verdict.
 *
 * READ-ONLY. SELECT only, one statement at a time, no DDL, no writes, no
 * transaction. RE-RUN: pure. The same commit against the same database prints
 * the same answer; it changes only when the snapshot or the ERP does.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildScope, currencyVerdict, decodeSnapshot } from "./lib/ac-scope.mjs";
import { loadMigratedGrnSources } from "./lib/migrated-grn-source.mjs";
import { planMigratedInvoices } from "../src/scm/lib/migrated-chain.ts";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;

const snap = gz("ac-reconcile-truth.json.gz");
const book = decodeSnapshot(snap);
const scope = buildScope(book);
const REFS = gz("ac-invoice-refs.json.gz");
const GRREFS = gz("ac-gr-refs.json.gz");

const cancelled = new Set(
  Object.entries({ ...REFS.piMeta, ...REFS.ivMeta }).filter(([, m]) => m.cancelled).map(([d]) => d));
const acTotals = {};
for (const [doc, m] of Object.entries(REFS.piMeta)) acTotals[doc] = Math.round(Number(m.netTotal) * 100);

/* The pointer source, read the way stamp-ac-grn-refs.mjs reads it: PO -> the
   receipts and invoices AutoCount raised against it. */
const refsByPo = new Map();
const refPisOf = new Map();
for (const r of GRREFS) {
  const po = String(r.PoNo || "").trim();
  if (!po) continue;
  if (!refsByPo.has(po)) refsByPo.set(po, { gr: new Set(), pi: new Set() });
  if (r.GrNo) refsByPo.get(po).gr.add(String(r.GrNo).trim());
  if (r.PiNo) {
    const pi = String(r.PiNo).trim();
    refsByPo.get(po).pi.add(pi);
    if (!refPisOf.has(pi)) refPisOf.set(pi, new Set());
    refPisOf.get(pi).add(po);
  }
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* ── the ERP side ─────────────────────────────────────────────────────────── */
const mirrors = await sql`
  SELECT invoice_number, linked_ac_docno, total_sen
  FROM scm.purchase_invoices WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
const mirroredBy = new Map(mirrors.map((r) => [String(r.linked_ac_docno).trim(), r]));

const pos = await sql`
  SELECT po_number, linked_ac_docno,
         COALESCE(linked_ac_grn_docnos, '{}') AS ac_grs,
         COALESCE(linked_ac_pinv_docnos, '{}') AS ac_pis
  FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
const poByAc = new Map(pos.map((p) => [String(p.linked_ac_docno).trim(), p]));
const pointedBy = new Map();
for (const p of pos) for (const pi of p.ac_pis) if (pi) pointedBy.set(String(pi).trim(), p);

/* Which AutoCount receipts the ERP actually holds a goods-receipt document for.
   Derived exactly as the converter derives it, from the shared loader, so the
   two cannot disagree about what "we hold this receipt" means. */
const grnSources = await loadMigratedGrnSources(sql, {
  companyId: CO, grToPi: REFS.grToPi, isCancelled: (x) => cancelled.has(x),
});
const heldAcGrs = new Set();
for (const s of grnSources) for (const g of s._acGrsAll ?? []) heldAcGrs.add(g);

const { plans, blocked } = planMigratedInvoices(grnSources, acTotals);
const planByAcInvoice = new Map(plans.map((p) => [p.acInvoiceNo, p]));
/* An AutoCount invoice can also be unreachable because every receipt feeding it
   was refused BEFORE grouping (ambiguous, nothing_to_invoice, ...), in which
   case it has no plan at all — only blocked source rows naming it. */
const blockedByAcInvoice = new Map();
for (const b of blocked) {
  for (const inv of b.acInvoiceNos.length ? b.acInvoiceNos : ["(none)"]) {
    if (!blockedByAcInvoice.has(inv)) blockedByAcInvoice.set(inv, []);
    blockedByAcInvoice.get(inv).push(b);
  }
}
/* A receipt AutoCount never invoiced still names its invoices in grToPi; the
   reverse index lets an absent invoice say which of OUR receipts feed it. */
const erpGrnsFeeding = new Map();
for (const s of grnSources) {
  for (const inv of s.acInvoiceNos) {
    if (!erpGrnsFeeding.has(inv)) erpGrnsFeeding.set(inv, []);
    erpGrnsFeeding.get(inv).push(s);
  }
}

await sql.end();

/* ── the report ───────────────────────────────────────────────────────────── */
plain(`AutoCount snapshot exported_at=${snap.exported_at}`);
plain(`invoice map exported ${REFS._exportedAt}; pointer source ac-gr-refs.json.gz holds ${refPisOf.size} purchase-invoice numbers`);
plain("");
log(`PURCHASE INVOICES in the expected ERP population: ${scope.PI.size}`);
plain(`ERP: ${mirroredBy.size} mirrored as a document; ${pointedBy.size} named by a pointer on a purchase order; `
  + `${grnSources.length} migrated goods receipts to convert from`);

const absent = [];
let mirrored = 0; let pointed = 0;
for (const pi of [...scope.PI].sort()) {
  if (mirroredBy.has(pi)) { mirrored++; continue; }
  if (pointedBy.has(pi)) { pointed++; continue; }
  absent.push(pi);
}
log(`in scope and held as a DOCUMENT: ${mirrored}; held only as a POINTER: ${pointed}; ABSENT: ${absent.length}`);
plain("");

/* Why LANE A failed for this invoice — the pointer, which is what the reconcile
   counts. Three different failures, three different remedies. */
function laneA(pi) {
  const posForPi = refPisOf.get(pi);
  if (!posForPi) {
    return {
      cause: "not_in_pointer_source",
      detail: "ac-gr-refs.json.gz names no purchase order for this invoice, so stamp-ac-grn-refs can never write it. "
        + "The export cuts PO -> GR -> PI, and this invoice's receipt is not on an in-scope purchase order in that cut.",
    };
  }
  const inErp = [...posForPi].filter((p) => poByAc.has(p));
  if (!inErp.length) {
    return { cause: "pointer_po_not_in_erp", detail: `named on AutoCount ${[...posForPi].join(", ")}, none of which the ERP holds` };
  }
  /* The stamp's idempotency test compares the GR list only. A purchase order
     whose receipts have not changed is skipped whole, so an invoice raised
     against it SINCE the last stamp never lands. */
  const evidence = inErp.map((p) => {
    const row = poByAc.get(p);
    const want = [...(refsByPo.get(p)?.gr ?? [])].sort();
    const have = (row.ac_grs ?? []).slice().sort();
    const grEqual = want.length === have.length && want.every((v, i) => v === have[i]);
    return `${row.po_number} (AutoCount ${p}): stored GR list ${grEqual ? "already equals" : "DIFFERS from"} the snapshot's`
      + `; stored PI list [${(row.ac_pis ?? []).join(", ") || "empty"}]`;
  });
  const anySkip = inErp.some((p) => {
    const row = poByAc.get(p);
    const want = [...(refsByPo.get(p)?.gr ?? [])].sort();
    const have = (row.ac_grs ?? []).slice().sort();
    return want.length === have.length && want.every((v, i) => v === have[i]);
  });
  return {
    cause: anySkip ? "stamp_skipped_the_po_its_receipts_were_unchanged" : "pointer_not_written",
    detail: evidence.join(" | "),
  };
}

/* Why LANE B failed — a real ERP purchase-invoice document. The converter's own
   verdict, plus the money split that says WHICH remedy it needs. */
function laneB(pi) {
  const lines = book.PI.lines.get(pi) ?? [];
  const header = book.PI.headers.get(pi);
  const cur = currencyVerdict(header);
  const held = lines.filter((l) => l.fromDocType === "GR" && heldAcGrs.has(l.fromDocNo));
  const unheld = lines.filter((l) => !(l.fromDocType === "GR" && heldAcGrs.has(l.fromDocNo)));
  const heldSen = held.reduce((t, l) => t + (l.subTotalSen ?? 0), 0);
  const unheldSen = unheld.reduce((t, l) => t + (l.subTotalSen ?? 0), 0);
  const lineSum = heldSen + unheldSen;
  const qxp = lines.reduce((t, l) => t + Math.round((l.qty ?? 0) * (l.unitPriceSen ?? 0)), 0);
  const discountSen = qxp - lineSum;
  const headerCharge = (header?.totalSen ?? 0) - lineSum;
  const plan = planByAcInvoice.get(pi);
  const blockedRows = blockedByAcInvoice.get(pi) ?? [];
  const feeding = erpGrnsFeeding.get(pi) ?? [];
  const ours = plan ? plan.valueSen : null;

  let cause;
  let detail;
  if (cur.kind !== "local") {
    cause = "foreign_currency_refused";
    detail = cur.why;
  } else if (!feeding.length) {
    cause = "no_erp_goods_receipt_feeds_it";
    detail = "no migrated goods receipt in the ERP names this invoice, so there is nothing to convert from";
  } else if (!plan) {
    const reasons = [...new Set(blockedRows.map((b) => b.reason))];
    cause = reasons[0] ?? "refused_before_grouping";
    detail = `every feeding receipt was refused before grouping: ${blockedRows.map((b) => `${b.docNo} (${b.reason})`).join(", ")}`;
  } else if (plan.eligible) {
    cause = "writable_now";
    detail = `${rm(plan.valueSen)} from ${plan.sourceDocNos.join(" + ")}`;
  } else if (plan.reason === "party_disagrees_across_sources") {
    cause = "party_disagrees_across_sources";
    detail = `sources ${plan.sourceDocNos.join(" + ")} name different suppliers`;
  } else if (unheldSen > 0 && ours === heldSen) {
    cause = "partial_coverage_the_erp_holds_only_part_of_what_was_billed";
    detail = `${rm(unheldSen)} of ${rm(header.totalSen)} is billed on AutoCount receipts the ERP holds no goods receipt for `
      + `(${[...new Set(unheld.map((l) => l.fromDocNo || "(no source)"))].join(", ")}); our side matches the rest exactly`;
  } else if (ours === 0) {
    cause = "our_receipt_carries_no_price";
    detail = `AutoCount billed ${rm(header.totalSen)}; every line of ${plan.sourceDocNos.join(" + ")} is RM 0.00 in the ERP`;
  } else if (ours < heldSen) {
    cause = "our_receipt_price_is_short_of_the_book";
    detail = `ours ${rm(ours)} vs ${rm(heldSen)} that AutoCount billed on the same receipts`
      + (unheldSen ? `; a further ${rm(unheldSen)} is on receipts the ERP does not hold` : "");
  } else if (ours > heldSen) {
    cause = "our_receipt_price_exceeds_the_book";
    detail = `ours ${rm(ours)} vs ${rm(heldSen)} on the same receipts`;
  } else {
    cause = "total_disagrees_with_autocount";
    detail = `ours ${rm(ours)} vs AutoCount ${rm(plan.acValueSen)}`;
  }
  return { cause, detail, heldSen, unheldSen, discountSen, headerCharge, ours, cur };
}

log("LANE A — the POINTER on the purchase order (what the reconcile counts as presence)");
const aBuckets = new Map();
const bBuckets = new Map();
const detailRows = [];
for (const pi of absent) {
  const a = laneA(pi);
  const b = laneB(pi);
  aBuckets.set(a.cause, (aBuckets.get(a.cause) ?? 0) + 1);
  bBuckets.set(b.cause, (bBuckets.get(b.cause) ?? 0) + 1);
  detailRows.push({ pi, a, b });
}
for (const [c, n] of [...aBuckets].sort((x, y) => y[1] - x[1])) plain(`   ${c}: ${n}`);
plain("");
log("LANE B — a real ERP purchase-invoice DOCUMENT (what the money gate decides)");
for (const [c, n] of [...bBuckets].sort((x, y) => y[1] - x[1])) plain(`   ${c}: ${n}`);
plain("");

plain("─── one line per absent invoice ───");
for (const { pi, a, b } of detailRows) {
  const h = book.PI.headers.get(pi);
  plain(`${pi}  ${rm(h.totalSen)}  ${b.cur.kind}(${h.currency}@${h.rate})  lines=${(book.PI.lines.get(pi) ?? []).length}`);
  plain(`   POINTER : ${a.cause} — ${a.detail}`);
  plain(`   DOCUMENT: ${b.cause} — ${b.detail}`);
  plain(`   money   : AutoCount ${rm(h.totalSen)} = ${rm(b.heldSen)} on receipts the ERP holds + ${rm(b.unheldSen)} on receipts it does not`
    + `${b.ours === null ? "" : `; the converter would bill ${rm(b.ours)}`}`
    + `${b.discountSen ? `; AutoCount line discount ${rm(b.discountSen)}` : ""}`
    + `${b.headerCharge ? `; header charge beyond the lines ${rm(b.headerCharge)}` : ""}`);
}

/* Rule 4 of the brief the hard way: the three hypotheses for "ours is smaller"
   need OPPOSITE remedies, so they are counted apart and the arithmetic that
   separates them is printed rather than described. */
plain("");
log("WHY OURS IS SMALLER — measured, not assumed");
const anyHeaderCharge = detailRows.filter((r) => r.b.headerCharge !== 0);
const anyDiscount = detailRows.filter((r) => r.b.discountSen !== 0);
const anyUnheld = detailRows.filter((r) => r.b.unheldSen !== 0);
plain(`   freight / tax / any charge on the bill beyond its own lines: ${anyHeaderCharge.length} of ${absent.length}`
  + " (header NetTotal minus the sum of its line SubTotals)");
plain(`   an AutoCount LINE DISCOUNT the ERP importers do not carry: ${anyDiscount.length} of ${absent.length}`
  + `, ${rm(anyDiscount.reduce((t, r) => t + r.b.discountSen, 0))} in all`);
plain(`   billed partly on receipts outside the migration: ${anyUnheld.length} of ${absent.length}`
  + `, ${rm(anyUnheld.reduce((t, r) => t + r.b.unheldSen, 0))} in all`);
const priceShort = detailRows.filter((r) => r.b.ours !== null && r.b.ours < r.b.heldSen);
plain(`   our own goods-receipt price genuinely short of the book on the SAME receipts: ${priceShort.length} of ${absent.length}`
  + `, ${rm(priceShort.reduce((t, r) => t + (r.b.heldSen - r.b.ours), 0))} in all`);
plain("");
plain("The first three are NOT repairs. A charge AutoCount put on the bill and a receipt the migration");
plain("deliberately left behind are both correct absences; only the last line is money the ERP is missing.");
