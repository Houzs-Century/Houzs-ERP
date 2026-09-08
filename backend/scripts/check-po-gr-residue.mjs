#!/usr/bin/env node
/* check-po-gr-residue — ONE LINE PER DOCUMENT the purchase-order and
 * goods-receipt tally still has open, saying WHY.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * `check-po-gr-tally.mjs` answers 「都tally了吗」 with a count and a list of
 * document numbers. On go-live night the next question is always the same one:
 * *what is actually wrong with each of them.* That answer lives in the
 * reconcile's own chain block — which is captured as a subprocess's stdout and
 * printed at the very END of a 1,300-line log, and GitHub truncates a step's
 * log before it gets there. Measured on runs 34255914713 and 34258038309: the
 * chain block was cut off both times, so the impostor lines that say why a
 * migration decision did NOT cover a document were unreadable in practice.
 *
 * A verdict nobody can read is the same as no verdict. So this asks the three
 * residue questions directly, prints ~40 lines, and stops.
 *
 * ── READ-ONLY, AND IT DECIDES NOTHING ───────────────────────────────────────
 * SELECTs only, one connection, no DDL, no transaction, no writes, no MODE. It
 * classifies nothing: the verdicts come from the same
 * lib/transfer-chain-verdict.mjs the reconcile calls, and the book side is the
 * committed snapshot. It exists to PRINT what is already true.
 *
 * ── IT WILL NOT REPAIR, AND THAT IS THE POINT ───────────────────────────────
 * A transfer-quantity correction moves an on-hand figure, and stock is DEFERRED
 * by the owner (「库存先不看」). Everything below is a report.
 *
 * Exit 0 for every legitimate answer. Non-zero only when it cannot answer.
 *
 * ── DISPATCHED, NOT JUST WRITTEN ───────────────────────────────────────────
 * CLAUDE.md: a workflow_dispatch workflow is not shipped until it has been
 * dispatched once and reported success. Runs 34260859286, 34261381499,
 * 34261651815 and 34261802057, company 1, all exit 0 — and each of the first
 * three found a defect IN THIS FILE, which is the argument for the rule.
 *
 * RE-RUN: identical output for an identical database and snapshot. It writes
 * nothing, so a second run costs one connection and changes no row.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { sourceDocTokens } from "./lib/transfer-chain-verdict.mjs";
import { UNMIGRATED_ONWARD, splitUnmigratedOnwardTransfer } from "./lib/ac-not-a-difference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CO = Number(process.env.COMPANY_ID || "1");
const SHOW = Math.max(1, Number(process.env.SHOW || 40));
const p = (m) => console.log(m);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}

const CHAIN = path.join(here, "data", "ac-convert-edges.json.gz");
if (!fs.existsSync(CHAIN)) {
  console.error("REFUSED: ac-convert-edges.json.gz is not in the tree.");
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(CHAIN)).toString("utf8"));

/* THE MONEY LIVES IN A DIFFERENT SNAPSHOT, and the first cut of this file did
   not know that. `ac-convert-edges.json.gz` carries the CHAIN columns only —
   there is no `subTotal` in its `line_fields` — so reading one produced
   `undefined`, every book total came out 0, every pair was skipped, and the
   check printed "no priced pair differs from the book" while the tally was
   reporting four. A verdict computed over nothing must never read as a pass.
   The money is in `ac-reconcile-truth.json.gz`, which is the snapshot the
   reconcile itself compares against. */
const TRUTH = path.join(here, "data", "ac-reconcile-truth.json.gz");
const truth = fs.existsSync(TRUTH)
  ? JSON.parse(zlib.gunzipSync(fs.readFileSync(TRUTH)).toString("utf8"))
  : null;
const TL = truth ? Object.fromEntries((truth.line_fields || []).map((n, i) => [n, i])) : {};
const L = Object.fromEntries((snap.line_fields || []).map((n, i) => [n, i]));
const H = Object.fromEntries((snap.header_fields || []).map((n, i) => [n, i]));
const Q = (v) => Math.round(Number(v || 0) * 10000);
const fmt = (n) => (n / 10000).toString();
const up = (s) => String(s ?? "").trim().toUpperCase();

/* The book, indexed the two ways this check asks about it. */
const bookLines = (t) => (snap.types?.[t]?.lines || []);
const cancelledOf = (t) => new Set((snap.types?.[t]?.headers || []).filter((r) => r[H.cancelled] === "T").map((r) => r[H.docNo]));

/** child documents of `t` that name each parent document, cancelled ones left out */
function childrenByParent(t) {
  const dead = cancelledOf(t);
  const m = new Map();
  for (const r of bookLines(t)) {
    if (dead.has(r[L.docNo])) continue;
    for (const tok of sourceDocTokens(r[L.fromDocNo])) {
      if (!m.has(tok)) m.set(tok, new Set());
      m.get(tok).add(up(r[L.docNo]));
    }
  }
  return m;
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });

try {
  p("");
  p("═════════════ WHAT IS STILL OPEN ON PURCHASE ORDERS AND GOODS RECEIPTS ═════════════");
  p(`company ${CO} · book snapshot ${snap.exported_at} · read-only, nothing is repaired here`);

  /* ── 1. PURCHASE ORDERS: the book says received, we say less ────────────── */
  p("");
  p("─── 1. PURCHASE ORDER `transfer to` — the book received it and we record less ───");
  p("    the ERP column is scm.purchase_order_items.received_qty; the book's is PODTL.TransferedQty");
  const grOfPo = childrenByParent("GR");
  const heldGr = new Set(
    (await sql`SELECT DISTINCT linked_ac_gr_docno AS d FROM scm.grns
                WHERE company_id = ${CO} AND status <> 'CANCELLED' AND linked_ac_gr_docno IS NOT NULL`)
      .map((r) => up(r.d)),
  );
  const poRows = await sql`
    SELECT h.linked_ac_docno AS ac_no, h.po_number AS erp_no,
           i.linked_ac_dtlkey::text AS key, i.qty::float8 AS qty, i.received_qty::float8 AS got
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NOT NULL`;
  const bookPo = new Map(bookLines("PO").map((r) => [String(r[L.dtlKey]), r]));
  /* GROUPED BY BOOK LINE, never per ERP row: a sofa is ONE book DtlKey and
     several compartment rows here, so printing per row reports the
     decomposition as several findings. The counter is compared as the FRACTION
     transferred for exactly that reason. */
  const poGroups = new Map();
  for (const r of poRows) {
    const k = String(r.key).trim();
    if (!bookPo.has(k)) continue;
    let g = poGroups.get(k);
    if (!g) { g = { key: k, acNo: r.ac_no, erpNo: r.erp_no, eq: 0, got: 0, rows: 0 }; poGroups.set(k, g); }
    g.eq += Q(r.qty); g.got += Q(r.got); g.rows += 1;
  }
  let poOpen = 0;
  const splitRows = [];
  for (const r of poGroups.values()) {
    const bl = bookPo.get(r.key);
    const t = bl[L.transferedQty] === "" ? null : Q(bl[L.transferedQty]);
    if (t == null) continue;
    const bq = Q(bl[L.qty]);
    const got = r.got;
    const eq = r.eq;
    if (bq === 0 || eq === 0) continue;
    if (t * eq === got * bq) continue; /* the same fraction on both sides */
    poOpen += 1;
    splitRows.push({
      key: r.key, ac: bl[L.docNo], erpNo: r.erpNo, bookDocNo: bl[L.docNo],
      verdict: t * eq > got * bq ? "erp_low" : "erp_high",
      bookTransfered: t, erpCounter: got,
      line: `${bl[L.docNo]} DtlKey ${r.key}`, proceeded: true,
    });
    if (poOpen > SHOW) continue;
    const receipts = [...(grOfPo.get(up(bl[L.docNo])) || [])];
    const held = receipts.filter((g) => heldGr.has(g));
    p(
      `    ${bl[L.docNo]} (ERP ${r.erpNo}) DtlKey ${r.key}: book received ${fmt(t)} of ${fmt(bq)}, ` +
        `we record ${fmt(got)} of ${fmt(eq)} over ${r.rows} ERP row(s)`,
    );
    p(
      `        the book's receipts: ${receipts.join(", ") || "(none)"} — ` +
        (held.length
          ? `WE HOLD ${held.join(", ")}, so this is OURS to explain: we have the receipt and did not count it`
          : "we hold NONE of them, so the received quantity could only come from a receipt the cutover never imported"),
    );
  }
  log(
    poOpen === 0
      ? "PURCHASE ORDERS — 0 book line(s) disagree with the book on how much has been received."
      : `PURCHASE ORDERS — ${poOpen} book line(s) disagree with the book on how much has been received.`,
  );

  /* THE SAME CLASSIFIER THE RECONCILE CALLS, on the same rows, so this cannot
     answer differently from the tally. If they ever disagree, one of them is
     wrong and that disagreement is the finding — not something to reconcile by
     hand. */
  const poSplit = splitUnmigratedOnwardTransfer({
    rows: splitRows,
    decision: UNMIGRATED_ONWARD.PO,
    coverage: heldGr,
    onwardOf: (d) => [...(grOfPo.get(up(d)) || [])],
  });
  p("");
  p(`    the migration decision covers ${poSplit.notMigrated} of these; ${poSplit.differ} remain, and here is why:`);
  for (const im of poSplit.impostors.slice(0, SHOW)) p(`      ${im.why}`);
  log(
    `PURCHASE ORDERS — of the ${splitRows.length} book line(s) above, ${poSplit.notMigrated} are the cutover's own ` +
      `decision and ${poSplit.differ} are not.`,
  );

  /* ── 2. GOODS RECEIPTS: we hold no link to the purchase-order LINE ──────── */
  p("");
  p("─── 2. GOODS RECEIPT `transfer from` — the book raised it from a purchase order and we hold no link ───");
  p("    the ERP column is scm.grn_items.purchase_order_item_id; a NULL is a MISSING link, never a wrong one");
  const grRows = await sql`
    SELECT g.linked_ac_gr_docno AS gr, p.linked_ac_docno AS po, g.grn_number AS erp_no,
           i.linked_ac_dtlkey::text AS key, i.purchase_order_item_id AS link,
           i.qty_accepted::float8 AS qty
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
      JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
       AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`;
  const bookGr = new Map(bookLines("GR").map((r) => [String(r[L.dtlKey]), r]));
  const heldPo = new Set(
    (await sql`SELECT DISTINCT linked_ac_docno AS d FROM scm.purchase_orders
                WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`).map((r) => up(r.d)),
  );
  const byDoc = new Map();
  for (const r of grRows) {
    const bl = bookGr.get(String(r.key ?? "").trim());
    if (!bl) continue;
    const wanted = sourceDocTokens(bl[L.fromDocNo]);
    if (!wanted.length) continue;
    if (r.link != null) continue; /* we DO hold a link — a wrong one is a different finding */
    const k = `${up(r.gr)}|${up(r.po)}`;
    if (!byDoc.has(k)) byDoc.set(k, { erpNo: r.erp_no, lines: [] });
    byDoc.get(k).lines.push({ key: String(r.key).trim(), wanted, qty: Q(r.qty) });
  }
  let n = 0;
  for (const [k, d] of byDoc) {
    n += 1;
    if (n > SHOW) continue;
    const srcs = [...new Set(d.lines.flatMap((l) => l.wanted))];
    const have = srcs.filter((s) => heldPo.has(s));
    p(`    ${k} (ERP ${d.erpNo}): ${d.lines.length} line(s) carry NO purchase-order link`);
    p(
      `        the book raised them from ${srcs.join(", ")} — ` +
        (have.length === srcs.length
          ? `we hold ${have.join(", ")}, so the link is STAMPABLE: the parent is here, the pointer is not`
          : `we hold ${have.join(", ") || "none"} of those orders, so ${srcs.filter((s) => !heldPo.has(s)).join(", ")} would have to be imported first`),
    );
    for (const l of d.lines.slice(0, 3)) {
      /* The line's OWN key and its quantity. It deliberately does NOT ask
         whether a purchase-order line carries the same key: a goods-receipt
         DtlKey is a GRDTL key and a purchase-order line carries a PODTL one, so
         that question always answers "no" and reads as a finding. The book
         states no source LINE on this edge at all (`FromDocDtlKey` is NULL on
         every detail row), so the document is the finest grain there is. */
      p(`          GRDTL ${l.key}, quantity ${fmt(l.qty)}`);
    }
  }
  log(
    byDoc.size === 0
      ? "GOODS RECEIPTS — every line that the book raised from a purchase order carries a link."
      : `GOODS RECEIPTS — ${byDoc.size} document(s) carry a line with NO link to the purchase order it came from. A MISSING link, never a wrong one.`,
  );

  /* ── 3. GOODS RECEIPTS: the money differs ───────────────────────────────── */
  p("");
  p("─── 3. GOODS RECEIPT money — a RATIO PROBE, not a second verdict ───");
  p("    WHICH documents differ on money is `check-po-gr-tally.mjs`'s answer and only its answer. This");
  p("    prints the RATIO between our stored line money and the book's line subtotals so the SHAPE of a");
  p("    difference is visible, and it deliberately does not reimplement the reconcile's document total —");
  p("    a second implementation of \"different\" is what docs/bugs/0708 cost. Expect it to name a document");
  p("    or two the tally does not: a sofa is one book line and several compartment rows here, and this");
  p("    sums rows. Read the SHAPE, take the LIST from the tally.");
  p("    A ratio of exactly 4/3 is the DROPPED 25% supplier discount: AutoCount stores PODTL.UnitPrice");
  p("    undiscounted and PODTL.SubTotal discounted, and the importer took the undiscounted half.");
  const money = await sql`
    SELECT g.linked_ac_gr_docno AS gr, p.linked_ac_docno AS po, g.grn_number AS erp_no,
           COALESCE(SUM(i.qty_accepted * i.unit_price_sen), 0)::float8 AS sen
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
      JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
       AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL
     GROUP BY 1, 2, 3`;
  /* the book's money for a (receipt x order) PAIR is the sum of that pair's line
     subtotals, read from the TRUTH snapshot — the chain snapshot has no money
     columns at all, and reading one there is what made this section answer
     "nothing differs" over an empty measurement. */
  const pairBook = new Map();
  const moneyReadable = truth != null && TL.subTotal !== undefined && TL.fromDocNo !== undefined;
  if (!moneyReadable) {
    log(
      "GOODS RECEIPT MONEY — NOT MEASURED: ac-reconcile-truth.json.gz is absent or carries no `subTotal` " +
        "column, so there is nothing to compare our totals against. This is not a clean result; the money " +
        "was not checked.",
    );
  } else {
    for (const r of truth.types.GR.lines) {
      for (const tok of sourceDocTokens(r[TL.fromDocNo])) {
        const k = `${up(r[TL.docNo])}|${tok}`;
        pairBook.set(k, (pairBook.get(k) || 0) + Math.round(Number(r[TL.subTotal] || 0) * 100));
      }
    }
  }
  let m = 0;
  if (moneyReadable)
  for (const r of money) {
    const k = `${up(r.gr)}|${up(r.po)}`;
    const b = pairBook.get(k);
    if (b == null || b === 0) continue;
    const ours = Math.round(Number(r.sen || 0));
    if (ours === b || ours === 0) continue; /* RM 0.00 is the owner's 「GR 0 没关系」 */
    m += 1;
    if (m > SHOW) continue;
    const ratio = ours / b;
    const note =
      Math.abs(ratio - 4 / 3) < 0.0005
        ? "EXACTLY 4/3 — the dropped 25% supplier discount"
        : `ratio ${ratio.toFixed(4)}`;
    p(`    ${k} (ERP ${r.erp_no}): book RM ${(b / 100).toFixed(2)} vs ours RM ${(ours / 100).toFixed(2)} — ${note}`);
  }
  if (moneyReadable) {
    log(
      m === 0
        ? "GOODS RECEIPT MONEY — the ratio probe found 0 priced pair(s) unequal, measured against ac-reconcile-truth.json.gz."
        : `GOODS RECEIPT MONEY — the ratio probe found ${m} priced pair(s) unequal. The TALLY is the authority on ` +
          "which of them is a difference; this says what SHAPE each one has.",
    );
  }

  p("");
  p("NOTHING WAS REPAIRED. A transfer-quantity correction moves an on-hand figure and stock is DEFERRED");
  p("(「库存先不看」). This is a report, not a work order.");
} finally {
  await sql.end({ timeout: 5 });
}
