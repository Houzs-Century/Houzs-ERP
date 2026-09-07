/* ac-scope — THE in-scope definition for the AutoCount -> ERP migration, and
 * the only place it is written down.
 *
 * WHY THIS FILE EXISTS.  The population "which AutoCount documents is the ERP
 * supposed to hold" was stated twice: once as SQL inside
 * `export-ac-reimport.py` (which cuts the migration source files against the
 * live book) and once again, restated over the snapshot columns, inside
 * `check-ac-erp-reconcile.mjs`.  Two statements of one rule is how a checker
 * comes to measure a population no importer ever carried — it reports a gap
 * that is really a disagreement between two copies of the same sentence.
 * There is still a Python twin, because the exporter has to run as SQL against
 * the book; it is named line by line below so a change to one is a visible
 * change to the other.
 *
 * READ-ONLY.  Pure functions over a decoded snapshot: no database, no network,
 * no dependencies.  It must keep running on a bare checkout with no
 * node_modules, because `check-ac-gap-attribution.mjs` is re-executed by the
 * completeness-claim gate in exactly that state.
 *
 * ── THE DEFINITION ──────────────────────────────────────────────────────────
 * The owner's rule, 2026-08-09 and 2026-08-10, verified against the live book:
 * OUTSTANDING = NOT yet transferred onward.  The migration carried the
 * OUTSTANDING population, so a fully-delivered sales order absent from the ERP
 * is CORRECT, not a gap.  Per type:
 *
 *   SO  Cancelled='F', DocNo NOT LIKE 'HC-%' / 'ZZ%', at least one line with
 *       Qty > TransferedQty, and NOT invoiced direct (no IVDTL row with
 *       FromDocType='SO' naming it).  SODTL.TransferedQty counts DO transfers
 *       only; TransferedPOQty is a separate counter and never disqualifies.
 *       An SO invoiced without a delivery order is a completed cash sale, and
 *       the owner excluded those on 2026-08-10.
 *       Python twin: SO_OUT + NOT (HAS_IV), export-ac-reimport.py:169/174.
 *
 *   PO  Cancelled='F', not a test doc, and EITHER at least one line with
 *       Qty > TransferedQty (lane 1) OR raised for a line of an in-scope SO
 *       (lane 2, via PODTL.FromSODtlKey or the comma-joined FromDocNo).
 *       Python twin: export-ac-reimport.py:235 (lane 1) and :253 (lane 2).
 *
 *   GR  Cancelled='F', not a test doc, at least one line with FromDocType='PO'
 *       naming an in-scope PO.  Python twin: the gr_refs cut, which restricts
 *       to the in-scope PO list, export-ac-reimport.py:332.
 *
 *   DO  Cancelled='F', at least one line with FromDocType='SO' naming an
 *       in-scope SO.  This is the owner's DO rule seen from the other end and
 *       it is NOT a bug to fix: the DOs in scope are exactly the deliveries
 *       already made against an order that is still outstanding.  A test-doc
 *       filter is deliberately NOT applied to the DO itself — membership is
 *       decided by the SO it delivers, which is already filtered.
 *       Python twin: export-ac-reimport.py:285.
 *
 *   IV  no population.
 *   PI  no population.
 *       The owner declined the historical invoice import ("这个不要").  What the
 *       ERP holds is post-cutover mirroring, so an absent historical invoice is
 *       a DECISION and must be counted apart from the gaps — an empty scope is
 *       what puts it in that column.
 *
 * ── WHERE EACH POPULATION IS ALREADY WRITTEN DOWN ───────────────────────────
 * MIGRATION_SOURCE below names, per type, the committed file that holds the
 * population and the job that writes it into the ERP.  It is the answer to the
 * question a gap actually raises: is this document missing, or is it sitting in
 * a file we have and simply has not been run in?  On 2026-09-07 that question
 * was worth 32 GR and 12 DO.
 */

export const isTestDoc = (docNo) => String(docNo ?? "").startsWith("HC-") || String(docNo ?? "").startsWith("ZZ");

/** Decode `data/ac-reconcile-truth.json.gz` (already parsed) into typed maps.
 *  Named for the SNAPSHOT deliberately: variant-reconcile.mjs exports its own
 *  `decodeBook`, which decodes one line's BUILD TEXT and is a different thing. */
export function decodeSnapshot(snap) {
  const hIdx = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
  const lIdx = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const sen = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 100));

  const book = {};
  for (const [t, payload] of Object.entries(snap.types)) {
    const headers = new Map();
    for (const r of payload.headers) {
      headers.set(r[hIdx.docNo], {
        docNo: r[hIdx.docNo],
        docDate: r[hIdx.docDate],
        cancelled: r[hIdx.cancelled] === "T",
        totalSen: sen(r[hIdx.netTotal]),
        lineCount: Number(r[hIdx.lineCount]),
      });
    }
    const lines = new Map();
    const byDtlKey = new Map();
    for (const r of payload.lines) {
      const l = {
        docNo: r[lIdx.docNo],
        dtlKey: r[lIdx.dtlKey],
        seq: Number(r[lIdx.seq]),
        itemKey: r[lIdx.itemKey],
        hasCode: r[lIdx.hasCode] === "1",
        qty: num(r[lIdx.qty]),
        unitPriceSen: sen(r[lIdx.unitPrice]),
        subTotalSen: sen(r[lIdx.subTotal]),
        transferedQty: num(r[lIdx.transferedQty]),
        fromDocType: r[lIdx.fromDocType],
        fromDocNo: r[lIdx.fromDocNo],
        fromSoDtlKey: r[lIdx.fromSoDtlKey],
      };
      if (!lines.has(l.docNo)) lines.set(l.docNo, []);
      lines.get(l.docNo).push(l);
      byDtlKey.set(l.dtlKey, l);
    }
    /* Desc2 is exported only for lines that HAVE one, so an absent key means the
       book said nothing about the build — which is BOOK-BLANK, never unknown.
       A snapshot cut before 2026-09-07 carries none at all; refusing on that is
       the CALLER's job, because only the caller knows whether it is about to
       compare variants. */
    const desc2 = new Map();
    for (const [key, text] of payload.desc2 || []) desc2.set(key, text);
    book[t] = { headers, lines, byDtlKey, desc2 };
  }
  return book;
}

/**
 * The definition above, executed.  Returns one Set of AutoCount document
 * numbers per type, plus the SO DtlKeys the PO lane-2 test needs.
 */
export function buildScope(book) {
  const soInvoicedDirect = new Set();
  for (const ls of book.IV.lines.values()) {
    for (const l of ls) if (l.fromDocType === "SO" && l.fromDocNo) soInvoicedDirect.add(l.fromDocNo);
  }

  const SO = new Set();
  for (const [docNo, h] of book.SO.headers) {
    if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
    const ls = book.SO.lines.get(docNo) || [];
    if (!ls.some((l) => (l.qty ?? 0) > (l.transferedQty ?? 0))) continue;
    if (soInvoicedDirect.has(docNo)) continue;
    SO.add(docNo);
  }

  const soDtlKeysInScope = new Set();
  for (const d of SO) for (const l of book.SO.lines.get(d) || []) soDtlKeysInScope.add(l.dtlKey);

  const PO = new Set();
  for (const [docNo, h] of book.PO.headers) {
    if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
    const ls = book.PO.lines.get(docNo) || [];
    const lane1 = ls.some((l) => (l.qty ?? 0) > (l.transferedQty ?? 0));
    const lane2 = ls.some(
      (l) =>
        (l.fromSoDtlKey && soDtlKeysInScope.has(l.fromSoDtlKey)) ||
        (l.fromDocNo && l.fromDocNo.split(/[,;\s]+/).some((n) => SO.has(n))),
    );
    if (lane1 || lane2) PO.add(docNo);
  }

  const GR = new Set();
  for (const [docNo, h] of book.GR.headers) {
    if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
    const ls = book.GR.lines.get(docNo) || [];
    if (ls.some((l) => l.fromDocType === "PO" && PO.has(l.fromDocNo))) GR.add(docNo);
  }

  const DO = new Set();
  for (const [docNo, h] of book.DO.headers) {
    if (!docNo || h.cancelled) continue;
    const ls = book.DO.lines.get(docNo) || [];
    if (ls.some((l) => l.fromDocType === "SO" && SO.has(l.fromDocNo))) DO.add(docNo);
  }

  return { SO, PO, GR, DO, IV: new Set(), PI: new Set(), soDtlKeysInScope };
}

/**
 * Per type: the committed file that already holds the migration population, the
 * field in it that carries the AutoCount document number, and the job that
 * writes it into the ERP.  `docField: null` means the population is not carried
 * as a file of its own — SO and PO are imported document-by-document from their
 * own exports, which use a different row shape.
 */
export const MIGRATION_SOURCE = {
  SO: {
    file: "ac-outstanding-so.json.gz",
    docField: "DocNo",
    writer: "backend/scripts/import-ac-outstanding-so.mjs",
    workflow: "import-ac-outstanding-so.yml",
  },
  PO: {
    file: "ac-outstanding-po.json.gz",
    docField: "DocNo",
    also: "ac-so-linked-pos.json.gz",
    writer: "backend/scripts/import-ac-outstanding-po.mjs + import-ac-so-linked-pos.mjs",
    workflow: "import-ac-outstanding-po.yml + import-ac-so-linked-pos.yml",
  },
  GR: {
    file: "ac-gr-refs.json.gz",
    docField: "GrNo",
    writer: "backend/scripts/stamp-ac-grn-refs.mjs",
    workflow: "stamp-ac-grn-refs.yml",
    note:
      "the ERP carries a POINTER on the purchase order (purchase_orders.linked_ac_grn_docnos), " +
      "not a GRN document — a GRN here IS an inventory event and the units are already in from " +
      "the balance snapshot",
  },
  DO: {
    file: "ac-partial-dos.json.gz",
    docField: "DoNo",
    writer: "backend/scripts/create-migrated-documents.mjs (KIND=do)",
    workflow: "create-migrated-documents.yml",
  },
  IV: { file: null, docField: null, writer: null, workflow: null },
  PI: { file: null, docField: null, writer: null, workflow: null },
};
