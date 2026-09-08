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
 * ── THE COLUMNS THAT ARE NOT DIFFERENCES ────────────────────────────────────
 * Three of the summary's counts were never disagreements, and printing them
 * under a heading that says "difference" made the owner re-ask about the same
 * three cells every single run. They now have columns of their OWN — visible,
 * counted, named — and they are excluded from the gap total:
 *
 *   `no-price`  the BOOK states no unit price. Houzs prices a purchase when the
 *               goods arrive, so most purchase-order lines carry UnitPrice 0.00
 *               and a 0.00 line subtotal. Copying the book would ERASE a real
 *               ERP price. This is the owner's 空白不覆盖 rule, and the split
 *               that computes it was already here — it just did not reach the
 *               summary.
 *   `ERP-RM0`   our document carries RM 0.00 where the book states a value, on
 *               MIGRATED PAPERWORK. Owner, 2026-09-08: 「GR 0 没关系」. Named
 *               consequence: a purchase invoice cannot be raised off it.
 *   `decided`   an in-scope document the ERP does not have, about which the
 *               owner has already ruled. It stays on screen, by name, with the
 *               action still owed, until it is done.
 *
 * NONE of these is a constant that is believed. Each one is DERIVED from a
 * measurement made in the same run — see lib/ac-not-a-difference.mjs, whose
 * header is the specification, and backend/tests/acNotADifference.test.ts,
 * which pins the property that a partial cover still reports DIFFER. That is
 * the 0668 lesson applied in the other direction: 0668 was a hand-typed label
 * printing 30 real gaps as decisions, and a benign column is the same hazard
 * with the sign flipped.
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
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { classifyItemCode, modelOf } from "./lib/item-code-class.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { mapSpecial as mapBedframeSpecial } from "./lib/bedframe-special-map.mjs";
import { K as SK, mapPhrase as mapSofaPhrase, skey } from "./lib/sofa-special-map.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
import {
  AGREE, AXES, BOOK_BLANK, DIFFER, ERP_BLANK, PENDING, RECORDED, UNREADABLE, VARIANT_GROUPS, VERDICTS,
  compareLine, decodeBook, runSelfTest,
} from "./lib/variant-reconcile.mjs";

import { buildScope, currencyVerdict, decodeSnapshot, isTestDoc, LOCAL_CURRENCY } from "./lib/ac-scope.mjs";
import {
  splitBookUnpriced, splitDecidedAbsences, splitErpZeroMoney,
  splitGuessedItemCodePairing, splitMigratedChainLineShape,
} from "./lib/ac-not-a-difference.mjs";
import { isBlankBookRow, splitBlankBookRows } from "./lib/ac-blank-book-row.mjs";
import { grPairGrain } from "./lib/ac-gr-pair-grain.mjs";
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
/* READ BY lib/ac-mapping-csv.mjs, NOT by split(","), since 2026-09-08.  The
   sheet is RFC4180 and three of its rows quote the ERP code because a mattress
   name carries the inch mark:

     DL-GENERASI (S),"DUNLOPILLO GENERASI 5"" MATT (S)",NEW,MATTRESS,400-D001

   The naive split that used to be here cut that into `"DUNLOPILLO GENERASI 5""`,
   a fragment no ERP row can ever equal, so every sales-order line carrying one
   of those three codes was reported as an item-code DEFECT - 40 of the 101 in
   front of the owner on go-live morning (docs/bugs/0689).  The correction
   runner correct-so-item-code-from-autocount.mjs had always parsed it properly;
   TWO parsers for one file is how the two disagreed, so there is now one. */
const mappingRows = readMappingCsv(fs.readFileSync(MAP_CSV, "utf8"));
const codeMap = new Map([...mappingRows].map(([ac, m]) => [ac, normCode(m.erp)]));

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
/* `modelOf` now lives in lib/item-code-class.mjs, with the alias fold and the
   "5535 is its own model" rule pinned by tests/itemCodeClass.test.mjs. */

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

   The rule itself is `lib/ac-gr-pair-grain.mjs`; READ ITS HEADER before
   changing what the book side means. It returns the two halves SEPARATELY and
   they must stay that way: `view` is the whole book at pair grain (11,623
   pairs), `scope` is the expected population (400), derived from `SCOPE.GR` and
   `SCOPE.PO` so it cannot drift from the document scope the rest of this file
   uses. Building both from ONE filtered loop — which is what this file used to
   do inline — made the book side and the population the same set, so every
   legitimate out-of-scope pair the ERP holds fell through to `phantom` and was
   printed as a document the book does not have. There were 97, and the book
   states every one of them. */
const GR_PAIR = grPairGrain(book, SCOPE);
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
    /* THE OWNER'S STANDING DECISION about a migrated receipt that carries no
       money, 2026-09-08: 「GR 0 没关系」. Declared HERE, per type, so it can
       never leak to a document type he never ruled on — and honoured only where
       the run can PROVE the receipt is migrated paperwork. `zeroMoneyProof`
       below is that proof; without it nothing is reclassified. */
    zeroMoneyDecision: {
      label: "GR 0 没关系",
      ruling:
        "the owner ruled 2026-09-08 that a MIGRATED goods receipt may carry RM 0.00. It moves no stock, no " +
        "cost and no MRP — the units were already brought in by the balance snapshot, and the receipt is " +
        "paperwork recording that the book has one",
      consequence:
        "a PURCHASE INVOICE cannot be raised off a RM 0.00 receipt. That is the whole cost of this decision " +
        "and it is named here so nobody rediscovers it as a surprise",
    },
    /* One row per migrated receipt, carrying the two facts the decision rests
       on. Read-only. `source_doc_no` is how every other script in this repo
       asks "did this document move stock" (apply-sofa-compartment-corrections
       .mjs:90), so the question is asked the same way here. */
    zeroMoneyProof: () => sql`SELECT g.grn_number AS erp_no,
        COALESCE(g.migrated_no_stock, false) AS migrated_no_stock,
        (SELECT count(*)::int FROM scm.inventory_movements m
          WHERE m.company_id = g.company_id AND m.source_doc_no = g.grn_number) AS movements
      FROM scm.grns g
      WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED' AND g.linked_ac_gr_docno IS NOT NULL`,
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
    /* Its lines come from OUR delivery order, not from AutoCount IVDTL. */
    migratedChainLineShape: true,
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
    /* Its lines come from OUR goods receipt, not from AutoCount PIDTL. */
    migratedChainLineShape: true,
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

/* The proof behind the owner's zero-money decision, loaded SEPARATELY and
   FAILING SOFT on purpose. If those columns cannot be read — renamed, dropped,
   a permission — the honest outcome is that nothing is reclassified and the run
   says why, NOT that the whole reconcile refuses to answer the other twelve
   questions it can still answer. A null proof is what `splitErpZeroMoney`
   treats as "unproven", which keeps every count in the money column. */
const zeroMoneyProof = {};
for (const cfg of TYPES) {
  if (!cfg.zeroMoneyProof) continue;
  try {
    const rows = await cfg.zeroMoneyProof();
    zeroMoneyProof[cfg.t] = new Map(
      rows.map((r) => [r.erp_no, { migratedNoStock: r.migrated_no_stock === true, movements: Number(r.movements) }]),
    );
  } catch (e) {
    zeroMoneyProof[cfg.t] = null;
    log(
      `${cfg.t} — the migrated-paperwork proof could not be read (${e.message}). The owner's ` +
        `「${cfg.zeroMoneyDecision?.label ?? "zero money"}」 decision is therefore NOT applied and every ` +
        "document-total difference below is counted as a difference.",
    );
  }
}

/* ── self-test: prove the matchers hit before trusting any verdict ───────── */
{
  const problems = [];
  if (codeMap.size < 100) {
    problems.push(`the item-code map loaded only ${codeMap.size} rows from ${MAP_CSV}`);
  }
  /* PROVE THE PARSER, not just the row count. A naive split(",") loads all 1,577
     rows and gets three of them WRONG, and the row count cannot see that: it was
     the count that made the reader look healthy while it invented 40 findings
     (docs/bugs/0689). The quoted rows are the ones that can break, so they are
     the ones asserted. */
  for (const [ac, want] of [
    ["DL-GENERASI (S)", 'DUNLOPILLO GENERASI 5" MATT (S)'],
    ["DL-GENERASI (SS)", 'DUNLOPILLO GENERASI 5" MATT (SS)'],
    ["DL-GENERASI (K)", 'DUNLOPILLO GENERASI 5" MATT (K)'],
  ]) {
    const got = codeMap.get(normCode(ac));
    if (got !== normCode(want)) {
      problems.push(
        `the mapping sheet's QUOTED rows are not being read: "${ac}" resolved to "${got ?? "(nothing)"}", ` +
          `wanted "${want}". Every line carrying one would be reported as an item-code defect.`,
      );
    }
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
  /* The BLANK-ROW declaration is proved against the book itself, in BOTH
     directions, because a declaration that swallows too much reads as a clean
     run. `SO-001473`'s key 98858 is empty in every column and must be declared;
     `SO-011384`'s key 783795 has NO item code and QUANTITY 4 and must NOT be.
     Both are real rows on the 2026-09-08 cut; if the exporter ever stops
     carrying one, that is a snapshot problem and this says so rather than
     reporting a clean run over a rule it could not exercise. */
  for (const [dn, key, want] of [["SO-001473", "98858", true], ["SO-011384", "783795", false]]) {
    const l = (book.SO.lines.get(dn) ?? []).find((x) => String(x.dtlKey) === key);
    if (!l) {
      problems.push(`the blank-row rule cannot be self-tested: ${dn} DtlKey ${key} is not in this snapshot`);
    } else if (isBlankBookRow(l) !== want) {
      problems.push(
        `the blank-row rule answered ${!want} for ${dn} DtlKey ${key} and must answer ${want} — ` +
          (want
            ? "an empty AutoCount row would be counted as a missing line again"
            : "a row the book orders 4 of would be declared away"),
      );
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
    `self-test: item-code map ${codeMap.size} rows and its three RFC4180-quoted rows resolve to what ` +
      "production stores; doc-number and DtlKey matchers resolve for every type that claims one. Proceeding.",
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
        `The book holds ${book[t].headers.size} ${t} documents in total, which resolve to ${B.headers.size} ` +
        `pairs; ${SCOPE[t].size} receipts are in scope and they resolve to the ${scope.size} pairs the ERP ` +
        "is expected to hold. A pair the book states but the population excludes is reported as PRESENT " +
        "THOUGH OUT OF SCOPE, never as a phantom.",
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
  /* An absence the owner has ALREADY RULED ON is not an unexplained gap, and
     printing it as one is how a decided item gets re-asked about every run. It
     is not hidden either: every entry is named below with the ruling and the
     action still owed, and it keeps its own `decided` column in the summary
     until somebody executes it. The register is lib/ac-not-a-difference.mjs;
     an entry is honoured only while its stated REASON still measures true
     against the book, which is the 0668 lesson at document grain. */
  const AB = splitDecidedAbsences({ t, missing: missingInScope, linesOf: (d) => B.lines.get(d) || [] });
  log(
    `${t} DOCUMENTS — in-scope AutoCount documents absent from the ERP: ${AB.absent} (${absenceWord})` +
      (AB.decided ? `, plus ${AB.decided} the owner has already ruled on (listed below)` : "") +
      `; ERP claims a document the book does not have: ${phantom.length}`,
  );
  plain(
    `   out-of-scope and absent (CORRECT by the population rule): ${absentOutOfScope.length}; ` +
      `present though out of scope: ${outOfScopeMirrored.length}; duplicate claims: ${dupes.length}`,
  );
  if (AB.decided) {
    log(`${t} — ${AB.decided} of those ${missingInScope.length} absentee(s) are a DECISION the owner has already made, not an open gap:`);
    for (const e of AB.decidedRows) {
      plain(`      ${e.docNo} — ruling (${e.decidedOn}, ${e.source}): ${e.ruling}`);
      plain(`         still owed: ${e.pending}`);
      plain(`         still true in the book: ${e.proof}`);
    }
  }
  for (const e of AB.refused) {
    log(
      `${t} DECISION REFUSED — the register claims ${e.docNo} is settled ("${e.ruling}") but ${e.why}. ` +
        "It is counted as a GAP. Fix the register or the document.",
    );
  }
  for (const e of AB.stale) {
    log(
      `${t} DECISION REGISTER STALE — ${e.docNo} is no longer an in-scope absence, so the entry recording ` +
        `"${e.ruling}" describes nothing. Delete it from DECIDED_ABSENCES in lib/ac-not-a-difference.mjs.`,
    );
  }
  if (AB.absent) plain(`   absent (first ${SHOW}): ${first(AB.absentDocs).join(", ")}`);
  if (phantom.length) plain(`   phantom (first ${SHOW}): ${first(phantom).join(", ")}`);
  if (dupes.length) plain(`   duplicate (first ${SHOW}): ${first(dupes).join(" | ")}`);

  if (cfg.linesNotComparable) {
    log(`${t} DATA — line and money comparison NOT APPLICABLE. ${cfg.linesNotComparable}`);
    summary.push({
      t, acDocs: B.headers.size, scope: scope.size, erpLinked: claimed.size,
      missing: AB.absent, decided: AB.decided, absenceIs: decisionHolds ? "DECISION" : "GAP", phantom: phantom.length,
      bothSides: 0, lineCount: "-", item: "-", qty: "-", price: "-", noPrice: "-", money: "-", erpZeroMoney: "-",
      gaps: AB.absent * (countsAsGap ? 1 : 0) + phantom.length,
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
  const D = { lineCount: 0, item: 0, price: 0, blankRows: 0, blankRowDocs: new Set() }; // declared, not gaps
  /* The item-code and line-count findings in a machine-readable shape, for the
     same reason `moneyRows` exists below: a classifier must decide a column
     from a MEASUREMENT, never by pattern-matching the printed string. */
  const itemRows = [];
  const lineCountRows = [];
  /* Per document, the evidence those two classifiers need — built here, in the
     loop that already holds both sides, so neither can be computed from a
     narrower read later. See lib/ac-not-a-difference.mjs sections 4 and 5.
       bags       each side's item-code MULTISET, plus whether ANY ERP line of
                  the document carried a line key. A document with no key was
                  PAIRED BY GUESSWORK, and the multiset is the verdict that
                  survives that; a document with a key was paired for real.
       shapeFacts whether the document totals are identical to the sen, and any
                  item code on which the two sides disagree about quantity or
                  money. Empty means every code reconciles. */
  const bags = new Map();
  const shapeFacts = new Map();
  /* Every blank book row, named. A declared class the reader cannot enumerate
     is a suppression, not a declaration. */
  const blankRowRows = [];
  /* The two HARMLESS halves of the raw item-code difference, counted apart so
     the headline number is the DEFECT count and neither half can hide inside
     it. See lib/item-code-class.mjs. */
  const C = { itemTranslation: 0, itemDecomposition: 0 };
  /* The unit-price differences, split by WHAT KIND they are. See the comment at
     the classification below; only `bothPriced` and `erpDropped` are copy jobs. */
  const P = { bookDropped: [], bookUnpriced: [], erpDropped: [], bothPriced: [] };
  /* The document-total differences in a machine-readable shape, so the owner's
     zero-money decision can be applied per document with a proof behind it
     rather than by pattern-matching a printed string. */
  const moneyRows = [];
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

    /* AutoCount's own EMPTY ROWS are declared, not compared — a row with no
       ItemCode, no quantity and no money is not a line the ERP can hold, and
       counting it made eleven blank rows on six sales orders read as MISSING
       LINES on go-live morning. The rule and every clause of it is in
       lib/ac-blank-book-row.mjs; the rows are counted and listed below, never
       dropped silently. */
    const { lines: acLines, blank: acBlank } = splitBlankBookRows(
      (B.lines.get(ac) || [])
        .slice()
        .sort((a, b) => a.seq - b.seq || (a.dtlKey > b.dtlKey ? 1 : -1)),
    );
    if (acBlank.length) {
      D.blankRows += acBlank.length;
      D.blankRowDocs.add(ac);
      for (const l of acBlank) {
        blankRowRows.push(
          `${ac}: DtlKey ${l.dtlKey} — AutoCount states no item code, no quantity and no money (ERP ${d.erp_no})`,
        );
      }
    }
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
    /* How many ERP rows carry each AutoCount line key on THIS document. A sofa
       is one book line and one ERP row per compartment, so >1 is the
       decomposition the item-code classifier must be told about. */
    const erpPerKey = new Map();
    let splitSeen = false;
    for (const l of erpLines) {
      const k = l.ac_dtlkey == null ? null : String(l.ac_dtlkey).trim();
      if (!k) continue;
      erpPerKey.set(k, (erpPerKey.get(k) ?? 0) + 1);
      if (dupKeyed.has(k)) splitSeen = true;
      dupKeyed.add(k);
    }
    const sofa =
      splitSeen || erpLines.some((l) => l.line_suffix) || acLines.some((l) => isSofaCode(l.itemKey));
    if (sofa) sofaDocs++;

    if (acLines.length !== erpLines.length) {
      const msg = `${ac}: AutoCount ${acLines.length} vs ERP ${erpLines.length} (ERP ${d.erp_no})`;
      if (sofa) D.lineCount++;
      else { F.lineCount.push(msg); lineCountRows.push({ key: ac, erpNo: d.erp_no, line: msg }); }
    }

    /* ── the two PAIRING-INDEPENDENT measurements ────────────────────────────
       Both are computed over the whole document, so no zip, sort or fallback
       can change either answer. That is the point of them: the line-level
       verdicts below rest on a correspondence this checker sometimes has to
       GUESS (grn/do/si/pi items carry no line key), and a guess must not be
       able to manufacture — or bury — a finding.

       A sofa is one book line and one ERP row per compartment, so neither
       measurement is commensurable there and neither is recorded; the sofa
       document keeps whatever the existing declared-decomposition path says. */
    let shapePerCode = null;
    if (!sofa) {
      const bagOf = (pairs) => {
        const m = new Map();
        for (const [code, qty] of pairs) {
          const c = norm(code);
          if (!c) continue;
          m.set(c, (m.get(c) ?? 0) + (Number.isFinite(qty) ? qty : 0));
        }
        return [...m.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1))
          .map(([c, q]) => `${c} x${q}`).join(" | ");
      };
      /* The BOOK's raw code is translated, because comparing an untranslated
         code against the ERP's own reports the whole catalogue as wrong
         (trap 2 at the top of this file). */
      const acPairs = acLines.map((l) => [mapped(l.itemKey), l.qty ?? 0]);
      const erpPairs = erpLines.map((l) => [l.item_code, l.qty == null ? 0 : Number(l.qty)]);
      bags.set(ac, {
        book: bagOf(acPairs),
        erp: bagOf(erpPairs),
        keyed: erpLines.some((l) => l.ac_dtlkey != null),
      });

      /* PER ITEM CODE: quantity and money, both sides. A code the ERP does not
         carry is permitted ONLY where the book prices it at RM 0.00 — that is
         the free gift AutoCount bills as its own line (`AK-SLEEP ESSENTIAL 7
         HOLES` on a mattress). A code carrying money is a missing line and
         stays a difference. */
      const sums = new Map();
      const take = (side, code, qty, sen) => {
        const c = norm(code);
        if (!c) return;
        if (!sums.has(c)) sums.set(c, { bookQty: 0, bookSen: 0, erpQty: 0, erpSen: 0 });
        const s = sums.get(c);
        s[`${side}Qty`] += Number.isFinite(qty) ? qty : 0;
        s[`${side}Sen`] += Number.isFinite(sen) ? sen : 0;
      };
      for (const l of acLines) take("book", mapped(l.itemKey), l.qty ?? 0, l.subTotalSen ?? 0);
      for (const l of erpLines) {
        take("erp", l.item_code, l.qty == null ? 0 : Number(l.qty),
          Math.round((l.qty == null ? 0 : Number(l.qty)) * (l.unit_price_sen == null ? 0 : Number(l.unit_price_sen))));
      }
      const perCode = [];
      for (const [code, s] of sums) {
        if (Math.abs(s.bookQty - s.erpQty) < 1e-4 && s.bookSen === s.erpSen) continue;
        if (s.erpQty === 0 && s.erpSen === 0 && s.bookSen === 0) continue; // the free line we do not carry
        perCode.push({
          code,
          why: `book qty ${s.bookQty} / RM ${rm(s.bookSen)} vs ours qty ${s.erpQty} / RM ${rm(s.erpSen)}`,
        });
      }
      shapePerCode = perCode;
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
      const line = `${ac}: AutoCount RM ${rm(bookTotal)} vs ERP RM ${rm(erpTotal)} (ERP ${d.erp_no})`;
      F.money.push(line);
      /* The same difference in a shape a classifier can read. The string above
         is what a human sees; this is what decides which column it lands in. */
      moneyRows.push({ key: ac, erpNo: d.erp_no, bookSen: bookTotal, erpSen: erpTotal, line });
    }

    /* Recorded HERE and not where `shapePerCode` was computed, because the
       totals are settled by the currency block immediately above: `bookTotal`
       is the DOCUMENT-currency figure since 2026-09-07, and reading a
       local-currency total instead is what once made an exchange rate look like
       a RM 13,068.55 discount (docs/bugs/0665). One reader, one answer. */
    if (shapePerCode !== null) {
      shapeFacts.set(ac, { totalsEqual: bookTotal === erpTotal, perCode: shapePerCode });
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
      else if (mapped(al.itemKey) !== norm(el.item_code)) {
        /* THE CODES DIFFER AS STRINGS. That is THREE unrelated populations
           wearing one number, and only the third is a defect. On 2026-09-08 the
           column read 101 on sales orders and 10 on purchase orders, and it was
           waved away all night as "derived, so it measures our translation, not
           a defect" - an assumption nobody had measured. Measured, it was 46
           translation, 4 decomposition and 61 genuinely different products, one
           of which is the shape that put a REGAL in front of a customer whose
           book line says TRION (docs/bugs/0668, 0671, 0689).

           The split itself is stated ONCE, in lib/item-code-class.mjs, and
           pinned by tests/itemCodeClass.test.mjs. It is not restated here,
           because two statements of one rule is how the mapping sheet came to
           have two parsers that disagreed. */
        const groupSize = erpPerKey.get(String(al.dtlKey)) ?? 1;
        const k = classifyItemCode({
          acCode: al.itemKey, erpCode: el.item_code, mapping: mappingRows, groupSize,
        });
        if (cfg.itemCodeDeclared) D.item++;
        else if (k.cls === "translation") { D.item++; C.itemTranslation++; }
        else if (k.cls === "decomposition") { D.item++; C.itemDecomposition++; }
        else {
          const line =
            `${ac} DtlKey ${al.dtlKey}: AutoCount "${al.itemKey}" vs ERP "${el.item_code ?? ""}"` +
            (k.wanted ? ` — the sheet says "${k.wanted}"` : " — the mapping sheet does not carry the book's code") +
            ` (ERP ${d.erp_no}; ${k.why})`;
          F.item.push(line);
          itemRows.push({ key: ac, erpNo: d.erp_no, line });
        }
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

  /* The split that decides which of the unit-price findings are DIFFERENCES.
     `book holds NO price` is not one: the book states 0.00 with a 0.00 line
     subtotal, so copying it would ERASE the ERP's price rather than correct it.
     It gets its own `no-price` column in the summary and is out of the gap
     total — unless the export self-check has fired, in which case none of the
     four buckets can be trusted and NOTHING moves. */
  const PX = splitBookUnpriced(P);
  const MZ = splitErpZeroMoney({
    rows: moneyRows,
    decision: cfg.zeroMoneyDecision ?? null,
    proof: zeroMoneyProof[t] ?? null,
  });
  /* THE TWO PAIRING-INDEPENDENT SPLITS. Both answer the same question about a
     column this checker cannot always compute honestly: is the finding a
     property of the DATA, or of the correspondence the checker had to invent
     because neither side carries a line key?

     Neither is an amnesty and both are tested to prove it
     (tests/acNotADifference.test.ts): a document whose item-code MULTISETS
     differ, or whose TOTAL differs, or which carries a priced line we do not
     have, stays counted and is reported LOUDER as an impostor. */
  const IC = splitGuessedItemCodePairing({ rows: itemRows, bags: bags.size ? bags : null });
  const LS = cfg.migratedChainLineShape
    ? splitMigratedChainLineShape({ rows: lineCountRows, facts: shapeFacts.size ? shapeFacts : null })
    : { lineShape: 0, differ: lineCountRows.length, moved: [], impostors: [], applied: false,
        why: "this type is not built by the migrated invoice chain, so a line-count difference is a difference" };
  log(
    `${t} DATA (${bothSides} documents on both sides, ${comparedLines} lines paired) — ` +
      `line-count differs: ${LS.differ}` + (LS.lineShape ? ` (+${LS.lineShape} the same goods and the same money on a different number of rows)` : "") +
      `; item code: ${IC.differ}` + (IC.guessed ? ` (+${IC.guessed} where we hold no line key and both sides name the SAME goods)` : "") +
      /* SAY WHAT WAS TAKEN OUT, in the same sentence as the number, or the drop
         from 101 to 61 on 2026-09-08 reads as work nobody did. The same rule is
         why `unit price` and `document total` now carry their own parenthetical
         below: three different lanes reclassified three different counts on the
         same day, and a number that shrinks without a reason attached is the
         thing the owner has to come back and ask about. */
      (C.itemTranslation + C.itemDecomposition
        ? ` (of ${F.item.length + C.itemTranslation + C.itemDecomposition} raw code differences: ` +
          `${C.itemTranslation} are the same product written another way, ` +
          `${C.itemDecomposition} are one book line decomposed into compartments)`
        : "") +
      `; quantity: ${F.qty.length}; ` +
      `unit price: ${PX.differ}` + (PX.noPrice ? ` (+${PX.noPrice} the book states no price for)` : "") +
      `; document total: ${MZ.differ}` + (MZ.erpZero ? ` (+${MZ.erpZero} our document carries RM 0.00 by the owner's decision)` : ""),
  );
  plain(
    `   unpaired: ${F.unmatchedAc.length} AutoCount lines, ${F.unmatchedErp.length} ERP lines; ` +
      `DtlKey on the wrong document: ${F.keyOrphan.length}; ` +
      `AutoCount lines with no ItemCode (description-only, not comparable): ${descOnly}`,
  );
  /* ZERO MONEY IN THE ERP — the owner's decision, applied ONLY where proved.
     A document total of RM 0.00 against a book value describes two completely
     different things: migrated paperwork the owner has ruled on, and a live
     document that lost its money. The shape alone cannot tell them apart, so
     the split below requires `migrated_no_stock` AND zero inventory movements
     per document. Anything that claims the decision and fails the proof is
     printed LOUDER than an ordinary difference and stays counted as one. */
  if (MZ.applied && MZ.erpZero) {
    log(
      `${t} — ${MZ.erpZero} of the ${bothSides} documents on both sides carry RM 0.00 in the ERP while the ` +
        `book states a value. NOT a money gap: 「${cfg.zeroMoneyDecision.label}」 — ${cfg.zeroMoneyDecision.ruling}.`,
    );
    plain(`      PROVED per document, not assumed: every one is migrated_no_stock with 0 inventory movements naming it.`);
    plain(`      What it costs: ${cfg.zeroMoneyDecision.consequence}.`);
    plain(`      RM 0.00 in the ERP (first ${Math.min(SHOW, MZ.moved.length)} of ${MZ.moved.length}):`);
    for (const row of first(MZ.moved)) plain(`      ${row.line}`);
  }
  if (MZ.impostors.length) {
    log(
      `${t} ZERO-MONEY DECISION REFUSED for ${MZ.impostors.length} document(s) — they carry RM 0.00 like the ` +
        `${MZ.erpZero} above, but they are NOT migrated paperwork. Every one is counted as a money difference:`,
    );
    for (const row of MZ.impostors.slice(0, SHOW)) plain(`      ${row.line} — ${row.why}`);
  }
  /* THE TWO PAIRING-INDEPENDENT SPLITS, reported. The `moved` half is printed
     with its proof so the reclassification can be checked; the `impostors` half
     is printed LOUDER than an ordinary difference, because a document dressed
     as benign is the one nobody goes and looks at. */
  if (IC.guessed) {
    log(
      `${t} — ${IC.guessed} item-code difference(s) are the CHECKER's own guess, not a wrong product: ${IC.why}`,
    );
    for (const row of first(IC.moved)) plain(`      ${row.line}`);
  }
  if (IC.impostors.length) {
    log(
      `${t} ITEM CODE — ${IC.impostors.length} document(s) have no line key AND the two sides do NOT name the ` +
        "same goods. These are the ones to look at first; every one stays counted as a difference:",
    );
    for (const row of IC.impostors.slice(0, SHOW)) plain(`      ${row.line} — ${row.why}`);
  }
  if (LS.lineShape) {
    log(`${t} — ${LS.lineShape} line-count difference(s) are a line SHAPE, not a missing line: ${LS.why}`);
    for (const row of first(LS.moved)) plain(`      ${row.line}`);
  }
  if (LS.impostors.length) {
    log(
      `${t} LINE COUNT — ${LS.impostors.length} document(s) differ in line count AND do not reconcile. ` +
        "Every one stays counted as a difference:",
    );
    for (const row of LS.impostors.slice(0, SHOW)) plain(`      ${row.line} — ${row.why}`);
  }
  if (!MZ.applied && zeroMoneyDocs) {
    log(
      `${t} — ${zeroMoneyDocs} of the ${bothSides} documents on both sides carry ZERO money in the ERP ` +
        "while the book carries a value. That is one systematic cause, not that many separate defects." +
        (cfg.zeroMoneyDecision ? ` They are still counted as differences: ${MZ.why}` : ""),
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
      ` [translation ${C.itemTranslation}, decomposition ${C.itemDecomposition}` +
      `, declared for this type ${D.item - C.itemTranslation - C.itemDecomposition}]` +
      (cfg.itemCodeDeclared ? ` — ${cfg.itemCodeDeclared}` : ""),
  );
  if (D.blankRows) {
    log(
      `${t} — ${D.blankRows} AutoCount row(s) across ${D.blankRowDocs.size} document(s) carry NO item code, NO ` +
        "quantity and NO money. AutoCount lets a salesperson leave a row empty; the ERP cannot hold one (a line " +
        "needs a product), so the two sides AGREE about them. DECLARED, not counted in the line-count column — " +
        "and a row with a quantity, or with money, is NOT in this class and stays a finding.",
    );
    for (const row of first(blankRowRows)) plain(`      ${row}`);
    if (blankRowRows.length > SHOW) plain(`      ... and ${blankRowRows.length - SHOW} more`);
  }
  if (cfg.priceDeclared) {
    plain(`   unit price is DECLARED for this type — ${cfg.priceDeclared}. The QUANTITY is not: it is copied from the book and is compared above.`);
  }
  if (F.price.length) {
    log(
      `${t} UNIT PRICE — ${PX.differ} real difference(s) and ${PX.noPrice} line(s) the BOOK states no price ` +
        `for, out of ${F.price.length}:` +
        `  book holds NO price, ERP does: ${P.bookUnpriced.length}` +
        `; both sides priced and they differ: ${P.bothPriced.length}` +
        `; ERP dropped a price the book states: ${P.erpDropped.length}` +
        `; export lost a price the book has: ${P.bookDropped.length}`,
    );
    plain(
      "      Only the last three are copy jobs. `book holds NO price` is the owner's 空白不覆盖 case — the book " +
        "states 0.00 AND a 0.00 line subtotal, so it holds no price to copy and the ERP's value must stand. " +
        "Houzs prices a purchase when the goods ARRIVE, so a blank there is the business working, not a gap.",
    );
    if (!PX.trusted) {
      log(
        `${t} NO-PRICE COLUMN REFUSED — ${PX.why} Nothing is moved out of the price column on this run.`,
      );
    }
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
    missing: AB.absent,
    /* The three counts that are NOT differences, each kept in its own field so
       the table can show it and the gap total can leave it out. Losing one of
       them into `gaps` would be the bug this whole split exists to prevent, so
       the arithmetic below adds the DIFFERENCE halves explicitly rather than
       subtracting the benign ones from a total. */
    decided: AB.decided,
    absenceIs: decisionHolds ? "DECISION" : "GAP",
    phantom: phantom.length,
    bothSides,
    unpairable: unpairableDocs.length,
    lineCount: LS.differ,
    lineShape: LS.lineShape,
    item: IC.differ,
    guessedPairing: IC.guessed,
    qty: F.qty.length,
    price: PX.differ,
    noPrice: PX.noPrice,
    money: MZ.differ,
    erpZeroMoney: MZ.erpZero,
    foreign: foreignDocs.length,
    gaps:
      (countsAsGap ? AB.absent : 0) +
      phantom.length + LS.differ + IC.differ + F.qty.length + PX.differ + MZ.differ,
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
/* THE LEFT HALF IS WORK; THE RIGHT HALF IS NOT.  Four columns —
   `decided`, `no-price`, `ERP-RM0` and `non-MYR` — are counts of things that
   are correct as they stand, and none of them is added into `gaps`.  They are
   printed anyway, and printed SEPARATELY, because the alternative is a number
   that silently disappears: the owner asked for these cells at zero, and the
   honest way to reach zero is to say what each count IS, not to stop counting
   it.  Each has a sentence under the table in his own terms. */
plain("        <-------------------- DIFFERENCES (the work) --------------------->  <----- NOT differences ----->");
/* ONE LIST FOR THE HEADER AND THE ROW, so they cannot drift apart.
   They were two independent literals, and on run 34187812364 the header
   announced `same-goods` and `same-money` while every row printed 16 cells
   under an 18-column heading: the two cells were added to the heading and the
   edit that was supposed to add them to the row silently did not apply. A
   heading that promises a column the rows do not carry is a table that lies,
   and nothing could catch it because nothing related the two. Now the same
   array yields both, and the loop below asserts the counts agree. */
const SUMMARY_COLUMNS = [
  { label: "type", width: -4, get: (s) => s.t },
  { label: "book", width: 5, get: (s) => s.acDocs },
  { label: "scope", width: 6, get: (s) => s.scope },
  { label: "erp", width: 6, get: (s) => s.erpLinked },
  { label: "absent", width: 7, get: (s) => s.missing },
  { label: "phantom", width: 8, get: (s) => s.phantom },
  { label: "both", width: 6, get: (s) => s.bothSides },
  { label: "lineCnt", width: 8, get: (s) => s.lineCount },
  { label: "item", width: 6, get: (s) => s.item },
  { label: "qty", width: 6, get: (s) => s.qty },
  { label: "price", width: 6, get: (s) => s.price },
  { label: "money", width: 6, get: (s) => s.money },
  /* An absence the owner has already ruled on, named in full in its own
     section above with the action still owed. */
  { label: "decided", width: 8, get: (s) => s.decided ?? 0 },
  /* The BOOK states no unit price. Copying it would ERASE the ERP's. */
  { label: "no-price", width: 9, get: (s) => s.noPrice ?? 0 },
  /* Our document carries RM 0.00 on migrated paperwork — the owner's standing
     decision, proved per document, never assumed. */
  { label: "ERP-RM0", width: 8, get: (s) => s.erpZeroMoney ?? 0 },
  /* Its own column, deliberately not folded into `money` and not counted in
     `gaps`: a foreign document is compared in its own currency and may be
     perfectly correct. What it flags is that the ERP tags it MYR. Ledger 0665. */
  { label: "non-MYR", width: 8, get: (s) => s.foreign ?? 0 },
  /* No AutoCount line number on these rows, so which of our lines answers which
     of the book's was the checker's own guess — and both sides list the same
     products in the same quantities, which no ordering can fake. */
  { label: "same-goods", width: 11, get: (s) => s.guessedPairing ?? 0 },
  /* An invoice built from OUR receipt or delivery: total equal to the sen and
     every item code agreeing, on a different number of rows. */
  { label: "same-money", width: 11, get: (s) => s.lineShape ?? 0 },
];
const cell = (v, w) => (w < 0 ? String(v).padEnd(-w) : String(v).padStart(w));
plain(SUMMARY_COLUMNS.map((c) => cell(c.label, c.width)).join(" "));
for (const s of summary) {
  const cells = SUMMARY_COLUMNS.map((c) => cell(c.get(s), c.width));
  if (cells.length !== SUMMARY_COLUMNS.length) {
    throw new Error(
      `summary row for ${s.t} rendered ${cells.length} cells under ` +
        `${SUMMARY_COLUMNS.length} headings — the table would misalign, which is how ` +
        "two announced columns went unprinted on run 34187812364",
    );
  }
  plain(cells.join(" "));
}
plain("");
plain("absent   = in the expected population and NOT in the ERP. A real gap: somebody has to carry the document over.");
plain("decided  = absent, but you have already said what to do with it. Listed by name above with the ruling and what is still owed;");
plain("           it stays here until it is done, and it is NOT counted as an unexplained gap.");
plain("no-price = AutoCount states NO price on the line (0.00 unit price AND a 0.00 line subtotal) while the ERP holds one.");
plain("           Houzs prices a purchase when the goods arrive, so this is the business working. Copying the book here would");
plain("           ERASE a real price, which is why it is not a difference and never a copy job.");
plain("ERP-RM0  = our document carries RM 0.00 while the book states a value, on migrated paperwork that moves no stock.");
plain("           Your decision 「GR 0 没关系」. Proved per document (migrated_no_stock, zero stock movements), never assumed.");
plain("           What it costs: a purchase invoice cannot be raised off a RM 0.00 receipt.");
plain("non-MYR  = documents compared in their OWN currency. Not a money difference, and never repaired by script.");
plain("same-goods = we hold NO AutoCount line number on these rows, so which of our lines answers which of the book's was the");
plain("           checker's own guess. Both sides list the SAME products in the SAME quantities, which no ordering can fake.");
plain("           What is unknown is the pairing, not the goods. A document whose two lists DIFFER stays counted above.");
plain("same-money = a purchase/sales invoice we built from OUR receipt or delivery. Its total equals the book to the sen and");
plain("           every item code agrees on quantity and money; only the number of rows differs, because AutoCount bills a");
plain("           free gift as its own RM 0.00 line and sometimes splits one product across two. Nothing is owed here.");
const totalGaps = summary.reduce((a, s) => a + s.gaps, 0);
const n = (v) => (typeof v === "number" ? v : 0);
const notWork = summary.reduce((a, s) => a + n(s.decided) + n(s.noPrice) + n(s.erpZeroMoney) + n(s.foreign) + n(s.guessedPairing) + n(s.lineShape), 0);
plain("");
log(
  totalGaps === 0
    ? "CLEAN — every in-scope AutoCount document is in the ERP and every comparable field agrees."
    : `${totalGaps} disagreements that are NOT covered by a declared design difference. Detail above.`,
);
if (notWork) {
  /* Stated as its own sentence rather than folded into the line above, because
     the number the owner acts on is `totalGaps` and the number he keeps asking
     about is this one. Both are printed; neither is hidden inside the other. */
  log(
    `${notWork} more count(s) are shown in the four right-hand columns and are NOT work: ` +
      summary
        .flatMap((s) => [
          n(s.decided) ? `${s.t} decided ${s.decided}` : null,
          n(s.noPrice) ? `${s.t} the book states no price ${s.noPrice}` : null,
          n(s.erpZeroMoney) ? `${s.t} our document carries RM 0.00 ${s.erpZeroMoney}` : null,
          n(s.foreign) ? `${s.t} not in ${LOCAL_CURRENCY} ${s.foreign}` : null,
        ])
        .filter(Boolean)
        .join("; ") +
      ". Each is explained under the table.",
  );
}

await sql.end({ timeout: 5 });
