/* ac-transfer-chain-run — the READS behind the `transfer from` / `transfer to`
 * axes, and nothing else.
 *
 * The owner, 2026-09-08: 「SO PO GR PI SI DO 等等？都解决了吗？ 然后transfer from
 * 和transfer to？」
 *
 * ── WHY IT IS A MODULE AND NOT MORE OF THE RECONCILE ───────────────────────
 * check-ac-erp-reconcile.mjs stands at 1,996 lines under a 2,000-line ceiling
 * that may only FALL (scripts/file-size-ceilings.json). That ceiling is the
 * reason lib/ac-verdict-emit.mjs exists and it is the reason this does too, and
 * both times it was the right call: reading a chain has nothing to do with
 * COMPARING two corpora line by line.
 *
 * ── IT DECIDES NOTHING ──────────────────────────────────────────────────────
 * The verdicts come out of lib/transfer-chain-verdict.mjs — `fromVerdictFor`
 * for the FROM half and, RE-EXPORTED through it, the `verdictFor` that
 * check-ac-transfer-counters.mjs calls for the TO half. This module reads two
 * sides, hands each line to those functions, and records what they say. A
 * second implementation of "different" is the failure this repo has paid for
 * three times (docs/bugs/0689, docs/bugs/0708).
 *
 * ── IT MAY ONLY RECORD ON A DOCUMENT THE RUN ALREADY COMPARED ──────────────
 * `recorder.record()` CREATES a document entry when it has never seen one, and
 * a created entry becomes a verdict ROW, which becomes a compared document,
 * which moves `docCount` — and lib/tally-crosscheck.mjs would then find this
 * report and the reconcile stating different populations and refuse to print
 * anything at all. So every write below is fenced on `seen.has(acDocNo)`, using
 * the recorder's OWN map (`forType`) rather than a set assembled here, and what
 * is skipped is COUNTED and printed. A document this lane cannot attach to is a
 * fact about coverage, not something to drop quietly.
 *
 * ── THE BOOK SIDE IS A SECOND SNAPSHOT, AND THAT IS DELIBERATE ─────────────
 * data/ac-reconcile-truth.json.gz is STRUCTURALLY BLIND to most of this chain,
 * measured on the committed cut rather than assumed: its exporter sets
 * `{ transfered: true }` for SO and PO only, and `fromSoDtlKey` for PO only, so
 * GR/DO/IV/PI carry an empty TransferedQty and no source line at all. The
 * columns this lane needs live in data/ac-convert-edges.json.gz, pulled by
 * export-ac-convert-edges.mjs for exactly this question.
 *
 * Two snapshots of different vintage is a hazard and it is handled the way the
 * rest of this checker handles one: the age is CHECKED against the same limit,
 * and a DtlKey present in one and absent from the other is reported as
 * uncomparable rather than as a difference.
 *
 * ── FAILS SOFT, LIKE `bornAt` AND `zeroMoneyProof` ─────────────────────────
 * A missing or stale chain snapshot, or an ERP column that has moved, makes
 * this lane record NOTHING and say why. It does not take down the twelve
 * questions the reconcile can still answer. Nothing recorded means nothing
 * opened and nothing shut — the axis simply does not appear, and the run says
 * out loud that it did not, which is the difference between "we looked and it
 * agrees" and "we never looked".
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  IS_DIFFERENCE, IS_UNANSWERABLE, FROM_VERDICTS,
  fromVerdictFor, namesSource, runSelfTest,
  TO_VERDICTS, toVerdictFor, runToSelfTest,
} from "./transfer-chain-verdict.mjs";
import { CHAIN_LINE_NOT_STAMPED, CHAIN_PARENT_UNSTAMPED, CHAIN_UNSPECIFIED } from "./unanswerable-causes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/* Which CAUSE each unanswerable FROM verdict is. A MAP and not a ternary on
   purpose: `IS_UNANSWERABLE` has three members today and a fourth added later
   would silently inherit whichever arm a ternary put last, which is the
   "one label, several populations" defect this table exists to prevent. An
   unmapped verdict falls to the unspecified bucket, which the report prints
   WHOLE rather than folding into either real cause. */
const CHAIN_CAUSE_OF = Object.freeze({
  line_not_stamped: CHAIN_LINE_NOT_STAMPED,
  erp_parent_unstamped: CHAIN_PARENT_UNSTAMPED,
});
const SNAP = path.join(here, "..", "data", "ac-convert-edges.json.gz");

/** The axis names this lane records. Declared in lib/so-verdict-derive.mjs. */
export const AXIS_FROM = "transfer from";
export const AXIS_TO = "transfer to";
export const AXIS_UNVERIFIABLE = "transfer chain not verifiable";
/** The note classes this lane uses. Declared in lib/so-verdict-derive.mjs. */
export const NOTE_LINE_NOT_IN_BOOK = "chain-line-not-in-book";
export const NOTE_NO_SOURCE = "chain-no-source";
export const NOTE_NO_ERP_COUNTER = "chain-no-erp-counter";

/* decimal(19,4) on the book side, numeric on ours. Compared as scaled integers:
   a checker that reports 1e-15 as a disagreement is worse than no checker. */
const Q = (v) => Math.round(Number(v || 0) * 10000);
const fmtQ = (n) => (n / 10000).toString();

/* ── ONE EDGE PER CHILD TYPE ────────────────────────────────────────────────
 * `parents` is written out per type rather than composed from an identifier the
 * driver would have to quote. A dynamic table name is one typo away from a
 * query that matches nothing and reads as a clean run, which is the failure
 * check-ac-transfer-counters.mjs's section 1 exists to refuse.
 *
 * `acNo` MUST produce the key check-ac-erp-reconcile.mjs used for the same
 * document, or nothing this lane records can attach. For GR that is the
 * (receipt × purchase order) PAIR — `linked_ac_gr_docno || '|' || the order's
 * number` — because an ERP goods receipt belongs to ONE purchase order while an
 * AutoCount receipt can span several (lib/ac-gr-pair-grain.mjs).
 *
 * `counter` is the ERP's stored transfer-TO ceiling for that line, or null
 * where the ERP stores none. SO->DO and DO->IV have no stored counter at all —
 * delivery is computed off delivery_order_items every time it is asked — so
 * there is nothing that can drift out of step on those edges and nothing to
 * compare. Stated per type rather than left out, so a reader cannot mistake the
 * silence for a clean measurement. */
export function chainEdges({ sql, CO, PDATE }) {
  return [
    {
      t: "SO",
      /* A sales order is the HEAD of the chain: SODTL carries no FromDocType and
         no FromDocNo on any of the 62,732 lines in this book. There is no FROM
         half to ask about, and the TO half is the PURCHASE counter — SODTL has
         TWO, and comparing PO children against `TransferedQty` would be reading
         the DELIVERY counter and calling the difference a defect. */
      bookCounter: "transferedPoQty",
      counterLabel: "how much of the sales-order line has been purchased",
      erpCounter: "scm.mfg_sales_order_items.po_qty_picked",
      bookCounterField: "SODTL.TransferedPOQty",
      noCounterNote:
        "SO->DO carries no stored ERP counter — how much of a sales order has been delivered is computed off " +
        "delivery_order_items every time it is asked, so there is no denormalised number that can drift",
      rows: () => sql`
        SELECT h.linked_ac_docno AS ac_no, h.doc_no AS erp_no,
               i.linked_ac_dtlkey::text AS child_key,
               NULL::text AS parent_a, NULL::text AS parent_b, NULL::text AS parent_line_key,
               FALSE AS has_link,
               i.qty::float8 AS qty, i.po_qty_picked::float8 AS counter,
               (h.${PDATE} IS NOT NULL) AS proceeded
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    },
    {
      t: "PO",
      /* THE ONE EDGE THE BOOK STATES A SOURCE LINE FOR. `PODTL.FromSODtlKey` is
         set on 10,792 rows; `FromDocDtlKey` is NULL on all ~220,000 rows of all
         six detail tables, so every other edge is document grain and no amount
         of wanting changes that. */
      bookCounter: "transferedQty",
      counterLabel: "how much of the purchase-order line has been received",
      erpCounter: "scm.purchase_order_items.received_qty",
      bookCounterField: "PODTL.TransferedQty",
      rows: () => sql`
        SELECT h.linked_ac_docno AS ac_no, h.po_number AS erp_no,
               i.linked_ac_dtlkey::text AS child_key,
               sh.linked_ac_docno AS parent_a, NULL::text AS parent_b,
               si.linked_ac_dtlkey::text AS parent_line_key,
               (i.so_item_id IS NOT NULL) AS has_link,
               i.qty::float8 AS qty, i.received_qty::float8 AS counter,
               (si.id IS NULL OR sh.${PDATE} IS NOT NULL) AS proceeded
          FROM scm.purchase_order_items i
          JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
          LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
          LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
         WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    },
    {
      t: "GR",
      bookCounter: "transferedQty",
      counterLabel: "how much of the goods-receipt line has been invoiced",
      erpCounter: "scm.grn_items.invoiced_qty",
      bookCounterField: "GRDTL.TransferedQty",
      /* PAIR grain, exactly as the reconcile keys this type. `grn_items
         .purchase_order_item_id` is per LINE and nullable — a receipt already
         models lines drawn from several purchase orders — so the parent is read
         off the LINE and not off the receipt's own purchase order. */
      rows: () => sql`
        SELECT g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
               g.grn_number AS erp_no,
               i.linked_ac_dtlkey::text AS child_key,
               pp.linked_ac_docno AS parent_a, NULL::text AS parent_b,
               pi2.linked_ac_dtlkey::text AS parent_line_key,
               (i.purchase_order_item_id IS NOT NULL) AS has_link,
               i.qty_accepted::float8 AS qty, i.invoiced_qty::float8 AS counter,
               TRUE AS proceeded
          FROM scm.grn_items i
          JOIN scm.grns g ON g.id = i.grn_id
          JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
          LEFT JOIN scm.purchase_order_items pi2 ON pi2.id = i.purchase_order_item_id
          LEFT JOIN scm.purchase_orders pp ON pp.id = pi2.purchase_order_id
         WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
           AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`,
    },
    {
      t: "DO",
      bookCounter: null,
      noCounterNote:
        "a delivery order is the END of the delivery chain here — DO->IV carries no stored ERP counter, because " +
        "how much of a delivery order has been invoiced is computed off sales_invoice_items every time it is asked",
      rows: () => sql`
        SELECT h.linked_ac_docno AS ac_no, h.do_number AS erp_no,
               i.linked_ac_dtlkey::text AS child_key,
               sh.linked_ac_docno AS parent_a, NULL::text AS parent_b,
               si.linked_ac_dtlkey::text AS parent_line_key,
               (i.so_item_id IS NOT NULL) AS has_link,
               i.qty::float8 AS qty, NULL::float8 AS counter,
               TRUE AS proceeded
          FROM scm.delivery_order_items i
          JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
          LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
          LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
         WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    },
    {
      t: "IV",
      bookCounter: null,
      noCounterNote:
        "a sales invoice is the end of the sales chain; the ERP stores no onward counter on it",
      /* TWO parents, because the BOOK records two edges into an invoice: IV<-DO
         and, on 169 lines, IV<-SO raised straight off the order with no delivery
         in between. Both are read and the book's own FromDocNo decides which one
         answers — asking only about the delivery order would report every direct
         invoice as a wrong link. */
      rows: () => sql`
        SELECT h.linked_ac_docno AS ac_no, h.invoice_number AS erp_no,
               i.linked_ac_dtlkey::text AS child_key,
               dh.linked_ac_docno AS parent_a, sh.linked_ac_docno AS parent_b,
               NULL::text AS parent_line_key,
               (i.do_item_id IS NOT NULL OR i.so_item_id IS NOT NULL) AS has_link,
               i.qty::float8 AS qty, NULL::float8 AS counter,
               TRUE AS proceeded
          FROM scm.sales_invoice_items i
          JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
          LEFT JOIN scm.delivery_order_items di ON di.id = i.do_item_id
          LEFT JOIN scm.delivery_orders dh ON dh.id = di.delivery_order_id AND dh.company_id = ${CO}
          LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
          LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no AND sh.company_id = ${CO}
         WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    },
    {
      t: "PI",
      bookCounter: null,
      noCounterNote:
        "a purchase invoice is the end of the purchase chain; the ERP stores no onward counter on it",
      /* Same two-parent shape as IV: PIDTL.FromDocNo names a GOODS RECEIPT on
         most lines and a PURCHASE ORDER on the rest, and both are directly
         reachable from our own invoice line through its receipt. */
      rows: () => sql`
        SELECT h.linked_ac_docno AS ac_no, h.invoice_number AS erp_no,
               i.linked_ac_dtlkey::text AS child_key,
               g.linked_ac_gr_docno AS parent_a, p.linked_ac_docno AS parent_b,
               NULL::text AS parent_line_key,
               (i.grn_item_id IS NOT NULL) AS has_link,
               i.qty::float8 AS qty, NULL::float8 AS counter,
               TRUE AS proceeded
          FROM scm.purchase_invoice_items i
          JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
          LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
          LEFT JOIN scm.grns g ON g.id = gi.grn_id AND g.company_id = ${CO}
          LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
         WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    },
  ];
}

/** The ERP columns this lane is DEFINED on. A column that moved must refuse. */
export const REQUIRED_COLUMNS = Object.freeze({
  mfg_sales_order_items: ["company_id", "linked_ac_dtlkey", "po_qty_picked", "qty", "doc_no"],
  purchase_order_items: ["company_id", "linked_ac_dtlkey", "received_qty", "qty", "so_item_id", "purchase_order_id"],
  grn_items: ["company_id", "linked_ac_dtlkey", "invoiced_qty", "qty_accepted", "purchase_order_item_id", "grn_id"],
  delivery_order_items: ["company_id", "linked_ac_dtlkey", "so_item_id", "delivery_order_id"],
  sales_invoice_items: ["company_id", "linked_ac_dtlkey", "do_item_id", "so_item_id", "sales_invoice_id"],
  purchase_invoice_items: ["company_id", "linked_ac_dtlkey", "grn_item_id", "purchase_invoice_id"],
});

/**
 * Load the chain snapshot, or say why not.
 * @returns {{ok: true, book: object, exportedAt: string, ageDays: number, shape: object}
 *          | {ok: false, why: string}}
 */
export function loadChainBook({ maxAgeDays, file = SNAP }) {
  if (!fs.existsSync(file)) {
    return { ok: false, why: `${path.basename(file)} is not in the tree. Refresh it with export-ac-convert-edges.mjs on a machine that can reach the office network` };
  }
  let snap;
  try {
    snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  } catch (e) {
    return { ok: false, why: `${path.basename(file)} could not be read: ${e.message}` };
  }
  const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
  if (!(ageDays <= maxAgeDays)) {
    return {
      ok: false,
      why: `the chain snapshot is ${ageDays.toFixed(1)} days old (limit ${maxAgeDays}). A chain verdict against a stale book would read as coverage we do not have`,
    };
  }
  const L = Object.fromEntries((snap.line_fields || []).map((n, i) => [n, i]));
  for (const f of ["dtlKey", "docNo", "qty", "transferedQty", "transferedPoQty", "fromDocType", "fromDocNo", "fromSoDtlKey"]) {
    if (L[f] === undefined) {
      return { ok: false, why: `the chain snapshot carries no \`${f}\` column, so this axis cannot be computed from it` };
    }
  }
  const H = Object.fromEntries((snap.header_fields || []).map((n, i) => [n, i]));

  /* ── THE THREE FACTS, RE-MEASURED RATHER THAN TRUSTED ──────────────────────
     lib/transfer-chain-verdict.mjs's header states them; this counts them, this
     run, on this cut. `fromDocDtlKey` is exported precisely so its emptiness can
     be PROVED — the day the write-back starts populating it, line-level
     resolution becomes possible for four more edges and this must notice by
     itself rather than going on comparing at document grain for ever. */
  const book = {};
  const shape = {};
  for (const [t, payload] of Object.entries(snap.types || {})) {
    const cancelled = new Set();
    for (const r of payload.headers || []) if (r[H.cancelled] === "T") cancelled.add(r[H.docNo]);
    const byKey = new Map();
    let withSource = 0; let withSourceLine = 0; let withDocType = 0; let withDocDtlKey = 0;
    for (const r of payload.lines || []) {
      const line = {
        docNo: r[L.docNo],
        dtlKey: String(r[L.dtlKey]),
        qty: Q(r[L.qty]),
        transferedQty: r[L.transferedQty] === "" ? null : Q(r[L.transferedQty]),
        transferedPoQty: r[L.transferedPoQty] === "" ? null : Q(r[L.transferedPoQty]),
        fromDocType: r[L.fromDocType] || "",
        fromDocNo: r[L.fromDocNo] || "",
        fromSoDtlKey: r[L.fromSoDtlKey] || "",
      };
      byKey.set(line.dtlKey, line);
      if (namesSource({ bookFromDocNo: line.fromDocNo })) withSource += 1;
      if (line.fromSoDtlKey) withSourceLine += 1;
      if (line.fromDocType) withDocType += 1;
      if (L.fromDocDtlKey !== undefined && r[L.fromDocDtlKey]) withDocDtlKey += 1;
    }
    book[t] = { lines: byKey, cancelled };
    shape[t] = { lines: byKey.size, withSource, withSourceLine, withDocType, withDocDtlKey };
  }
  return { ok: true, book, shape, exportedAt: snap.exported_at, ageDays, source: snap.source };
}

/**
 * Measure the chain for every requested type and RECORD it on the recorder.
 *
 * Returns one report row per type plus the run-level facts, so the caller can
 * print. It prints nothing itself and it decides nothing itself.
 */
export async function recordTransferChain({ sql, CO, PDATE, types, recorder, maxAgeDays }) {
  /* A classifier that cannot classify must not go on reporting confidently.
     Both halves are self-tested BEFORE a row is read — the FROM half here and
     the TO half's own, which is the same function check-ac-transfer-counters.mjs
     refuses on. */
  const selfTest = [...runSelfTest(), ...runToSelfTest()];
  if (selfTest.length) {
    return { applied: false, why: `the transfer-chain classifier failed its own self-test: ${selfTest.join("; ")}`, rows: [] };
  }

  const loaded = loadChainBook({ maxAgeDays });
  if (!loaded.ok) return { applied: false, why: loaded.why, rows: [] };

  /* The columns, from information_schema and not from hope. A join against a
     column that is not there matches nothing and reads as a clean run. */
  let present;
  try {
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = ANY(${Object.keys(REQUIRED_COLUMNS)})`;
    present = new Map();
    for (const r of cols) {
      if (!present.has(r.table_name)) present.set(r.table_name, new Set());
      present.get(r.table_name).add(r.column_name);
    }
  } catch (e) {
    return { applied: false, why: `the ERP columns this axis is defined on could not be read: ${e.message}`, rows: [] };
  }
  const missing = [];
  for (const [tbl, cs] of Object.entries(REQUIRED_COLUMNS)) {
    for (const c of cs) if (!present.get(tbl)?.has(c)) missing.push(`scm.${tbl}.${c}`);
  }
  if (missing.length) {
    return {
      applied: false,
      rows: [],
      why: `scm no longer carries ${missing.join(", ")}. The chain this axis is defined on has moved; nothing is recorded rather than reporting a clean run off a join that matches nothing`,
    };
  }

  const edges = chainEdges({ sql, CO, PDATE }).filter((e) => types.includes(e.t));
  const out = [];

  for (const e of edges) {
    const B = loaded.book[e.t];
    if (!B) {
      out.push({ t: e.t, skipped: `the chain snapshot carries no ${e.t} lines` });
      continue;
    }
    let rows;
    try {
      rows = await e.rows();
    } catch (err) {
      out.push({ t: e.t, skipped: `the ERP side could not be read: ${err.message}` });
      continue;
    }

    /* Only a document the reconcile already COMPARED may be written to. See the
       header: creating one here would move the population and make
       lib/tally-crosscheck.mjs refuse to print anything at all. */
    const seen = recorder.forType(e.t);

    const from = Object.fromEntries(FROM_VERDICTS.map((v) => [v, 0]));
    const to = Object.fromEntries(TO_VERDICTS.map((v) => [v, 0]));
    const r = {
      t: e.t,
      erpLines: rows.length,
      unkeyed: 0,
      keyNotInBook: 0,
      cancelledSkipped: 0,
      notCompared: 0,
      notComparedDocs: new Set(),
      from, to,
      counterGroups: 0,
      counterLabel: e.counterLabel ?? null,
      erpCounter: e.erpCounter ?? null,
      bookCounterField: e.bookCounterField ?? null,
      noCounterNote: e.noCounterNote ?? null,
      examples: { from: [], to: [] },
      bookShape: loaded.shape[e.t],
    };

    /* Grouped for the TO half: one book line can be SEVERAL ERP rows — a sofa is
       one DtlKey and six compartments — so the counter is compared as the
       FRACTION transferred, never as a sum set against a single number. */
    const groups = new Map();

    for (const row of rows) {
      const ac = String(row.ac_no ?? "").trim();
      const key = row.child_key == null ? "" : String(row.child_key).trim();
      if (!key) { r.unkeyed += 1; continue; }
      const bl = B.lines.get(key);
      if (!bl) { r.keyNotInBook += 1; continue; }
      if (B.cancelled.has(bl.docNo)) { r.cancelledSkipped += 1; continue; }
      if (!seen.has(ac)) { r.notCompared += 1; r.notComparedDocs.add(ac); continue; }

      const erpNo = row.erp_no == null ? null : String(row.erp_no).trim();
      const proceeded = row.proceeded === true;

      /* ── THE FROM HALF, PER LINE ───────────────────────────────────────── */
      const parents = [row.parent_a, row.parent_b].map((p) => (p == null ? "" : String(p).trim())).filter(Boolean);
      const v = fromVerdictFor({
        bookFromDocType: bl.fromDocType,
        bookFromDocNo: bl.fromDocNo,
        bookFromLineKey: bl.fromSoDtlKey,
        erpHasLink: row.has_link === true,
        /* Our line may DIRECTLY name two parents (an invoice off a delivery
           order AND off the order behind it). Agreement is against whichever
           one the book names, so the first that matches is passed; when neither
           matches, the first is passed so the message names a real document. */
        erpParentDocNo: parents.find((p) => p.toUpperCase() === String(bl.fromDocNo || "").trim().toUpperCase())
          ?? parents[0] ?? null,
        erpParentLineKey: row.parent_line_key == null ? null : String(row.parent_line_key).trim(),
      });
      from[v] += 1;

      const detail =
        `DtlKey ${key}: the book raised it from ${bl.fromDocType || "(no type)"} ${bl.fromDocNo || "(nothing)"}` +
        (bl.fromSoDtlKey ? ` line ${bl.fromSoDtlKey}` : "") +
        ` — the ERP points at ${parents.length ? parents.join(" / ") : "nothing"}` +
        (row.parent_line_key ? ` line ${row.parent_line_key}` : "");

      if (IS_DIFFERENCE.has(v)) {
        recorder.record(e.t, ac, erpNo, AXIS_FROM, `${v}: ${detail}`, proceeded);
        if (r.examples.from.length < 40) r.examples.from.push({ v, ac, erpNo, detail, proceeded });
      } else if (IS_UNANSWERABLE.has(v)) {
        if (v === "agree_doc_line_unstated") {
          /* THE BOOK ITSELF RECORDS NO SOURCE LINE ON THIS EDGE, and that is a
             property of AutoCount, not a defect of ours: `FromDocDtlKey` is NULL
             on every one of the ~220,000 detail rows. We agree on everything the
             book states. Declared and COUNTED — never locked, and never printed
             as though a line comparison had run. */
          recorder.note(e.t, ac, erpNo, NOTE_LINE_NOT_IN_BOOK, AXIS_FROM, detail, proceeded);
        } else {
          recorder.record(e.t, ac, erpNo, AXIS_UNVERIFIABLE, `${v}: ${detail}`, proceeded);
          /* WHOSE THIS REFUSAL IS, recorded beside it — the same shape
             lib/variant-report.mjs uses for an unreadable sofa, and for the
             same reason. `transfer chain not verifiable` is TWO populations
             owed opposite things: `line_not_stamped` is a key we never stamped
             and closes with a backfill nobody has to rule on, while
             `erp_parent_unstamped` is an ERP-native parent the book has nothing
             to compare against — unanswerable by anyone, the owner included.
             One number covering both is how HC-PO-009828 reached the CANNOT BE
             COMPARED column on run 34257873206 named by no cause at all.

             The verdict is NOT recomputed here: `v` is the value the recorder
             above already used, so the cause and the refusal cannot disagree. */
          recorder.note(
            e.t, ac, erpNo, "unanswerable-cause",
            CHAIN_CAUSE_OF[v] ?? CHAIN_UNSPECIFIED,
            detail, proceeded,
          );
          if (r.examples.from.length < 40) r.examples.from.push({ v, ac, erpNo, detail, proceeded });
        }
      } else {
        recorder.note(e.t, ac, erpNo, NOTE_NO_SOURCE, AXIS_FROM, detail, proceeded);
      }

      /* ── THE TO HALF, ACCUMULATED PER BOOK LINE ────────────────────────── */
      if (e.bookCounter && row.counter != null) {
        let g = groups.get(key);
        if (!g) {
          g = { key, ac, erpNo, bookQty: bl.qty, bookTransfered: bl[e.bookCounter], erpQty: 0, erpCounter: 0, rows: 0, proceeded: false };
          groups.set(key, g);
        }
        g.erpQty += Q(row.qty);
        g.erpCounter += Q(row.counter);
        g.rows += 1;
        if (proceeded) g.proceeded = true;
      }
    }

    if (e.bookCounter) {
      for (const g of groups.values()) {
        if (g.bookTransfered == null) continue;
        r.counterGroups += 1;
        const v = toVerdictFor(g);
        to[v] += 1;
        if (v === "agree" || v === "book_qty_zero" || v === "erp_qty_zero") continue;
        const detail =
          `DtlKey ${g.key}: the book moved ${fmtQ(g.bookTransfered)} of ${fmtQ(g.bookQty)}; ` +
          `the ERP records ${fmtQ(g.erpCounter)} of ${fmtQ(g.erpQty)} over ${g.rows} row(s)`;
        recorder.record(e.t, g.ac, g.erpNo, AXIS_TO, `${v}: ${detail}`, g.proceeded);
        if (r.examples.to.length < 40) r.examples.to.push({ v, ac: g.ac, erpNo: g.erpNo, detail, proceeded: g.proceeded });
      }
    } else {
      /* NO STORED COUNTER ON THIS EDGE. Declared per document rather than left
         silent: a reader must not take an empty column for a clean measurement.
         Recorded once per compared document of this type. */
      for (const [ac, d] of seen) {
        recorder.note(e.t, ac, d.erpNo, NOTE_NO_ERP_COUNTER, AXIS_TO, e.noCounterNote, true);
      }
    }

    r.notComparedDocs = [...r.notComparedDocs];
    out.push(r);
  }

  return {
    applied: true,
    why: null,
    exportedAt: loaded.exportedAt,
    ageDays: loaded.ageDays,
    source: loaded.source,
    shape: loaded.shape,
    rows: out,
  };
}
