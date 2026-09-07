#!/usr/bin/env node
/* check-ac-erp-reconcile — "确保全部 SO PO GR DO SI PI 都是对的,并且里面的数据
 * 都是对的" (owner, 2026-09-07, go-live day).  Six document types, both
 * directions, document level AND line level AND money.
 *
 * READ-ONLY.  One Postgres connection, SELECTs only.  Every legitimate answer
 * — including a large gap — exits 0, because the ANSWER is the output and a
 * red job reads as "the check broke" (CLAUDE.md, the check-soak-gate rules).
 * Non-zero is reserved for the check being UNABLE TO ANSWER: unreachable DB,
 * a missing or stale AutoCount snapshot, or a matcher that proves itself
 * broken at startup.
 *
 * ── WHAT IT COMPARES ────────────────────────────────────────────────────────
 *   1. DOCUMENT LEVEL   AutoCount doc numbers absent from the ERP, and ERP
 *                       documents claiming an AutoCount number the book does
 *                       not have.  Counts plus the first 20 each way.
 *   2. LINE LEVEL       for documents present on both sides: line COUNT, and
 *                       per line the item code, quantity, unit price, keyed on
 *                       the AutoCount line key (DtlKey) where the ERP carries
 *                       one and on document order where it does not.
 *   3. MONEY            document total on each side.
 *   4. VARIANTS         "还有里面的variant 啊 col divan gap 等等 / 所以你要拿目前的
 *                       orders 去对比autocount的数据什么不一样" (owner, 2026-09-07).
 *                       For every paired line, AutoCount's own Desc2 is decoded
 *                       with the WRITERS' decoders and compared against the ERP
 *                       line's `variants` jsonb, axis by axis: colour/fabric,
 *                       divan, gap, leg, T.Heights, seat size, sofa
 *                       compartments (as a MULTISET) and specials.  Counts and
 *                       the first 20 examples per axis with both values side by
 *                       side, and every count split PROCEEDED / not proceeded —
 *                       an unconfirmed order is allowed to be blank.
 *                       The comparison itself is lib/variant-reconcile.mjs;
 *                       read its header before changing what "different" means.
 *
 * ── THE DO RULE (the owner's; NOT a bug to fix) ─────────────────────────────
 * Outstanding = NOT yet transferred to a DO.  The migration carried the
 * OUTSTANDING population, so a fully-delivered sales order absent from the ERP
 * is CORRECT, not a gap.  Every "missing" figure is therefore split: IN-SCOPE
 * MISSING (a real gap) and OUT-OF-SCOPE ABSENT (the rule working).  The scope
 * predicates are not invented here — they are the ones export-ac-reimport.py
 * runs against the book, restated over the raw columns in the snapshot:
 *
 *   SO  Cancelled='F', DocNo NOT LIKE 'HC-%'/'ZZ%', >=1 line with
 *       Qty > TransferedQty, and NOT invoiced direct (no IVDTL with
 *       FromDocType='SO' pointing at it — the completed cash sale the owner
 *       excluded 2026-08-10).
 *   PO  Cancelled='F', not a test doc, and either >=1 line with
 *       Qty > TransferedQty (lane 1) or raised for a line of an outstanding SO
 *       (lane 2, FromSODtlKey or FromDocNo).
 *   GR  stamped onto an in-scope PO by stamp-ac-grn-refs.mjs.
 *   DO  Cancelled='F', >=1 line with FromDocType='SO' pointing at an
 *       outstanding SO — the mirror set of ac-partial-dos.json.gz.
 *   IV  no population: the owner declined the historical import ("这个不要",
 *   PI  DECLARED_DIFFERENCES in check-migration-fidelity.mjs).  What the ERP
 *       holds is post-cutover mirroring, so an absent historical invoice is a
 *       DECISION, and is counted apart from the gaps.
 *
 * ── THE THREE TRAPS THIS CHECK IS BUILT AROUND ──────────────────────────────
 * 1. scm.grns.linked_ac_docno holds the PO's AutoCount number, NOT the GR's.
 *    The RECEIPT number is a separate column, scm.grns.linked_ac_gr_docno,
 *    added 2026-09-07 with the reshape; the older array
 *    purchase_orders.linked_ac_grn_docnos is still the presence pointer for a
 *    receipt no document stands for.  Matching GR the obvious way reported all
 *    216 as missing once already (check-ac-erp-doc-links.mjs:104).
 *
 *    GR LINE data IS compared now, at (receipt x purchase order) PAIR grain.
 *    It used to be skipped, correctly, because grn_items.qty_received was
 *    DERIVED from the PO line and one ERP GRN covered a whole PO.
 *    reshape-migrated-grns.mjs removed both reasons: the quantity is now the
 *    BOOK's own and the document is one receipt's worth of one purchase order.
 *    The unit PRICE is still taken from the purchase-order line, so it stays
 *    DECLARED rather than counted as a gap.
 * 2. Item codes are TRANSLATED through data/autocount-erp-mapping-1561.csv.
 *    An untranslated comparison reports the whole catalogue as wrong.
 * 3. SOFA lines decompose: one AutoCount line becomes one ERP line per
 *    compartment, price riding the lead piece.  Line count and per-line unit
 *    price are then not commensurable, so for any document whose ERP lines
 *    carry a compartment suffix those two findings are counted as DECLARED,
 *    not as gaps — the document TOTAL still has to match to the cent, and it
 *    is checked.
 *
 * ── SELF-TEST ───────────────────────────────────────────────────────────────
 * A checker that cannot match must refuse, never report a clean run.  Before
 * comparing anything it proves, per type, that its doc-number matcher and its
 * DtlKey matcher actually hit the snapshot, and that the item-code map loaded;
 * a type whose ERP rows carry links of which NONE resolve exits 2.
 *
 * The variant half has its own three refusals, for the same reason: a snapshot
 * with no Desc2 at all, a fabric library that loaded almost nothing, and a
 * decoder that no longer decodes the five measured Desc2 shapes in
 * lib/variant-reconcile.mjs's SELF_TEST.  A document type that produced no
 * comparable bedframe or sofa line SAYS SO in its own section rather than
 * printing an empty table that reads as agreement.
 *
 * RE-RUN: read-only, so a second run answers again from current state — which
 * is the point: it runs again after the delta migration.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { mapSpecial as mapBedframeSpecial } from "./lib/bedframe-special-map.mjs";
import { K as SK, mapPhrase as mapSofaPhrase, skey } from "./lib/sofa-special-map.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
import {
  AGREE, AXES, BOOK_BLANK, DIFFER, ERP_BLANK, PENDING, RECORDED, UNREADABLE, VARIANT_GROUPS, VERDICTS,
  compareLine, decodeBook, runSelfTest,
} from "./lib/variant-reconcile.mjs";

import { buildScope, currencyVerdict, decodeSnapshot, isTestDoc, LOCAL_CURRENCY } from "./lib/ac-scope.mjs";
import { FIELD_MAP } from "./lib/ac-field-identity.mjs";
import {
  compareType, loadAcFieldSide, loadErpFieldSide, measurePoDiscount,
  runSelfTest as runFieldSelfTest,
} from "./lib/ac-field-identity-run.mjs";
import { printFieldTable, printPoDiscount } from "./lib/ac-field-identity-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const SNAP = path.join(DATA, "ac-reconcile-truth.json.gz");
const MAP_CSV = path.join(DATA, "autocount-erp-mapping-1561.csv");
const CO = Number(process.env.COMPANY_ID || 1); // AED_HOUZS is company 1
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
/* The owner asked for the first 20 offenders each way, and 20 is the right
   default for a status read. It is overridable because ONE axis needs the whole
   list rather than a sample: a sofa compartment disagreement is adjudicated by a
   person reading both builds piece by piece against the slip
   (sofa-slip-notation — the photo and the Desc2 are read TOGETHER), and
   "... 12 more" is exactly the 12 he cannot adjudicate. */
const SHOW = Math.max(1, Number(process.env.SHOW || 20));

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error(
    `REFUSED: ${SNAP} is missing. Run backend/scripts/export-ac-reconcile-truth.mjs against the book first.`,
  );
  process.exit(2);
}

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
plain(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
plain(`source=${snap.source}`);
plain(`book rows: ${JSON.stringify(snap.counts)}`);
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(
    `REFUSED: the AutoCount snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}). ` +
      "Re-run export-ac-reconcile-truth.mjs — a verdict against a stale book would read as coverage we do not have. " +
      "The file mtime is a checkout artifact and is deliberately not consulted (bugs 0560/0561/0563 are that class).",
  );
  process.exit(2);
}

/* ── item-code translation (trap 2) ──────────────────────────────────────── */
const codeMap = new Map();
{
  const rows = fs.readFileSync(MAP_CSV, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  rows.shift();
  for (const line of rows) {
    const [ac, erp] = line.split(",");
    if (ac && erp) codeMap.set(ac.trim().toUpperCase(), erp.trim().toUpperCase());
  }
}

/* ── snapshot -> typed rows ──────────────────────────────────────────────── */
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const mapped = (s) => codeMap.get(norm(s)) ?? norm(s);
/* Trap 3.  An AutoCount sofa line is one ERP line PER COMPARTMENT, so the
   codes are "DSL-8051 SOFA" against "8051-1A(LHF)" and only the MODEL is
   commensurable — which is exactly what check-migration-fidelity.mjs declares
   ("item_code beyond the model prefix" is not compared).  The model is the
   first run of 3+ digits on each side; "AMN-SF9028 SOFA" and "9028-1A(LHF)"
   both yield 9028, and "DSL-8030 SOFA" against "9058-1A(LHF)" does NOT — that
   one is a real finding and stays one.

   TWO CORRECTIONS, 2026-09-07 (go-live), both measured against production:

   (a) THE MODEL MUST BE FOLDED THROUGH SOFA_MODEL_ALIAS.  The floor writes the
       same sofa under an internal number and a catalogue number — 5530/9028,
       5536/9058, 5537/8030, 5540/8030 — and the other scripts in this
       directory fold it before comparing (`git grep -l "SOFA_MODEL_ALIAS\["
       -- backend/scripts` is the live list; do not trust a count typed here).
       This checker did not, so "HOK-5536 SOFA" against "9058-2A(LHF)" read as
       a defect while the importers called them the same sofa.  12 lines.

   (b) A NO-MODEL PAIR IS NOT AUTOMATICALLY A DEFECT.  isSofaCode is a /SOFA/
       substring test, so "AMN-SOFA PILLOW" — an accessory whose NAME contains
       the word — takes the sofa branch, yields NO model on either side, and
       fell through to the finding list even when the two codes were BYTE
       IDENTICAL ("AMN-SOFA PILLOW" vs "AMN-SOFA PILLOW").  When neither side
       yields a model the codes themselves are perfectly comparable, so they
       are compared, exactly as the non-sofa branch does.  A pair where only
       ONE side has a model is still a real finding and stays one. */
const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));
const rawModelOf = (s) => (String(s ?? "").match(/\d{3,}/) || [null])[0];
const modelOf = (s) => {
  const m = rawModelOf(s);
  return m == null ? null : SOFA_MODEL_ALIAS[m] || m;
};

/* ── the book's own build text (the VARIANT half) ─────────────────────────── */
/* A snapshot cut before 2026-09-07 carries no Desc2 at all, and a variant
   verdict computed over nothing would read as "the variants agree".  Refuse. */
const HAS_DESC2 = Array.isArray(snap.desc2_fields) && snap.desc2_fields.length === 2;
if (!HAS_DESC2) {
  console.error(
    "REFUSED: this AutoCount snapshot carries no Desc2 (no `desc2_fields`), so the variants inside " +
      "each line cannot be compared. Re-run export-ac-reconcile-truth.mjs — the version that pulls " +
      "Desc2 in bounded key windows. Reporting a clean variant run against a snapshot that never read " +
      "the build text would be a verdict computed over nothing.",
  );
  process.exit(2);
}

const book = decodeSnapshot(snap);

/* ── scope: the population the migration was defined to carry ────────────── */
/* The definition itself lives in scripts/lib/ac-scope.mjs and is stated ONCE.
   It used to be restated here, over the snapshot columns, while
   export-ac-reimport.py stated it as SQL against the book — and two statements
   of one rule is how a checker comes to measure a population no importer ever
   carried.  check-ac-gap-attribution.mjs reads the same module, so the check
   and the attribution can never disagree about who is in scope. */
const SCOPE = buildScope(book);

/* ── goods receipts, restated at (receipt × purchase order) grain ───────── */
/* The book states a receipt once, with lines raised from several purchase
   orders. The ERP cannot: `scm.grns.purchase_order_id` is one purchase order.
   So the BOOK is restated at the grain the ERP can hold, rather than the ERP
   being compared against a document it is structurally unable to mirror.

   The population is derived from `SCOPE.GR` and `SCOPE.PO` — both from
   `lib/ac-scope.mjs`, so the pair scope cannot drift away from the document
   scope the rest of this file uses. A pair "document" carries the receipt's own
   date and currency, and a total that is the sum of ITS OWN lines, which is the
   only total the ERP document can be expected to equal. */
function grPairGrain() {
  const headers = new Map();
  const lines = new Map();
  const byDtlKey = new Map();
  const scope = new Set();
  for (const gr of SCOPE.GR) {
    const h = book.GR.headers.get(gr);
    if (!h) continue;
    for (const l of book.GR.lines.get(gr) || []) {
      if (l.fromDocType !== "PO" || !l.fromDocNo || !SCOPE.PO.has(l.fromDocNo)) continue;
      const key = `${gr}|${l.fromDocNo}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(l);
      byDtlKey.set(l.dtlKey, l);
      scope.add(key);
    }
  }
  for (const [key, ls] of lines) {
    const h = book.GR.headers.get(key.split("|")[0]);
    const sum = (f) => (ls.every((l) => l[f] == null) ? null : ls.reduce((s, l) => s + (l[f] ?? 0), 0));
    headers.set(key, {
      docNo: key,
      docDate: h.docDate,
      cancelled: h.cancelled,
      totalSen: sum("subTotalSen"),
      docTotalSen: sum("docSubTotalSen"),
      lineCount: ls.length,
      currency: h.currency,
      rate: h.rate,
    });
  }
  return { view: { headers, lines, byDtlKey, desc2: book.GR.desc2 }, scope };
}
const GR_PAIR = grPairGrain();
const soScope = SCOPE.SO;
/* Diagnostic only, NOT part of the definition: the orders the DO rule keeps
   out, reported at the end so the exclusion stays visible. */
const soFullyDelivered = new Set();
const soInvoicedDirect = new Set();
for (const ls of book.IV.lines.values()) {
  for (const l of ls) if (l.fromDocType === "SO" && l.fromDocNo) soInvoicedDirect.add(l.fromDocNo);
}
for (const [docNo, h] of book.SO.headers) {
  if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
  const ls = book.SO.lines.get(docNo) || [];
  if (ls.length && ls.every((l) => (l.qty ?? 0) <= (l.transferedQty ?? 0))) soFullyDelivered.add(docNo);
}

/* ── ERP side ────────────────────────────────────────────────────────────── */
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
/* The ONE name of the Processing Date column, spliced as SQL TEXT rather than
   bound as a parameter — postgres.js would send `h.$1 IS NOT NULL` otherwise.
   See lib/so-processing-date.mjs; migration 0286 renamed the column and eleven
   scripts went on naming the old one, which fails the WHOLE statement. */
const PDATE = soProcessingDateFragment(sql);
const refuse = async (msg) => {
  console.error(`REFUSED: ${msg}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
};

/* One config per type.  `docs`/`lines` are whole SELECTs because every table
   names its columns differently (grn_items.qty_received, not qty; the SO line
   table joins on doc_no, not on a numeric parent id).  `absenceIs` says how to
   report an in-scope AutoCount document the ERP does not have. */
const TYPES = [
  {
    t: "SO",
    label: "Sales Order",
    absenceIs: "GAP",
    docs: () => sql`SELECT doc_no AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, subtotal_sen) AS total_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        (h.${PDATE} IS NOT NULL) AS proceeded
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "PO",
    label: "Purchase Order",
    absenceIs: "GAP",
    docs: () => sql`SELECT po_number AS erp_no, linked_ac_docno AS ac_no, total_sen
      FROM scm.purchase_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        /* A PO line dedicated to an SO line inherits that order's state, because
           the customer's "not chosen yet" is what makes a blank legitimate. A
           PO line with no dedication is PROCEEDED: every purchase order in this
           ERP is at least SUBMITTED (measured 2026-09-07: 296 RECEIVED, 180
           SUBMITTED, 23 PARTIALLY_RECEIVED, nothing in a draft state), so the
           supplier is already being asked to build it. */
        (si.id IS NULL OR sh.${PDATE} IS NOT NULL) AS proceeded
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "GR",
    label: "Goods Received",
    absenceIs: "GAP",
    /* GOODS RECEIPTS ARE COMPARED AT PAIR GRAIN, and that is a decision worth
       reading before changing.

       This section used to print "line and money comparison NOT APPLICABLE" and
       stop, for two reasons that were both true: `grn_items.qty_received` was
       DERIVED from the purchase-order line rather than copied from the book, and
       ONE ERP goods receipt covered a whole purchase order while an AutoCount
       receipt can span several. Comparing those would have measured our own
       derivation. But "not applicable" then read as "checked", and the contents
       of the migrated receipts went unexamined right up to go-live.

       Both reasons were removed by `reshape-migrated-grns.mjs` (owner 2026-09-07:
       「是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」): the ERP now holds one document per
       (AutoCount receipt × purchase order), carrying the book's own receipt date
       and the book's own received quantity, and each one names its receipt in
       `scm.grns.linked_ac_gr_docno`.

       PAIR, not receipt, because `scm.grns.purchase_order_id` is a SINGLE
       purchase order and 51 of the 214 in-scope receipts cover more than one.
       Comparing at RECEIPT grain would report every one of those 51 as short by
       the part of it raised against another purchase order — a shortfall the ERP
       is structurally incapable of not having. The pair is the finest grain both
       sides can state, and at that grain the comparison is like-for-like. */
    pairGrain: true,
    sofaAware: true,
    priceDeclared:
      "grn_items.unit_price_sen is taken from the PURCHASE ORDER line by design, not from GRDTL.UnitPrice — " +
      "reshape-migrated-grns.mjs copies the book's item, quantity and date, and leaves price to the order",
    docs: () => sql`SELECT g.grn_number AS erp_no,
        g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
        COALESCE(g.total_sen, 0) AS total_sen
      FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
        AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
        i.item_code, i.qty_accepted::float8 AS qty, i.unit_price_sen,
        NULL::bigint AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
      JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
        AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`,
    /* The other half of the presence axis: receipt numbers stamped on the
       purchase order by stamp-ac-grn-refs.mjs, which carry no ERP document.
       Restated at pair grain so it is commensurable with the documents. */
    pointers: () => sql`SELECT DISTINCT g || '|' || p.linked_ac_docno AS ac_no, p.po_number AS erp_no
      FROM scm.purchase_orders p, unnest(p.linked_ac_grn_docnos) g
      WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "DO",
    label: "Delivery Order",
    /* CORRECTED 2026-09-07 (the second go-live round). This said DECISION, and
       printed every absent delivery order as "(owner-declined)". The owner
       declined importing the DELIVERY HISTORY — 11,443 documents — and that
       still stands; it never meant that a delivery raised against an order the
       ERP holds stays behind. `ac-scope.mjs` has always given DO a real,
       non-empty population (84 documents), so the label was describing a
       population that does not exist: it read a GAP out as a decision, which is
       precisely the failure this reconcile exists to prevent. Measured the same
       day: DO-001800 -> SO-002281 and DO-005583 -> SO-007435, both un-cancelled,
       both against orders with undelivered lines, both printed as "declined".
       The invariant below now refuses the label over a non-empty scope, so the
       constant and `ac-scope.mjs` cannot drift apart again. */
    absenceIs: "GAP",
    sofaAware: true,
    itemCodeDeclared:
      "delivery_order_items.item_code is taken from the SALES ORDER line by design, not from DODTL.ItemCode",
    docs: () => sql`SELECT do_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, 0) AS total_sen
      FROM scm.delivery_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "IV",
    label: "Sales Invoice",
    /* Same correction, same day, same reason as DO above. `ac-scope.mjs` was
       already corrected on 2026-09-07 with the owner's own ruling —
       「没有的 SO DO 何来发票？有的 SO DO 自然要发票」 — and gave IV a 47-document
       population; this constant went on saying DECISION, so all 7 absentees
       printed as "owner-declined". */
    absenceIs: "GAP",
    sofaAware: true,
    docs: () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(total_sen, local_total_sen) AS total_sen
      FROM scm.sales_invoices WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.sales_invoice_items i
      JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "PI",
    label: "Purchase Invoice",
    /* Same correction as DO and IV. 192 in the population, 21 absent — a gap,
       not a decision. What blocks the 21 is the money gate inside
       create-migrated-invoices.mjs, not the absence of a source to convert
       from; see docs/autocount-cutover-ledger.md. */
    absenceIs: "GAP",
    docs: () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no, total_sen
      FROM scm.purchase_invoices WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    /* The other half of the purchase-invoice link: pointers stamped on the PO
       by stamp-ac-grn-refs.mjs, which carry no ERP document. */
    pointers: () => sql`SELECT DISTINCT g AS ac_no, p.po_number AS erp_no
      FROM scm.purchase_orders p, unnest(p.linked_ac_pinv_docnos) g
      WHERE p.company_id = ${CO}`,
  },
];

const erp = {};
try {
  for (const cfg of TYPES) {
    erp[cfg.t] = {
      docs: cfg.docs ? await cfg.docs() : [],
      lines: cfg.lines ? await cfg.lines() : [],
      pointers: cfg.pointers ? await cfg.pointers() : [],
    };
  }
} catch (e) {
  await refuse(`the ERP database could not be read: ${e.message}`);
}

/* ── self-test: prove the matchers hit before trusting any verdict ───────── */
{
  const problems = [];
  if (codeMap.size < 100) {
    problems.push(`the item-code map loaded only ${codeMap.size} rows from ${MAP_CSV}`);
  }
  for (const cfg of TYPES) {
    const t = cfg.t;
    /* The GR side claims a PAIR key, so it must be proved against the PAIR
       view. Proving it against the receipt-grain headers would resolve nothing
       and refuse the whole run. */
    const bk = cfg.pairGrain ? GR_PAIR.view : book[t];
    const claims = [
      ...erp[t].docs.filter((d) => d.ac_no).map((d) => String(d.ac_no).trim()),
      ...erp[t].pointers.map((d) => String(d.ac_no).trim()),
    ];
    if (claims.length === 0) continue;
    const hit = claims.filter((a) => bk.headers.has(a)).length;
    if (hit === 0) {
      problems.push(
        `${t}: ${claims.length} ERP rows claim an AutoCount number and NOT ONE resolves against ` +
          `${bk.headers.size} ${t} headers in the snapshot — the doc-number matcher is broken, not the data.`,
      );
    }
    const keyed = erp[t].lines.filter((l) => l.ac_dtlkey != null);
    if (keyed.length) {
      const kHit = keyed.filter((l) => bk.byDtlKey.has(String(l.ac_dtlkey).trim())).length;
      if (kHit === 0) {
        problems.push(
          `${t}: ${keyed.length} ERP lines carry linked_ac_dtlkey and NOT ONE resolves against the ` +
            "snapshot's DtlKeys — the line-key matcher is broken.",
        );
      }
    }
  }
  /* The field-identity comparators prove themselves on PLANTED defects before
     any of them is trusted — a comparator that cannot find a defect it is
     handed will report a clean run over real data. */
  for (const c of runFieldSelfTest()) {
    problems.push(`field-identity comparator failed its own case: ${c.name}${c.error ? ` (${c.error})` : ""}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`SELF-TEST FAILED — ${p}`);
    await refuse("the matchers do not match; refusing to report a clean run.");
  }
  plain(
    `self-test: item-code map ${codeMap.size} rows; doc-number and DtlKey matchers resolve for every ` +
      "type that claims one. Proceeding.",
  );
}

/* ── the variant side: masters, decoders, and their own self-test ─────────── */
/* Every decoder is the writers' own. Nothing here re-implements a Desc2 rule —
   see the header of lib/variant-reconcile.mjs for why that matters. */
let V = null;
try {
  /* `active` is read on purpose. The fabric library renumbered itself on
     2026-08-11 (one-digit tails became two, predecessors kept as active=false),
     the account book was never rewritten, and a matcher without `active`
     answers with the DEAD row — which is how 166 sofa lines lost their colour.
     buildFabricColourIndex follows the supersession only when it is told. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label, active
    FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const prodCodes = new Set(
    (await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`).map((p) =>
      String(p.code ?? "").trim().toUpperCase(),
    ),
  );
  const addons = await sql`SELECT code, label, categories FROM scm.special_addons WHERE company_id = ${CO}`;
  const sofaLive = new Map();
  for (const r of addons.filter((x) => (x.categories || []).some((c) => /sofa/i.test(String(c))))) {
    sofaLive.set(SK(r.code), r.code);
    if (r.label) sofaLive.set(SK(r.label), r.code);
  }
  const bedLive = new Set(addons.filter((x) => (x.categories || []).includes("BEDFRAME")).map((r) => r.code));

  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const knownColour = (c) => {
    const h = findColour(c);
    return h ? h.colour_id : null;
  };
  V = {
    parseBedframe,
    parseSofa,
    isPendingColour,
    modelAlias: SOFA_MODEL_ALIAS,
    knownColour,
    reclOf: (m) => RECL.some((s) => prodCodes.has(`${m}${s}`.toUpperCase())),
    /* A colour is compared as the library row it names, never as a spelling. */
    colourIdentity: (text) => {
      const h = findColour(text);
      return h ? `${h.fabric_id}|${h.colour_id}` : null;
    },
    /* The picker codes a Desc2 phrase asks for. Where no code exists the phrase
       itself is what the owner asked to be carried ("没有的才用 customs others
       那边写进去"), so it is returned as the wanted item. */
    mapSpecials: (phrases, group) => {
      const want = [];
      for (const p of phrases) {
        if (group === "sofa") {
          const codes = sofaLive.has(SK(p)) ? [sofaLive.get(SK(p))] : mapSofaPhrase(p, sofaLive);
          want.push(...(codes.length ? codes : [p]));
        } else {
          const codes = bedLive.has(p) ? [p] : mapBedframeSpecial(p).filter((x) => bedLive.has(x));
          want.push(...(codes.length ? codes : [p]));
        }
      }
      return [...new Set(want)];
    },
    /* Free text and a picker code are the same request written two ways, so a
       carried value counts when either spelling contains the other. */
    specialCarried: (wanted, carried) => {
      const w = skey(wanted);
      if (!w) return true;
      return carried.some((c) => {
        const k = skey(c);
        return !!k && (k.includes(w) || w.includes(k));
      });
    },
    masters: { fabricColours: fcRows.length, products: prodCodes.size, sofaAddons: sofaLive.size, bedAddons: bedLive.size },
  };
} catch (e) {
  await refuse(`the variant masters could not be read: ${e.message}`);
}
{
  const problems = runSelfTest(V);
  if (V.masters.fabricColours < 50) {
    problems.push(`only ${V.masters.fabricColours} fabric colours loaded for company ${CO} — the colour matcher would answer null for everything`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`VARIANT SELF-TEST FAILED — ${p}`);
    await refuse(
      "the Desc2 decoders do not decode; refusing to report that the variants agree. " +
        "A verdict computed over nothing must never read as a pass.",
    );
  }
  plain(
    `variant self-test: ${V.masters.fabricColours} fabric colours, ${V.masters.products} product codes, ` +
      `${V.masters.sofaAddons} sofa + ${V.masters.bedAddons} bedframe add-on keys; ` +
      "every decoder case decoded as measured. Proceeding.",
  );
}

/* ── compare ─────────────────────────────────────────────────────────────── */
const rm = (s) => (s == null ? "null" : (Number(s) / 100).toFixed(2));
const first = (a) => a.slice(0, SHOW);
const summary = [];
const variantTotals = [];
const SHOW_BOOK_BLANK = 5; // the direction that is NOT work; enough to see it exists

/**
 * The variant reconcile for one document type.
 *
 * `rows` is one entry per AutoCount line that reached the ERP, carrying the ERP
 * lines it became — the sofa split means that is often more than one.  `desc2`
 * is the book's own build text by DtlKey; a line absent from it is a line the
 * book said nothing about, which is BOOK-BLANK on every axis and NOT unknown.
 *
 * Every count is split PROCEEDED / not proceeded, because the owner's rule is
 * that an unconfirmed order may legitimately be blank and quoting the combined
 * figure as the backlog has already cost him time twice.
 */
function reportVariants(t, label, rows, desc2) {
  const tally = {};
  for (const a of AXES) tally[a.key] = { yes: {}, no: {} };
  for (const a of AXES) for (const half of ["yes", "no"]) for (const v of VERDICTS) tally[a.key][half][v] = 0;
  const offenders = {};
  const bookBlanks = {};
  for (const a of AXES) {
    offenders[a.key] = [];
    bookBlanks[a.key] = [];
  }
  const pop = { total: rows.length, modelled: 0, bedframe: 0, sofa: 0, other: 0, withDesc2: 0, proceeded: 0 };
  let unkeyedSofa = 0;

  for (const r of rows) {
    const lead = r.erpLines[0] || {};
    const group = String(lead.item_group ?? "").toLowerCase();
    if (!VARIANT_GROUPS.has(group)) {
      pop.other++;
      continue;
    }
    pop.modelled++;
    pop[group]++;
    const text = desc2.get(r.acLine.dtlKey) || "";
    if (text) pop.withDesc2++;
    /* `proceeded` is a per-line fact carried from the ERP query, not inferred
       here: an order with a Processing Date is what the factory is building. */
    const proceeded = lead.proceeded === true;
    if (proceeded) pop.proceeded++;
    const book = decodeBook(V, { desc2: text, itemGroup: group, itemCode: lead.item_code });
    const { axes } = compareLine(V, { book, erpLines: r.erpLines, proceeded });
    /* THE COMPARTMENT AXIS NEEDS THE WHOLE BUILD, AND ONLY THE LINE KEY CAN
       REGROUP IT. One AutoCount sofa line becomes one ERP line per piece; the
       pieces are recognisable as one build because they share
       linked_ac_dtlkey. Where the ERP lines carry no key the pairing above
       falls back to value and then to document order, which returns ONE ERP
       line per AutoCount line — so a five-piece build would be compared against
       one piece and reported as four missing compartments that are not missing
       at all. Say the axis is unanswerable instead of answering it wrongly. */
    if (axes.compartments && !r.erpLines.every((l) => l.ac_dtlkey != null)) {
      axes.compartments.verdict = UNREADABLE;
      axes.compartments.book = axes.compartments.book || "(not regroupable)";
      axes.compartments.detail =
        "the ERP lines of this document carry no AutoCount line key, so the pieces of one build cannot be regrouped";
      unkeyedSofa++;
    }
    const half = proceeded ? "yes" : "no";
    for (const [key, cell] of Object.entries(axes)) {
      tally[key][half][cell.verdict]++;
      const where = `${r.ac} DtlKey ${r.acLine.dtlKey} (ERP ${r.erpNo} ${lead.item_code ?? "?"})`;
      const both = `AutoCount "${cell.book || "(blank)"}" vs ERP "${cell.erp || "(blank)"}"` +
        (cell.detail ? ` — ${cell.detail}` : "");
      if (cell.verdict === DIFFER || (cell.verdict === ERP_BLANK && proceeded)) {
        offenders[key].push({
          differ: cell.verdict === DIFFER,
          proceeded,
          line: `${where}: ${both}${proceeded ? "" : "  [NOT PROCEEDED]"}`,
        });
      } else if (cell.verdict === BOOK_BLANK) {
        bookBlanks[key].push(`${where}: ${both}`);
      }
    }
  }

  plain("");
  plain(`─────────── ${t} — ${label}: THE VARIANTS INSIDE THE LINE ───────────`);
  if (!pop.total) {
    log(`${t} VARIANTS — no AutoCount line of this type paired to an ERP line, so nothing was compared. NOT a clean run.`);
    return { t, pop, tally, comparable: false };
  }
  plain(
    `${pop.total} AutoCount lines paired to an ERP line; ${pop.modelled} carry a variant-bearing item group ` +
      `(${pop.bedframe} bedframe, ${pop.sofa} sofa) and ${pop.other} do not (accessory, mattress, service — no axes to compare). ` +
      `${pop.withDesc2} of the ${pop.modelled} have a build text in the book; ${pop.proceeded} are on a PROCEEDED order.`,
  );
  if (!pop.modelled) {
    log(`${t} VARIANTS — no bedframe or sofa line on this document type. Nothing to compare; NOT a clean run.`);
    return { t, pop, tally, comparable: false };
  }

  plain("axis                 |                 PROCEEDED (the backlog)                  |             not proceeded (blank is OK)");
  plain("                     |  agree  ERPblank  bookblank  differ  pend  unread  recorded |  agree  ERPblank  bookblank  differ  pend  unread  recorded");
  for (const a of AXES) {
    const y = tally[a.key].yes;
    const n = tally[a.key].no;
    const seen = VERDICTS.reduce((s2, v) => s2 + y[v] + n[v], 0);
    if (!seen) continue;
    const cells = (h) => [h[AGREE], h[ERP_BLANK], h[BOOK_BLANK], h[DIFFER], h[PENDING], h[UNREADABLE], h[RECORDED]]
      .map((x, i) => String(x).padStart([6, 9, 10, 7, 5, 7, 10][i]));
    plain(`${a.label.padEnd(20)} | ${cells(y).join(" ")} | ${cells(n).join(" ")}`);
  }
  plain(
    "ERPblank on a PROCEEDED order is the only column that is WORK. bookblank is the ERP holding a value the " +
      "book never stated — an operator filled it in, which is allowed. pend = the book says TBC/KIV.",
  );
  plain(
    "recorded = the book asks for a PRICED special the line does not tick, and variants.specialsRecorded already " +
      "carries it: the owner's 2026-09-03 ruling 甲 applied — the factory sees the option and the document's money " +
      "did not move. DECIDED work, not backlog, and it is broken out so it can never be summed into the DIFFER column again.",
  );
  if (unkeyedSofa) {
    plain(
      `   of the ${pop.sofa} sofa lines, ${unkeyedSofa} sit on a document whose ERP lines carry no AutoCount ` +
        "line key, so their COMPARTMENTS are unanswerable rather than agreeing. Their colour, seat size and " +
        "specials are still compared - those are per-line values and do not need the build regrouped.",
    );
  }

  for (const a of AXES) {
    const list = offenders[a.key];
    if (!list.length) continue;
    /* Differences first: both sides state something and they disagree, which is
       the only shape that needs a human to adjudicate rather than a fill. */
    list.sort((x, y) => Number(y.differ) - Number(x.differ));
    /* SPLIT THE DIFFER COUNT BY PROCEEDED, in the ANNOTATION and not only in the
       table above. This headline is the line that gets quoted into briefs and
       status notes, and it was summing the two halves the table had just been at
       pains to separate: sofa compartments read "32 DIFFER" on 2026-09-07 when
       ONE of the 32 sat on a proceeded order and 31 did not. The owner's rule
       「还没proceed还没确认的就可以直接放空的」 has already been broken twice by a
       lumped number, and both times the lump came from a line like this one. */
    const dif = list.filter((x) => x.differ);
    const difYes = dif.filter((x) => x.proceeded).length;
    log(
      `${t} VARIANT ${a.label} — ${difYes} DIFFER on a PROCEEDED order` +
        (dif.length - difYes ? ` (+${dif.length - difYes} on orders not yet proceeded)` : "") +
        `, ${list.filter((x) => !x.differ).length} ERP blank on a proceeded order`,
    );
    for (const row of list.slice(0, SHOW)) plain(`      ${row.line}`);
    if (list.length > SHOW) plain(`      ... ${list.length - SHOW} more`);
    const bb = bookBlanks[a.key];
    if (bb.length) {
      plain(`   ${a.label} — AutoCount blank, ERP carries one: ${bb.length} (first ${Math.min(SHOW_BOOK_BLANK, bb.length)}, NOT work)`);
      for (const row of bb.slice(0, SHOW_BOOK_BLANK)) plain(`      ${row}`);
    }
  }
  return { t, pop, tally, comparable: true };
}

for (const cfg of TYPES) {
  const t = cfg.t;
  /* GR compares at (receipt × purchase order) grain — see the cfg block. Both
     the book side and the population come from GR_PAIR so the two halves of the
     comparison cannot be at different grains. */
  const B = cfg.pairGrain ? GR_PAIR.view : book[t];
  const scope = cfg.pairGrain ? GR_PAIR.scope : SCOPE[t];

  plain("");
  plain(`═══════════ ${t} — ${cfg.label} ═══════════`);
  if (cfg.pairGrain) {
    plain(
      "GRAIN: one \"document\" below is a (AutoCount receipt x purchase order) PAIR, written `GR-nnn|PO-nnn`, " +
        "because an ERP goods receipt belongs to ONE purchase order while an AutoCount receipt can span several. " +
        `The book holds ${book[t].headers.size} ${t} documents in total and ${SCOPE[t].size} in scope; ` +
        `they resolve to ${B.headers.size} pairs.`,
    );
  }
  plain(
    `AutoCount: ${B.headers.size} ${cfg.pairGrain ? "pairs" : "documents"} in the book; ${scope.size} in the expected ERP population` +
      (scope.size === 0 ? " (none expected — the owner declined the historical import)" : ""),
  );

  const erpByAc = new Map();
  const dupes = [];
  let erpBorn = 0;
  for (const d of erp[t].docs) {
    const ac = d.ac_no ? String(d.ac_no).trim() : null;
    if (!ac) {
      erpBorn++;
      continue;
    }
    if (erpByAc.has(ac)) dupes.push(`${ac} -> ${erpByAc.get(ac).erp_no} AND ${d.erp_no}`);
    else erpByAc.set(ac, d);
  }
  const pointerByAc = new Map();
  for (const p of erp[t].pointers) pointerByAc.set(String(p.ac_no).trim(), p);
  const claimed = new Set([...erpByAc.keys(), ...pointerByAc.keys()]);

  plain(
    `ERP: ${erp[t].docs.length} documents (company ${CO}); ${erpByAc.size} mirror an AutoCount document; ` +
      `${pointerByAc.size} more are referenced by a pointer on a purchase order; ` +
      `${erpBorn} are ERP-born and claim no AutoCount number`,
  );

  /* 1. document level, both directions */
  const missingInScope = [];
  const absentOutOfScope = [];
  for (const docNo of B.headers.keys()) {
    if (claimed.has(docNo)) continue;
    (scope.has(docNo) ? missingInScope : absentOutOfScope).push(docNo);
  }
  const phantom = [];
  const outOfScopeMirrored = [];
  for (const ac of claimed) {
    if (!B.headers.has(ac)) phantom.push(`${ac} (ERP ${(erpByAc.get(ac) || pointerByAc.get(ac)).erp_no})`);
    else if (!scope.has(ac)) outOfScopeMirrored.push(ac);
  }

  /* "owner-declined" IS A CLAIM ABOUT AN EMPTY POPULATION, and it may only be
     printed when the population is in fact empty. A DECISION means the owner
     said "do not carry these", which `ac-scope.mjs` expresses by putting none of
     them in scope; if the scope holds documents, then by construction the
     migration WAS defined to carry them and anything absent is a gap. Deriving
     the word from the population instead of trusting the constant is what stops
     the two drifting: on 2026-09-07 the DO/IV/PI constants still said DECISION
     months after ac-scope gave all three a real population, and the reconcile
     printed 2 delivery orders, 7 sales invoices and 21 purchase invoices as
     decisions the owner had made. He had made no such decision about any of
     them. A misfiled gap is worse than an unfixed one — nobody goes looking. */
  const claimsDecision = cfg.absenceIs === "DECISION";
  const decisionHolds = claimsDecision && scope.size === 0;
  if (claimsDecision && !decisionHolds) {
    log(
      `${t} LABEL REFUSED — this type is configured absenceIs=DECISION, but ac-scope.mjs puts ` +
        `${scope.size} ${t} document(s) in the expected population. A decision means an EMPTY population, ` +
        "so the absences below are reported as GAPS. Fix the constant in TYPES to match ac-scope.mjs.",
    );
  }
  const absenceWord = decisionHolds ? "owner-declined" : "GAP";
  const countsAsGap = !decisionHolds;
  log(
    `${t} DOCUMENTS — in-scope AutoCount documents absent from the ERP: ${missingInScope.length} (${absenceWord}); ` +
      `ERP claims a document the book does not have: ${phantom.length}`,
  );
  plain(
    `   out-of-scope and absent (CORRECT by the population rule): ${absentOutOfScope.length}; ` +
      `present though out of scope: ${outOfScopeMirrored.length}; duplicate claims: ${dupes.length}`,
  );
  if (missingInScope.length) plain(`   absent (first ${SHOW}): ${first(missingInScope).join(", ")}`);
  if (phantom.length) plain(`   phantom (first ${SHOW}): ${first(phantom).join(", ")}`);
  if (dupes.length) plain(`   duplicate (first ${SHOW}): ${first(dupes).join(" | ")}`);

  if (cfg.linesNotComparable) {
    log(`${t} DATA — line and money comparison NOT APPLICABLE. ${cfg.linesNotComparable}`);
    summary.push({
      t, acDocs: B.headers.size, scope: scope.size, erpLinked: claimed.size,
      missing: missingInScope.length, absenceIs: decisionHolds ? "DECISION" : "GAP", phantom: phantom.length,
      bothSides: 0, lineCount: "-", item: "-", qty: "-", price: "-", money: "-", gaps: missingInScope.length * (countsAsGap ? 1 : 0) + phantom.length,
    });
    continue;
  }

  /* 2 + 3. line level and money for documents present on both sides */
  const erpLinesByAc = new Map();
  for (const l of erp[t].lines) {
    const ac = String(l.ac_no).trim();
    if (!erpLinesByAc.has(ac)) erpLinesByAc.set(ac, []);
    erpLinesByAc.get(ac).push(l);
  }

  const F = {
    lineCount: [], money: [], item: [], qty: [], price: [],
    keyOrphan: [], unmatchedErp: [], unmatchedAc: [],
  };
  const D = { lineCount: 0, item: 0, price: 0 }; // declared, not gaps
  /* The unit-price differences, split by WHAT KIND they are. See the comment at
     the classification below; only `bothPriced` and `erpDropped` are copy jobs. */
  const P = { bookDropped: [], bookUnpriced: [], erpDropped: [], bothPriced: [] };
  /* One entry per AUTOCOUNT line that became at least one ERP line, carrying
     the ERP lines it became. A sofa line becomes one ERP row per compartment,
     so the compartment axis is only answerable over the whole group. */
  const variantRows = [];
  let descOnly = 0;
  let bothSides = 0;
  let comparedLines = 0;
  let sofaDocs = 0;
  const unpairableDocs = [];
  let zeroMoneyDocs = 0;
  /* Documents whose money is stated in a currency the ERP does not hold, and
     documents this snapshot could not tell us the currency of. Reported in
     their own right, NEVER as a money difference — see the money comparison
     below and docs/bugs/0665-*.md. */
  const foreignDocs = [];
  let currencyBlind = 0;

  for (const [ac, d] of erpByAc) {
    const h = B.headers.get(ac);
    if (!h) continue;
    bothSides++;

    const acLines = (B.lines.get(ac) || [])
      .slice()
      .sort((a, b) => a.seq - b.seq || (a.dtlKey > b.dtlKey ? 1 : -1));
    const erpLines = (erpLinesByAc.get(ac) || [])
      .slice()
      .sort(
        (a, b) =>
          a.line_no - b.line_no ||
          String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
          (a.id > b.id ? 1 : -1),
      );
    /* Trap 3: a sofa line on either side means this document was decomposed,
       so its line count and per-line price are not commensurable.  Detected
       three ways because no single one is reliable across the import rounds:
       AutoCount's own "... SOFA" code, the ERP's compartment suffix, and one
       AutoCount DtlKey claimed by more than one ERP line. */
    const dupKeyed = new Set();
    let splitSeen = false;
    for (const l of erpLines) {
      const k = l.ac_dtlkey == null ? null : String(l.ac_dtlkey).trim();
      if (!k) continue;
      if (dupKeyed.has(k)) splitSeen = true;
      dupKeyed.add(k);
    }
    const sofa =
      splitSeen || erpLines.some((l) => l.line_suffix) || acLines.some((l) => isSofaCode(l.itemKey));
    if (sofa) sofaDocs++;

    if (acLines.length !== erpLines.length) {
      const msg = `${ac}: AutoCount ${acLines.length} vs ERP ${erpLines.length} (ERP ${d.erp_no})`;
      if (sofa) D.lineCount++;
      else F.lineCount.push(msg);
    }
    const erpTotal = d.total_sen == null ? null : Number(d.total_sen);

    /* COMPARE LIKE WITH LIKE, since 2026-09-07. `h.totalSen` is
       `ISNULL(LocalNetTotal, NetTotal)` — the LOCAL (MYR) figure — while the ERP
       stores the DOCUMENT's own amounts (`import-ac-outstanding-po.mjs:401`
       hard-codes 'MYR' into `purchase_orders.currency` whatever the book says).
       On the 9,390 MYR purchase orders those are the same number, which is why
       nobody could see the bug; on `PO-009335`, CNY at 0.619380, the difference
       IS the exchange rate, and the PO line-discount repair read it as a 38.06%
       discount and took RM 13,068.55 off a live document. Ledger 0665.

       So the book side is now the DOCUMENT total, which is what the ERP holds.
       `docTotalSen` is null on a snapshot cut before the exporter carried it, and
       the fallback is the old behaviour — no better, no worse, and announced
       once as `currencyBlind` rather than passed off as a like-for-like read. */
    const cur = currencyVerdict(h);
    const bookTotal = h.docTotalSen ?? h.totalSen;
    if (cur.kind === "unknown") currencyBlind++;
    if (cur.kind === "foreign") {
      /* NOT a money difference. The ERP's `currency` column saying MYR on a
         foreign document is a real defect, but it is a CURRENCY defect, and
         counting it in the money column is what made an exchange rate look like
         a discount in the first place. */
      foreignDocs.push(
        `${ac}: ${cur.why} — document RM ${rm(h.docTotalSen)}, local RM ${rm(h.totalSen)}, ` +
          `ERP RM ${rm(erpTotal)} tagged '${LOCAL_CURRENCY}' (ERP ${d.erp_no})`,
      );
    }
    if (bookTotal !== erpTotal) {
      /* An ERP side that is zero while the book is not is a POPULATION
         property, not per-document drift — the migrated delivery orders carry
         no money at all. Counted apart so 55 documents do not read as 55
         separate defects. */
      if (!erpTotal && bookTotal) zeroMoneyDocs++;
      F.money.push(`${ac}: AutoCount RM ${rm(bookTotal)} vs ERP RM ${rm(erpTotal)} (ERP ${d.erp_no})`);
    }

    /* When NO ERP line on this document carries a DtlKey and the two sides do
       not even agree on how many lines there are, ordinal pairing would invent
       mismatches for every line after the first divergence.  Say so and stop
       for this document — a checker that cannot match must refuse rather than
       report. */
    if (!erpLines.some((l) => l.ac_dtlkey != null) && acLines.length !== erpLines.length) {
      unpairableDocs.push(`${ac}: no line key on either side and the counts differ (ERP ${d.erp_no})`);
      continue;
    }

    /* Pair on DtlKey where the ERP carries one — it is the only key the two
       systems genuinely share — then fall back to document order. */
    const acByKey = new Map(acLines.map((l) => [l.dtlKey, l]));
    const usedAc = new Set();
    const pairs = [];
    const unkeyedErp = [];
    for (const el of erpLines) {
      const k = el.ac_dtlkey == null ? null : String(el.ac_dtlkey).trim();
      if (k) {
        const al = acByKey.get(k);
        if (al && !usedAc.has(k)) {
          usedAc.add(k);
          pairs.push([al, el, false]);
          continue;
        }
        if (!al) {
          F.keyOrphan.push(`${ac}: ERP line ${el.id} claims DtlKey ${k}, not a line of this document`);
          continue;
        }
        /* a second ERP line on the same AutoCount line = the sofa split */
        pairs.push([al, el, true]);
        continue;
      }
      unkeyedErp.push(el);
    }
    /* The keyless fallback pairs on VALUE before position.  grn/do/si/pi items
       carry no line key at all, and their insert order is not AutoCount's Seq —
       PI-007893 measured 2026-09-07 held the same four prices rotated by one
       position, which pure ordinal pairing reported as four price defects and
       zero of them were real.  So: exact (qty, unit price) first, then qty
       alone, then whatever is left in document order.  A genuine difference
       survives all three passes; a reordering does not. */
    let freeAc = acLines.filter((l) => !usedAc.has(l.dtlKey));
    let freeErp = unkeyedErp;
    for (const keyOf of [
      (q, p) => `${q}|${p}`,
      (q) => `${q}`,
    ]) {
      const bucket = new Map();
      for (const al of freeAc) {
        const k = keyOf(al.qty ?? 0, al.unitPriceSen ?? 0);
        if (!bucket.has(k)) bucket.set(k, []);
        bucket.get(k).push(al);
      }
      const stillFreeErp = [];
      const taken = new Set();
      for (const el of freeErp) {
        const k = keyOf(el.qty == null ? 0 : Number(el.qty), el.unit_price_sen == null ? 0 : Number(el.unit_price_sen));
        const cand = bucket.get(k);
        const al = cand && cand.shift();
        if (al) {
          taken.add(al.dtlKey);
          pairs.push([al, el, false]);
        } else stillFreeErp.push(el);
      }
      freeAc = freeAc.filter((l) => !taken.has(l.dtlKey));
      freeErp = stillFreeErp;
    }
    for (let i = 0; i < Math.max(freeAc.length, freeErp.length); i++) {
      if (i < freeAc.length && i < freeErp.length) pairs.push([freeAc[i], freeErp[i], false]);
      else if (i < freeAc.length) F.unmatchedAc.push(`${ac}: AutoCount DtlKey ${freeAc[i].dtlKey} has no ERP line`);
      else F.unmatchedErp.push(`${ac}: ERP line ${freeErp[i].id} has no AutoCount line`);
    }

    /* The VARIANT side rides the pairing the document reconcile already did —
       DtlKey where the ERP carries one, then value, then document order. A
       second, private matcher here would disagree with the one whose verdict is
       printed above it. */
    {
      const byAc = new Map();
      for (const [al, el] of pairs) {
        if (!byAc.has(al.dtlKey)) byAc.set(al.dtlKey, { acLine: al, erpLines: [] });
        byAc.get(al.dtlKey).erpLines.push(el);
      }
      for (const [, g] of byAc) variantRows.push({ ac, erpNo: d.erp_no, ...g });
    }

    for (const [al, el, split] of pairs) {
      comparedLines++;
      if (!al.hasCode) descOnly++;
      else if (isSofaCode(al.itemKey)) {
        /* compartment codes: only the model is comparable */
        const am = modelOf(al.itemKey);
        const em = modelOf(el.item_code);
        /* neither side carries a model: not a decomposed sofa at all, but an
           accessory whose NAME contains "SOFA".  Compare the codes. */
        const agrees = am && em ? am === em : !am && !em && mapped(al.itemKey) === norm(el.item_code);
        if (agrees) D.item++;
        else if (cfg.itemCodeDeclared) D.item++;
        else {
          F.item.push(
            `${ac} DtlKey ${al.dtlKey}: AutoCount model ${am ?? "?"} ("${al.itemKey}") vs ERP model ` +
              `${em ?? "?"} ("${el.item_code ?? ""}")`,
          );
        }
      } else if (mapped(al.itemKey) !== norm(el.item_code)) {
        const msg = `${ac} DtlKey ${al.dtlKey}: AutoCount "${al.itemKey}" vs ERP "${el.item_code ?? ""}"`;
        if (cfg.itemCodeDeclared || split) D.item++;
        else F.item.push(msg);
      }
      const aq = al.qty ?? 0;
      const eq = el.qty == null ? 0 : Number(el.qty);
      if (Math.abs(aq - eq) > 1e-4) F.qty.push(`${ac} DtlKey ${al.dtlKey}: AutoCount qty ${aq} vs ERP qty ${eq}`);
      const ap = al.unitPriceSen ?? 0;
      const ep = el.unit_price_sen == null ? 0 : Number(el.unit_price_sen);
      if (ap !== ep) {
        const msg = `${ac} DtlKey ${al.dtlKey}: AutoCount unit price RM ${rm(ap)} vs ERP RM ${rm(ep)}`;
        if (split || sofa || cfg.priceDeclared) D.price++;
        else {
          F.price.push(msg);
          /* WHICH KIND of price difference this is, because "241 lines differ"
             hides three unrelated facts and the owner's 空白不覆盖 rule applies
             to only one of them.

             `bookDropped` is the EXPORT-FAILURE test and it is self-checking:
             the book states a SubTotal for the line while its UnitPrice is
             zero. A transport that lost the price would leave the subtotal
             behind, so a non-zero count here means the export is lying and the
             other buckets cannot be trusted. Measured over the whole book on
             2026-09-07 (18,890 PODTL rows read directly over sqlcmd): 10,810
             rows have UnitPrice 0 and the SAME 10,810 have SubTotal 0, so this
             count is expected to stay at zero. */
          const aSub = al.subTotalSen ?? 0;
          if (ap === 0 && aSub !== 0) P.bookDropped.push(msg);
          else if (ap === 0 && ep > 0) P.bookUnpriced.push(msg);
          else if (ap > 0 && ep === 0) P.erpDropped.push(msg);
          else P.bothPriced.push(msg);
        }
      }
    }
  }

  log(
    `${t} DATA (${bothSides} documents on both sides, ${comparedLines} lines paired) — ` +
      `line-count differs: ${F.lineCount.length}; item code: ${F.item.length}; quantity: ${F.qty.length}; ` +
      `unit price: ${F.price.length}; document total: ${F.money.length}`,
  );
  plain(
    `   unpaired: ${F.unmatchedAc.length} AutoCount lines, ${F.unmatchedErp.length} ERP lines; ` +
      `DtlKey on the wrong document: ${F.keyOrphan.length}; ` +
      `AutoCount lines with no ItemCode (description-only, not comparable): ${descOnly}`,
  );
  if (zeroMoneyDocs) {
    log(
      `${t} — ${zeroMoneyDocs} of the ${bothSides} documents on both sides carry ZERO money in the ERP ` +
        "while the book carries a value. That is one systematic cause, not that many separate defects.",
    );
  }
  if (foreignDocs.length) {
    log(
      `${t} — ${foreignDocs.length} document(s) are NOT in ${LOCAL_CURRENCY}. Their totals are compared in the ` +
        "DOCUMENT's own currency, which is what the ERP stores, so they are not money differences. What IS " +
        `wrong on them is the ERP's own currency column, which reads '${LOCAL_CURRENCY}' regardless ` +
        "(import-ac-outstanding-po.mjs:401). Listed, never repaired by script — a discount and an exchange rate " +
        "are not distinguishable from a total alone.",
    );
    for (const row of first(foreignDocs)) plain(`      ${row}`);
  }
  if (currencyBlind) {
    log(
      `${t} — this snapshot carries NO currency for ${currencyBlind} of the ${bothSides} documents on both sides, ` +
        "so the money comparison above is CURRENCY-BLIND: it cannot tell an exchange rate from a difference. " +
        "Re-cut it with AC_CRED_FILE=<path> node backend/scripts/export-ac-reconcile-truth.mjs.",
    );
  }
  if (unpairableDocs.length) {
    log(
      `${t} — ${unpairableDocs.length} documents could NOT be line-matched (no line key on either side and ` +
        "the line counts differ). Their line data is UNVERIFIED, not verified-clean.",
    );
    for (const row of first(unpairableDocs)) plain(`      ${row}`);
  }
  plain(
    `   DECLARED, not counted as gaps: sofa-decomposed documents ${sofaDocs} ` +
      `(line count ${D.lineCount}, unit price ${D.price}); item code by design ${D.item}` +
      (cfg.itemCodeDeclared ? ` — ${cfg.itemCodeDeclared}` : ""),
  );
  if (cfg.priceDeclared) {
    plain(`   unit price is DECLARED for this type — ${cfg.priceDeclared}. The QUANTITY is not: it is copied from the book and is compared above.`);
  }
  if (F.price.length) {
    log(
      `${t} UNIT PRICE — the ${F.price.length} difference(s), split by what each one IS:` +
        `  book holds NO price, ERP does: ${P.bookUnpriced.length}` +
        `; both sides priced and they differ: ${P.bothPriced.length}` +
        `; ERP dropped a price the book states: ${P.erpDropped.length}` +
        `; export lost a price the book has: ${P.bookDropped.length}`,
    );
    plain(
      "      Only the last three are copy jobs. `book holds NO price` is the owner's 空白不覆盖 case — the book " +
        "states 0.00 AND a 0.00 line subtotal, so it holds no price to copy and the ERP's value must stand.",
    );
    plain(
      "      `export lost a price` is the SELF-CHECK: the book states a line SubTotal while its UnitPrice is zero, " +
        "which is what a lost price looks like. A non-zero count there means this whole split is untrustworthy.",
    );
    for (const [pname, parr] of [
      ["book holds NO price, ERP does", P.bookUnpriced],
      ["both sides priced and they DIFFER", P.bothPriced],
      ["ERP dropped a price the book states", P.erpDropped],
      ["EXPORT LOST a price the book has", P.bookDropped],
    ]) {
      if (!parr.length) continue;
      plain(`   ${pname} (first ${Math.min(SHOW, parr.length)} of ${parr.length}):`);
      for (const row of first(parr)) plain(`      ${row}`);
    }
  }
  for (const [name, arr] of [
    ["line count", F.lineCount],
    ["item code", F.item],
    ["quantity", F.qty],
    ["unit price", F.price],
    ["document total", F.money],
    ["orphan DtlKey", F.keyOrphan],
    ["AutoCount line with no ERP line", F.unmatchedAc],
    ["ERP line with no AutoCount line", F.unmatchedErp],
  ]) {
    if (!arr.length) continue;
    plain(`   ${name} (first ${Math.min(SHOW, arr.length)} of ${arr.length}):`);
    for (const row of first(arr)) plain(`      ${row}`);
  }

  /* ── 4. THE VARIANTS INSIDE THE LINE ──────────────────────────────────── */
  const vt = reportVariants(t, cfg.label, variantRows, B.desc2);
  variantTotals.push(vt);

  summary.push({
    t,
    acDocs: B.headers.size,
    scope: scope.size,
    erpLinked: claimed.size,
    missing: missingInScope.length,
    absenceIs: decisionHolds ? "DECISION" : "GAP",
    phantom: phantom.length,
    bothSides,
    unpairable: unpairableDocs.length,
    lineCount: F.lineCount.length,
    item: F.item.length,
    qty: F.qty.length,
    price: F.price.length,
    money: F.money.length,
    foreign: foreignDocs.length,
    gaps:
      (countsAsGap ? missingInScope.length : 0) +
      phantom.length + F.lineCount.length + F.item.length + F.qty.length + F.price.length + F.money.length,
  });
}

/* ── the DO rule, stated so nobody "fixes" it ────────────────────────────── */
plain("");
plain("═══════════ THE DO RULE (owner's; not a defect) ═══════════");
log(
  `${soFullyDelivered.size} un-cancelled AutoCount sales orders have EVERY line already transferred to a ` +
    "delivery order. Their absence from the ERP is CORRECT — outstanding means not yet transferred to a DO.",
);
plain(
  `   sales orders in the book: ${book.SO.headers.size}; outstanding (expected in the ERP): ${soScope.size}; ` +
    `fully delivered: ${soFullyDelivered.size}; invoiced direct with no DO (owner-excluded 2026-08-10): ` +
    `${[...soInvoicedDirect].filter((d) => book.SO.headers.has(d)).length}`,
);

/* ── the variant verdict, one line per axis, every type added together ───── */
plain("");
plain("═══════════ VARIANTS INSIDE THE LINE — ALL TYPES ═══════════");
{
  const comparable = variantTotals.filter((v) => v.comparable);
  if (!comparable.length) {
    log(
      "VARIANTS — not one document type produced a comparable bedframe or sofa line. The variant reconcile " +
        "answered NOTHING; do not read the absence of findings as agreement.",
    );
  } else {
    /* The owner asked about the ORDERS - "拿目前的orders 去对比autocount的数据".
       A sales order and the purchase order raised from it are what the factory
       builds from, so they are where a blank axis is work. A delivery order, a
       sales invoice and a purchase invoice are downstream MIRRORS of a build
       that was already decided; their `variants` are not what anyone reads to
       make the furniture, and on this book most of them carry none at all.
       Both totals are printed, because folding the mirrors into the headline
       would inflate the backlog with rows nobody is meant to fill. */
    const BUILD_TYPES = new Set(["SO", "PO"]);
    const blank = () => {
      const o = {};
      for (const a of AXES) o[a.key] = { yes: {}, no: {} };
      for (const a of AXES) for (const half of ["yes", "no"]) for (const v of VERDICTS) o[a.key][half][v] = 0;
      return o;
    };
    const add = blank();
    const build = blank();
    for (const vt of comparable) {
      for (const a of AXES) for (const half of ["yes", "no"]) for (const v of VERDICTS) {
        add[a.key][half][v] += vt.tally[a.key][half][v];
        if (BUILD_TYPES.has(vt.t)) build[a.key][half][v] += vt.tally[a.key][half][v];
      }
    }
    plain(`types compared: ${comparable.map((v) => v.t).join(", ")} (GR carries no comparable ERP line — see the GR section)`);
    plain("axis                 |  ORDERS (SO+PO), PROCEEDED  |  every type, PROCEEDED  |  not proceeded");
    plain("                     |   ERPblank        differ    |  ERPblank      differ   |  ERPblank   differ");
    let work = 0;
    let differ = 0;
    let orderWork = 0;
    let orderDiffer = 0;
    for (const a of AXES) {
      const y = add[a.key];
      const b = build[a.key];
      const seen = VERDICTS.reduce((s2, v) => s2 + y.yes[v] + y.no[v], 0);
      if (!seen) continue;
      work += y.yes[ERP_BLANK];
      differ += y.yes[DIFFER] + y.no[DIFFER];
      orderWork += b.yes[ERP_BLANK];
      orderDiffer += b.yes[DIFFER] + b.no[DIFFER];
      plain(
        `${a.label.padEnd(20)} | ${String(b.yes[ERP_BLANK]).padStart(10)} ${String(b.yes[DIFFER]).padStart(13)}` +
          `    | ${String(y.yes[ERP_BLANK]).padStart(9)} ${String(y.yes[DIFFER]).padStart(11)}   ` +
          `| ${String(y.no[ERP_BLANK]).padStart(9)} ${String(y.no[DIFFER]).padStart(8)}`,
      );
    }
    log(
      `VARIANTS — on the ORDERS the factory builds from (SO + PO): ${orderWork} axis values the book states and ` +
        `a PROCEEDED order does not carry, and ${orderDiffer} where both sides state something DIFFERENT. ` +
        `Across all five types the same figures are ${work} and ${differ}; the difference is delivery orders and ` +
        "invoices, which mirror a build rather than decide one and mostly carry no variants at all — filling those " +
        "is not work anyone asked for. An unconfirmed order's blank is not counted either: " +
        "还没proceed还没确认的就可以直接放空的.",
    );
  }
}

/* ── 5. FIELD IDENTITY — "一模一样" read field by field ───────────────────── */
/* The owner's bar on go-live day is not that the totals agree:
     「不管是 sales agent 还是里面的数据 我们全部都要,而且要跟 autocount 一模一样」
   Sections 1-4 compare presence, line count, item code, quantity, unit price,
   document total and the variants inside a line. This one compares every OTHER
   field the migration is supposed to carry — the address, the agent, the
   remarks, the dates, the UDFs — against the ERP column the importer names for
   it. The field list is taken from the four importers, not typed here; see
   lib/ac-field-identity.mjs. */
plain("");
plain("═══════════ 5. FIELD IDENTITY — EVERY FIELD THE MIGRATION CARRIES ═══════════");
{
  const acSide = loadAcFieldSide(DATA, book);
  if (acSide.missing.length) {
    await refuse(
      `the migration exports the field comparison reads are missing: ${acSide.missing.join(", ")}. ` +
        "Re-run export-ac-reimport.py against the book. Reporting a clean field run against exports that " +
        "are not there would be a verdict computed over nothing.",
    );
  }
  let erpSide;
  try {
    erpSide = await loadErpFieldSide(sql, CO);
  } catch (e) {
    await refuse(`the ERP field columns could not be read: ${e.message}`);
  }

  plain(
    `AutoCount side: the migration exports themselves (data/ac-outstanding-*.json.gz), which are what the ` +
      `importers read. Scope and the book's own money come from ac-reconcile-truth.json.gz, exported ` +
      `${snap.exported_at}. THESE ARE TWO CUTS — a document in scope on one and absent from the other is ` +
      "reported as WINDOW, never as a gap.",
  );

  const fieldTotals = [];
  for (const t of ["SO", "PO", "DO"]) {
    if (!FIELD_MAP[t].header.length && !FIELD_MAP[t].line.length) continue;
    const r = compareType({
      t,
      ac: acSide[t],
      erp: erpSide[t],
      scope: SCOPE[t],
      mapped,
      modelOf,
      isSofaCode,
      docProceeded: acSide.docProceeded[t],
      lineProceeded: acSide.lineProceeded[t],
      SHOW,
    });
    /* The no-LIMIT assertion: every ERP line the query returned is every ERP
       line there is. A sibling check reported a drift of 842 as 500 earlier
       today because it capped its own answer. */
    if (erpSide[t].lines.length !== erpSide.lineCounts[t]) {
      await refuse(
        `${t}: the field query returned ${erpSide[t].lines.length} ERP lines but COUNT(*) says ` +
          `${erpSide.lineCounts[t]}. The answer is being truncated; a count taken from a truncated read is a lie.`,
      );
    }
    fieldTotals.push({ t, ...printFieldTable({ result: r, plain, log, SHOW }) });
  }

  for (const t of ["GR", "IV", "PI"]) {
    plain("");
    plain(`─── ${t} — FIELD BY FIELD ───`);
    plain(
      t === "GR"
        ? "   no ERP goods-received DOCUMENT exists to compare fields against: the ERP carries a POINTER on the " +
          "purchase order (purchase_orders.linked_ac_grn_docnos) and the units are already in from the balance " +
          "snapshot. Presence is section 1; there is nothing here to measure."
        : "   no population by the owner's decision (「这个不要」, the historical invoice import). An absent " +
          "historical invoice is a DECISION, not a gap, so there is no field to compare.",
    );
  }

  const disc = measurePoDiscount(book, SCOPE.PO);
  printPoDiscount({ disc, plain, log });

  plain("");
  const fDiffer = fieldTotals.reduce((a, x) => a + x.differ, 0);
  const fBlank = fieldTotals.reduce((a, x) => a + x.erpBlank, 0);
  const fNoise = fieldTotals.reduce((a, x) => a + x.noise, 0);
  const fNotCarried = fieldTotals.reduce((a, x) => a + (x.notCarried || 0), 0);
  log(
    `FIELD IDENTITY — across SO, PO and DO, on the fields an importer COPIES and on documents that have been ` +
      `PROCEEDED: ${fDiffer} values differ and ${fBlank} are blank in the ERP where the book states one. ` +
      `${fNoise} more differed only as transport artefacts and are not spec changes. ` +
      `${fNotCarried} book values sit in fields no importer carries at all. ` +
      "An unconfirmed order's blank is counted separately and is not work: 还没proceed还没确认的就可以直接放空的.",
  );
}

/* ── one-screen verdict ──────────────────────────────────────────────────── */
plain("");
plain("═══════════ SUMMARY ═══════════");
plain("type  book  scope    erp  absent  phantom   both  lineCnt   item    qty  price  money  non-MYR");
for (const s of summary) {
  plain(
    [
      s.t.padEnd(4),
      String(s.acDocs).padStart(5),
      String(s.scope).padStart(6),
      String(s.erpLinked).padStart(6),
      String(s.missing).padStart(7),
      String(s.phantom).padStart(8),
      String(s.bothSides).padStart(6),
      String(s.lineCount).padStart(8),
      String(s.item).padStart(6),
      String(s.qty).padStart(6),
      String(s.price).padStart(6),
      String(s.money).padStart(6),
      /* Its own column, deliberately not folded into `money` and deliberately
         not counted in `gaps`: a foreign-currency document is compared in its
         own currency and may be perfectly correct. What it flags is that the
         ERP tags it MYR. Ledger 0665. */
      String(s.foreign ?? 0).padStart(7),
    ].join(" "),
  );
}
plain("absent = in the expected population but not in the ERP; for DO/IV/PI the population is empty by owner decision.");
plain("non-MYR = documents compared in their OWN currency. Not a money difference, and never repaired by script.");
const totalGaps = summary.reduce((a, s) => a + s.gaps, 0);
log(
  totalGaps === 0
    ? "CLEAN — every in-scope AutoCount document is in the ERP and every comparable field agrees."
    : `${totalGaps} disagreements that are NOT covered by a declared design difference. Detail above.`,
);

await sql.end({ timeout: 5 });
