#!/usr/bin/env node
/**
 * GR SHAPE — what shape the ERP's migrated goods receipts have, what shape the
 * BOOK has, and what it would cost to make the first equal the second.
 *
 * WHY THIS EXISTS. The owner ruled on 2026-09-07, on being offered three
 * shapes: 「不是说过了吗？是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」
 * — option A, one ERP goods receipt per AutoCount receipt, carrying the book's
 * own receipt date and the book's own received quantity, for the IN-SCOPE set
 * only. Today the ERP carries one GRN per PURCHASE ORDER instead, built from
 * `purchase_order_items.received_qty` (create-migrated-documents.mjs), which is
 * why `ac-erp-reconcile.yml` prints "GR DATA — line and money comparison NOT
 * APPLICABLE": comparing a derived quantity against the book measures the
 * derivation, not the book.
 *
 * This check is the PRECONDITION for that reshape, not the reshape. It answers
 * three questions with numbers instead of readings:
 *
 *   1. HOW SPLIT IS THE BOOK? How many in-scope purchase orders AutoCount
 *      received in more than one go, and on how many separate dates. The owner
 *      asked for this directly.
 *   2. WOULD RESHAPING MOVE STOCK? Migrated GRNs are stamped
 *      `migrated_no_stock` (migration 0276) and are supposed to have NO
 *      inventory movement behind them, because on-hand came in once through the
 *      AutoCount balance snapshot. That is a CLAIM in a comment until someone
 *      counts the movements. This counts them.
 *   3. WHAT WOULD A CANCEL COST? `PATCH /grns/:id/cancel` writes a reversing
 *      inventory OUT per line and decrements the PO's received_qty. It never
 *      consults `migrated_no_stock` (grns.ts: zero occurrences). So "cancel,
 *      never delete" — the owner's standing rule — is NOT safe through that
 *      route for these documents, and the size of the exposure is measured
 *      here rather than asserted.
 *
 * ── WHAT THIS DELIBERATELY REFUSES TO DO ────────────────────────────────────
 * It does NOT report a per-receipt QUANTITY, and the reason is the finding:
 *
 *   - `ac-gr-refs.json.gz` is the only snapshot carrying a GR number, a GR date
 *     and a quantity together, and its query LEFT JOINs PODTL on
 *     (DocKey, ItemCode) and PIDTL on (FromDocNo, ItemCode)
 *     (export-ac-reimport.py). Both fan out. Measured on the committed file:
 *     1,019 rows but only 597 distinct, 422 byte-identical duplicates, and 54
 *     groups where ONE receipt line maps to more than one purchase-order line.
 *     GRDTL carries no detail key in the SELECT, so a genuine duplicate receipt
 *     line and a join artefact are indistinguishable. Summing GrQty overstates.
 *   - `ac-fidelity-gr-by-po-item.json.gz` is honest but AGGREGATED over every
 *     receipt of a (PO, ItemCode) cell — it carries no GR number at all, so it
 *     cannot split one PO's receipts into the documents that made them.
 *   - The book itself cannot supply the PO LINE: `export-ac-fidelity-truth.py`
 *     measures `SUM(CASE WHEN ISNULL(FromDocDtlKey,0) <> 0 ...)` over GRDTL and
 *     `ac-fidelity-manifest.json` records the answer — 0 of 21,001 rows. A
 *     receipt line names its purchase order (FromDocNo) and its ItemCode, and
 *     nothing finer.
 *
 * The (PO, GR) PAIR SET is used, and only that, because it survives the fan-out
 * intact: both LEFT JOINs duplicate rows, neither can invent a PoNo or a GrNo —
 * those come from the two INNER joins. The pair count is cross-checked against
 * the reconcile's independently-computed in-scope population below.
 *
 * READ-ONLY. SELECT only — no DDL, no writes, no transaction. Exit 0 for every
 * legitimate answer; non-zero only when the database is unreachable or the
 * snapshot is missing, because a red job reads as "the check broke".
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1 (Houzs Century / AED_HOUZS)
 *
 * RE-RUN: read-only and idempotent. A second run writes nothing and reports the
 * same numbers unless production or the snapshot changed underneath it.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m) => console.log(m);
const rule = (t) => say(`\n═══════════ ${t} ═══════════`);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const n = (s) => String(s ?? "").trim();
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/** `{1: 248, 2: 58}` rendered as a stable, readable line. */
const histogram = (counts) => Object.keys(counts).map(Number).sort((a, b) => a - b)
  .map((k) => `${k}× ${counts[k]}`).join("   ");

async function main() {
  say(`GR SHAPE — company ${CO}, read-only. ${new Date().toISOString()}`);

  // ── THE BOOK ───────────────────────────────────────────────────────────────
  rule("THE BOOK — how AutoCount actually received these purchase orders");
  const refs = gz("ac-gr-refs.json.gz");
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-reimport-manifest.json"), "utf8"));
  say(`snapshot ac-gr-refs.json.gz — ${refs.length} rows, exported ${manifest.exported_at} (${manifest.source})`);

  /* The pair set, and the DATE per receipt. Nothing else is read off this file:
     see the header for why its quantity column cannot be summed. */
  const pairs = new Set();
  const grDate = new Map();
  for (const r of refs) {
    if (!r.GrNo) continue;
    pairs.add(`${n(r.PoNo)}|${n(r.GrNo)}`);
    const d = String(r.GrDate || "").slice(0, 10);
    if (d) {
      if (!grDate.has(n(r.GrNo))) grDate.set(n(r.GrNo), new Set());
      grDate.get(n(r.GrNo)).add(d);
    }
  }
  const poGr = new Map();
  const grPo = new Map();
  for (const p of pairs) {
    const [po, gr] = p.split("|");
    if (!poGr.has(po)) poGr.set(po, new Set());
    poGr.get(po).add(gr);
    if (!grPo.has(gr)) grPo.set(gr, new Set());
    grPo.get(gr).add(po);
  }
  const splitHist = {};
  for (const [, s] of poGr) splitHist[s.size] = (splitHist[s.size] ?? 0) + 1;
  const spanHist = {};
  for (const [, s] of grPo) spanHist[s.size] = (spanHist[s.size] ?? 0) + 1;
  const splitPos = [...poGr].filter(([, s]) => s.size > 1);
  const multiDate = splitPos.filter(([, grs]) => new Set([...grs].map((g) => [...(grDate.get(g) ?? [])][0])).size > 1);

  notice(`BOOK — ${grPo.size} AutoCount goods receipts cover ${poGr.size} in-scope purchase orders, in ${pairs.size} (receipt × purchase order) pairs`);
  say(`  purchase orders by how many receipts received them:  ${histogram(splitHist)}`);
  say(`  → RECEIVED IN MORE THAN ONE GO: ${splitPos.length} of ${poGr.size} purchase orders`);
  say(`     of those, ${multiDate.length} were received on DIFFERENT DATES (${splitPos.length - multiDate.length} split across documents dated the same day)`);
  say(`  receipts by how many in-scope purchase orders they touch:  ${histogram(spanHist)}`);
  const spanning = [...grPo].filter(([, s]) => s.size > 1);
  say(`  → ${spanning.length} of ${grPo.size} receipts cover MORE THAN ONE in-scope purchase order.`);
  say("    That is the structural wall for a literal one-document-per-receipt shape:");
  say("    scm.grns.purchase_order_id is a single purchase order, so an ERP goods");
  say("    receipt cannot span several. The achievable grain is the PAIR.");
  const grYears = {};
  for (const [, s] of grDate) { const y = [...s][0].slice(0, 4); grYears[y] = (grYears[y] ?? 0) + 1; }
  say(`  receipt dates by year: ${Object.entries(grYears).sort().map(([y, c]) => `${y} ${c}`).join("   ")}`);
  say(`  receipts carrying more than one distinct date: ${[...grDate].filter(([, s]) => s.size > 1).length} (a receipt has one date, as expected)`);

  // ── THE ERP ────────────────────────────────────────────────────────────────
  rule("THE ERP — what shape the migrated goods receipts have today");
  const grns = await sql`SELECT g.id::text AS id, g.grn_number, g.status, g.linked_ac_docno,
      g.purchase_order_id::text AS po_id, g.received_at, g.migrated_no_stock,
      p.po_number, p.linked_ac_docno AS po_ac_docno, p.linked_ac_grn_docnos
    FROM scm.grns g LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const [{ lines: lineCount, units }] = await sql`SELECT COUNT(*)::int AS lines,
      COALESCE(SUM(i.qty_accepted), 0)::float8 AS units
    FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const statuses = {};
  for (const g of grns) statuses[g.status] = (statuses[g.status] ?? 0) + 1;
  const distinctPo = new Set(grns.map((g) => g.po_id)).size;
  notice(`ERP — ${grns.length} migrated goods receipts, ${lineCount} lines, ${units} units, across ${distinctPo} purchase orders`);
  say(`  status: ${Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join("   ")}`);
  const recvDates = new Set(grns.map((g) => String(g.received_at ?? "").slice(0, 10)));
  say(`  distinct received_at dates on those ${grns.length} documents: ${recvDates.size}`);
  if (recvDates.size <= 3) {
    say(`     → ${[...recvDates].sort().join(", ")}. The book's receipt date is NOT on these documents:`);
    say("       create-migrated-documents.mjs writes received_at = CURRENT_DATE (the day the");
    say("       migration ran), so every receipt reads as having arrived on cutover day.");
  }
  const pointerGrs = new Set();
  for (const g of grns) for (const x of (g.linked_ac_grn_docnos ?? [])) pointerGrs.add(n(x));
  say(`  AutoCount receipt numbers reachable from these documents (via the PO pointer): ${pointerGrs.size}`);
  say(`  scm.grns.linked_ac_docno holds the PURCHASE ORDER number, not the receipt number (by design, reconcile trap 1)`);

  // ── THE GAP ────────────────────────────────────────────────────────────────
  rule("THE GAP — what option A would change");
  const erpPoAc = new Set(grns.map((g) => n(g.po_ac_docno)).filter(Boolean));
  const bookPoInErp = [...poGr.keys()].filter((po) => erpPoAc.has(po));
  const wantPairs = [...pairs].filter((p) => erpPoAc.has(p.split("|")[0]));
  notice(`SHAPE A — ${wantPairs.length} documents where the ERP holds ${grns.length} today (+${wantPairs.length - grns.length}), over the ${bookPoInErp.length} purchase orders both sides agree on`);
  say(`  book purchase orders with a receipt that the ERP does NOT hold a GRN for: ${poGr.size - bookPoInErp.length}`);
  say(`  ERP migrated GRNs whose purchase order the book shows NO receipt for:     ${grns.length - new Set(grns.filter((g) => poGr.has(n(g.po_ac_docno))).map((g) => g.id)).size}`);

  // ── STOCK SAFETY ───────────────────────────────────────────────────────────
  rule("STOCK — would reshaping these documents move inventory?");
  const ids = grns.map((g) => g.id);
  const mv = ids.length
    ? await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(qty)), 0)::float8 AS q
        FROM scm.inventory_movements
        WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${ids})`
    : [{ n: 0, q: 0 }];
  const withMv = ids.length
    ? await sql`SELECT source_doc_id::text AS id, COUNT(*)::int AS n
        FROM scm.inventory_movements
        WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${ids})
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
    : [];
  const clean = mv[0].n === 0;
  notice(`STOCK — inventory movements behind the ${grns.length} migrated goods receipts: ${mv[0].n} (${mv[0].q} units). ${clean ? "ZERO — the migrated_no_stock claim is TRUE on production." : "NOT ZERO — the migrated_no_stock claim is FALSE for some documents."}`);
  if (!clean) {
    say("  documents that DO carry movements (top 10 by row count):");
    for (const r of withMv) {
      const g = grns.find((x) => x.id === r.id);
      say(`     ${g?.grn_number ?? r.id}  ${r.n} movement row(s)`);
    }
    say("  → BLOCKER. Removing or superseding a document that DID move stock changes on-hand.");
  } else {
    say("  → Creating or removing these rows by direct SQL moves no inventory: the FIFO");
    say("    trigger is AFTER INSERT ON inventory_movements (scm-schema/inventory-fifo-trigger.sql),");
    say("    not on grn_items, so nothing fires from writing a receipt row itself.");
  }

  // ── THE CANCEL LANDMINE ────────────────────────────────────────────────────
  rule("CANCEL — what the owner's 'never delete, only cancel' rule costs here");
  const posted = grns.filter((g) => g.status !== "CANCELLED" && g.status !== "DRAFT");
  const [{ q: cancelUnits }] = ids.length
    ? await sql`SELECT COALESCE(SUM(i.qty_accepted), 0)::float8 AS q
        FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
        WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
          AND g.status NOT IN ('CANCELLED', 'DRAFT')`
    : [{ q: 0 }];
  notice(`CANCEL — PATCH /grns/:id/cancel on the ${posted.length} POSTED migrated receipts would write reversing OUT movements for ${cancelUnits} units that never had an IN`);
  say("  grns.ts never reads migrated_no_stock (0 occurrences). The cancel path:");
  say("    (a) writes an inventory OUT per line for qty_accepted (buildGrnCancelReversals),");
  say("    (b) decrements each linked PO item's received_qty,");
  say("    (c) reverses the rack placement.");
  say("  Its one guard, grnReverseWouldGoNegative, PASSES here — the units really are");
  say("  on the shelf, they just came from the balance snapshot rather than from this");
  say("  document. So the guard cannot see the difference and the phantom OUT is written.");
  say("  → A direct SQL status flip cancels these documents WITHOUT that reversal.");
  say("    The route is the unsafe path, not the outcome.");

  // ── FEASIBILITY ────────────────────────────────────────────────────────────
  rule("FEASIBILITY — what a shape-A writer still needs and does not have");
  const fid = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-fidelity-manifest.json"), "utf8"));
  say(`  GRDTL rows in the book:                       ${fid.grdtl_rows}`);
  say(`  ...of which carry a FromDocDtlKey (PO line):  ${fid.grdtl_rows_with_line_key}`);
  say("  → The book cannot say WHICH purchase-order line a receipt line received.");
  say("    It gives FromDocNo (the purchase order) and ItemCode, and nothing finer.");
  say("    Where a purchase order carries the same ItemCode on two lines, the split is");
  say("    not recoverable from AutoCount at all — the PO-009633 trap already recorded");
  say("    in export-ac-fidelity-truth.py.");
  say("");
  say("  Per-receipt QUANTITY is not in any committed snapshot:");
  say("    ac-gr-refs.json.gz         has GrNo + GrDate + GrQty, but its PODTL/PIDTL LEFT");
  say("                               JOINs fan out and it carries no GRDTL detail key,");
  say("                               so its quantities cannot be de-duplicated honestly.");
  say("    ac-fidelity-gr-by-po-item  is aggregated over every receipt of a (PO, item)");
  say(`                               cell (${fid.exported_at}) and holds no GR number.`);
  say("");
  say("  A shape-A writer needs ONE clean export, one row per GRDTL detail key:");
  say("    SELECT gr.DocNo, gr.DocDate, g.DtlKey, g.FromDocNo, g.ItemCode,");
  say("           g.Qty, g.UnitPrice, g.Description, g.Location");
  say("      FROM GRDTL g JOIN GR gr ON gr.DocKey = g.DocKey");
  say("     WHERE gr.Cancelled = 'F' AND g.FromDocType = 'PO'");
  say("    — no LEFT JOIN, no GROUP BY, no correlated subquery.");

  await sql.end();
  say("");
  notice("check-gr-shape: read-only, nothing was written.");
}

main().catch((e) => { console.error(e); process.exit(1); });
