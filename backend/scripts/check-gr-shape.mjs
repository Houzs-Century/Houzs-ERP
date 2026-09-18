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
 * ── WHICH SNAPSHOT ANSWERS WHICH QUESTION ───────────────────────────────────
 * Four committed extracts touch goods receipts and they are not interchangeable.
 * Reading the wrong one produces a confident wrong answer, which this check has
 * already done once (docs/bugs/0673, docs/bugs/0674).
 *
 *   - `ac-convert-edges.json.gz` is the ONE that carries per-receipt line truth,
 *     and it is what makes option A buildable with no fresh AutoCount pull. Its
 *     own `grain` field states it: "one row per AutoCount DocNo (headers) and
 *     per DtlKey (lines); NO filtering". GR headers give the receipt DATE and
 *     the cancelled flag; GR lines give the item code, the quantity and the
 *     purchase order the line was raised from. No join to fan it out, no
 *     aggregate to flatten it. Rows are ARRAYS, positional per `line_fields` /
 *     `header_fields` — take the index from those arrays, never hard-code one.
 *   - `ac-gr-refs.json.gz` is used here for the (PO, receipt) PAIR SET and the
 *     receipt date, and for nothing else. Its query LEFT JOINs PODTL on
 *     (DocKey, ItemCode) and PIDTL on (FromDocNo, ItemCode)
 *     (export-ac-reimport.py), and both fan out: 1,019 rows but only 597
 *     distinct, 422 byte-identical duplicates, 54 groups where one receipt line
 *     maps to more than one purchase-order line. It carries no GRDTL detail key,
 *     so a genuine duplicate receipt line and a join artefact cannot be told
 *     apart and summing `GrQty` overstates. The PAIR SET survives that intact —
 *     a LEFT JOIN duplicates rows, it cannot invent a PoNo or a GrNo, and those
 *     two come from the INNER joins. It is cross-checked against
 *     ac-convert-edges below rather than trusted.
 *   - `ac-fidelity-gr-by-po-item.json.gz` is honest but AGGREGATED over every
 *     receipt of a (PO, ItemCode) cell — it carries no GR number at all, so it
 *     cannot split one purchase order's receipts into the documents that made
 *     them. `check-gr-fidelity.mjs` uses it for the contents comparison at that
 *     grain; this check does not use it.
 *   - `ac-fidelity-manifest.json` records the one thing the BOOK genuinely does
 *     not hold: `grdtl_rows_with_line_key` is 0 of 21,001. A receipt line names
 *     its purchase order and its ItemCode, and nothing finer.
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
  /* THE SNAPSHOT'S SCOPE IS NARROWER THAN THE ERP'S, and comparing the two sets
     without saying so manufactures a gap. ac-gr-refs is exported
     `WHERE po.DocNo IN (outstanding POs + SO-linked POs)`, and that set is
     RECOMPUTED at export time — a purchase order that has since been closed
     drops out of it. The ERP's migrated set was frozen at import. So an ERP
     receipt whose purchase order is outside the export scope is a document the
     snapshot has NO ROWS ABOUT; it is not evidence the book lacks a receipt.
     The two are separated below rather than summed. */
  const scopeRows = [...gz("ac-outstanding-po.json.gz"), ...gz("ac-so-linked-pos.json.gz")];
  const exportScope = new Set(scopeRows.map((r) => n(r.DocNo)));
  const erpPoAc = new Set(grns.map((g) => n(g.po_ac_docno)).filter(Boolean));
  const bookPoInErp = [...poGr.keys()].filter((po) => erpPoAc.has(po));
  const shared = new Set(bookPoInErp);
  const wantPairs = [...pairs].filter((p) => shared.has(p.split("|")[0]));
  const erpOnShared = grns.filter((g) => shared.has(n(g.po_ac_docno))).length;
  say(`snapshot export scope (outstanding + SO-linked purchase orders): ${exportScope.size} purchase orders`);
  say(`ERP migrated goods receipts sit on ${erpPoAc.size} purchase orders; ${bookPoInErp.length} of those are in that scope AND have a receipt in it`);
  notice(`SHAPE A — over the ${bookPoInErp.length} purchase orders both sides can speak about, the ERP holds ${erpOnShared} documents and the book has ${wantPairs.length} (+${wantPairs.length - erpOnShared})`);

  const erpUnspeakable = grns.filter((g) => !poGr.has(n(g.po_ac_docno)));
  const outOfScope = erpUnspeakable.filter((g) => !exportScope.has(n(g.po_ac_docno)));
  const inScopeNoReceipt = erpUnspeakable.filter((g) => exportScope.has(n(g.po_ac_docno)));
  say(`  ERP migrated GRNs the snapshot cannot speak about: ${erpUnspeakable.length} of ${grns.length}`);
  say(`     ...because their purchase order is OUTSIDE the export scope:   ${outOfScope.length}  ← scope artefact, not a gap`);
  say(`     ...purchase order IS in scope but the book shows NO receipt:   ${inScopeNoReceipt.length}  ← a real disagreement if non-zero`);
  if (inScopeNoReceipt.length) {
    say("     first 10:");
    for (const g of inScopeNoReceipt.slice(0, 10)) say(`       ${g.grn_number}  (PO ${g.po_number} = AutoCount ${g.po_ac_docno})`);
  }
  const bookPoNotInErp = [...poGr.keys()].filter((po) => !erpPoAc.has(po));
  say(`  book purchase orders with a receipt but NO ERP migrated GRN: ${bookPoNotInErp.length} of ${poGr.size}`);
  say("     Expected where the purchase order was never imported, or was imported with");
  say("     received_qty 0 — create-migrated-documents.mjs builds only from received_qty > 0.");

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

  // ── THE BOOK, AT LINE GRAIN ────────────────────────────────────────────────
  /* ac-convert-edges.json.gz is the extract that makes shape A buildable, and
     the first version of this check MISSED it and said the data did not exist.
     Its grain is stated in the file: "one row per AutoCount DocNo (headers) and
     per DtlKey (lines); NO filtering". So it holds every GRDTL row with its GR
     document, that document's date and cancelled flag, the item code, the
     quantity, and the purchase order the line was raised from — with no join to
     fan it out and no aggregate to flatten it.

     Rows are ARRAYS, positional per line_fields / header_fields. Read the index
     out of those arrays; never hard-code a position. */
  rule("THE BOOK AT LINE GRAIN — ac-convert-edges, and whether the two extracts agree");
  const ce = gz("ac-convert-edges.json.gz");
  const LF = ce.line_fields, HF = ce.header_fields;
  const cD = LF.indexOf("docNo"), cQ = LF.indexOf("qty"), cIT = LF.indexOf("itemKey");
  const cFT = LF.indexOf("fromDocType"), cFN = LF.indexOf("fromDocNo"), cFDK = LF.indexOf("fromDocDtlKey");
  const hD = HF.indexOf("docNo"), hDate = HF.indexOf("docDate"), hC = HF.indexOf("cancelled");
  const grHead = new Map(ce.types.GR.headers.map((h) => [n(h[hD]), { date: n(h[hDate]), cancelled: n(h[hC]) }]));
  say(`snapshot ac-convert-edges.json.gz — exported ${ce.exported_at}, ${ce.counts.GR.headers} GR headers / ${ce.counts.GR.lines} GR lines, unfiltered`);

  const cePairs = new Set();
  let ceLines = 0, ceUnits = 0, ceCancelledSkipped = 0;
  const cePoGr = new Map();
  for (const r of ce.types.GR.lines) {
    if (n(r[cFT]) !== "PO") continue;
    const po = n(r[cFN]);
    if (!poGr.has(po)) continue;              // in-scope purchase orders only
    const grNo = n(r[cD]);
    const h = grHead.get(grNo);
    if (!h || h.cancelled !== "F") { ceCancelledSkipped += 1; continue; }
    cePairs.add(`${po}|${grNo}`);
    if (!cePoGr.has(po)) cePoGr.set(po, new Set());
    cePoGr.get(po).add(grNo);
    ceLines += 1;
    ceUnits += Number(r[cQ] || 0);
  }
  const bothPairs = [...pairs].filter((p) => cePairs.has(p)).length;
  notice(`BOOK AT LINE GRAIN — ${ceLines} receipt lines, ${ceUnits} units, over the same ${cePoGr.size} in-scope purchase orders`);
  say(`  (PO, receipt) pairs: ac-gr-refs ${pairs.size}, ac-convert-edges ${cePairs.size}, in BOTH ${bothPairs}`);
  say(`  → two independently-cut extracts, ${bothPairs === pairs.size && bothPairs === cePairs.size ? "IDENTICAL" : "DISAGREEING — resolve before building on either"} on the pair set.`);
  say(`  cancelled receipt lines skipped: ${ceCancelledSkipped}`);
  const ceHist = {};
  for (const [, s] of cePoGr) ceHist[s.size] = (ceHist[s.size] ?? 0) + 1;
  say(`  purchase orders by receipts, from this extract: ${histogram(ceHist)}`);
  say(`  ERP holds ${lineCount} migrated GRN lines carrying ${units} units against the book's ${ceLines} / ${ceUnits}`);
  say("  Those totals are NOT expected to match line-for-line: the ERP line count follows");
  say("  the PURCHASE ORDER's lines (one GRN line per received PO line) while the book's");
  say("  follows the RECEIPT's lines. The UNIT totals are the comparable pair.");

  // ── FEASIBILITY ────────────────────────────────────────────────────────────
  rule("FEASIBILITY — what a shape-A writer has, and the one thing it does not");
  const fid = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-fidelity-manifest.json"), "utf8"));
  const ceKeyed = ce.types.GR.lines.filter((r) => Number(r[cFDK] || 0) !== 0).length;
  say("  HAS, from ac-convert-edges, with no fresh AutoCount pull:");
  say("    the receipt number, its DATE and its cancelled flag (headers)");
  say("    one row per GRDTL detail key, with item code, quantity and source purchase order");
  say("");
  say("  DOES NOT HAVE — the purchase-order LINE a receipt line received:");
  say(`    GRDTL rows carrying a FromDocDtlKey — ac-fidelity-manifest: ${fid.grdtl_rows_with_line_key} of ${fid.grdtl_rows}`);
  say(`                                        — ac-convert-edges:     ${ceKeyed} of ${ce.counts.GR.lines}`);
  say("    Two extracts of different vintages agree that the column is empty book-wide.");
  say("    A receipt line names its purchase order and its ItemCode, and nothing finer, so");
  say("    the ERP line must be resolved by ItemCode. That is exact where a purchase order");
  say("    carries each code once, and NOT RECOVERABLE where it carries one twice — the");
  say("    PO-009633 trap recorded in export-ac-fidelity-truth.py.");
  say("");
  /* HOW BIG IS THAT SET? Printed rather than described, because "some purchase
     orders are ambiguous" is not something a decision can be made on. Measured
     off the same fresh extract, so it moves with the book. */
  const poLinesByDoc = new Map();
  for (const r of ce.types.PO.lines) {
    const d = n(r[cD]);
    if (!poGr.has(d)) continue;
    if (!poLinesByDoc.has(d)) poLinesByDoc.set(d, []);
    poLinesByDoc.get(d).push(r);
  }
  const ambiguousPos = new Set();
  let ambiguousPoLines = 0;
  for (const [po, ls] of poLinesByDoc) {
    const seen = new Map();
    for (const l of ls) { const k = n(l[cIT]); seen.set(k, (seen.get(k) ?? 0) + 1); }
    const dup = [...seen.values()].filter((v) => v > 1);
    if (dup.length) { ambiguousPos.add(po); ambiguousPoLines += dup.reduce((a, b) => a + b, 0); }
  }
  let ambLines = 0, ambUnits = 0;
  for (const r of ce.types.GR.lines) {
    if (n(r[cFT]) !== "PO") continue;
    const po = n(r[cFN]);
    if (!ambiguousPos.has(po)) continue;
    const h = grHead.get(n(r[cD]));
    if (!h || h.cancelled !== "F") continue;
    ambLines += 1; ambUnits += Number(r[cQ] || 0);
  }
  say(`  in-scope purchase orders present in this extract: ${poLinesByDoc.size} of ${poGr.size}`);
  say(`    every line a UNIQUE item code — receipt line resolves exactly: ${poLinesByDoc.size - ambiguousPos.size}`);
  say(`    same item code on 2+ lines — NOT decidable from the book:      ${ambiguousPos.size}  (${ambiguousPoLines} purchase-order lines)`);
  notice(`SHAPE A LINE RESOLUTION — ${ceLines - ambLines} of ${ceLines} receipt lines (${ceUnits - ambUnits} of ${ceUnits} units) resolve to exactly one purchase-order line; ${ambLines} lines / ${ambUnits} units sit on a purchase order with a duplicate item code and need a STATED rule`);
  say("  A writer must name that rule and report the set it applied to. Silently taking");
  say("  the first matching line is the PO-009633 defect being re-created deliberately.");

  await sql.end();
  say("");
  notice("check-gr-shape: read-only, nothing was written.");
}

main().catch((e) => { console.error(e); process.exit(1); });
