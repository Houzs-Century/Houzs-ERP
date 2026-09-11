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
 *   IV  Cancelled='F', at least one line with FromDocType='DO' naming an
 *       in-scope DO (or FromDocType='SO' naming an in-scope SO, which the SO
 *       rule makes empty by construction — an order invoiced direct is excluded
 *       from SO scope, so it can never carry an in-scope invoice; the arm is
 *       written anyway so the rule reads as one sentence).
 *
 *   PI  Cancelled='F', at least one line with FromDocType='GR' naming an
 *       in-scope GR, or FromDocType='PO' naming an in-scope PO.
 *
 *       CORRECTED 2026-09-07.  Both of these read "no population" until the
 *       owner was shown that reading and rejected it:
 *
 *           没有的 SO DO 何来发票？有的 SO DO 自然要发票
 *
 *       His earlier 「这个不要」 declined importing the HISTORY — all 10,285
 *       sales invoices and 5,279 purchase invoices — and that still stands.  It
 *       never meant that an in-scope document's own invoice stays behind.  The
 *       two are three orders of magnitude apart, and an empty Set was reporting
 *       every one of the in-scope invoices as a DECISION rather than a gap.
 *
 * ── WHERE EACH POPULATION IS ALREADY WRITTEN DOWN ───────────────────────────
 * MIGRATION_SOURCE below names, per type, the committed file that holds the
 * population and the job that writes it into the ERP.  It is the answer to the
 * question a gap actually raises: is this document missing, or is it sitting in
 * a file we have and simply has not been run in?  On 2026-09-07 that question
 * was worth 32 GR and 12 DO.
 */

export const isTestDoc = (docNo) => String(docNo ?? "").startsWith("HC-") || String(docNo ?? "").startsWith("ZZ");

/** The ERP's local currency. `import-ac-outstanding-po.mjs:401` hard-codes it
 *  into `purchase_orders.currency` for every migrated purchase order. */
export const LOCAL_CURRENCY = 'MYR';

/**
 * Is this document one whose totals may be compared against the ERP's at all?
 *
 * A DISCOUNT AND AN EXCHANGE RATE ARE NOT DISTINGUISHABLE FROM A TOTAL ALONE,
 * and on 2026-09-07 that cost RM 13,068.55 on a live purchase order: the
 * snapshot carried `LocalNetTotal` (MYR) while the ERP held the document's own
 * CNY figures, so `PO-009335` looked 38.06% "discounted" and the repair booked
 * the difference. 34,334.90 x 0.61938 = 21,266.35 — the discount WAS the rate.
 * Ledger: docs/bugs/0665-*.md.
 *
 * So the rule is refusal, not cleverness. Three verdicts, and only one of them
 * lets money move:
 *
 *   local    the document is in MYR at rate 1 — the two sides mean the same
 *            thing and the comparison is sound.
 *   foreign  the document is in another currency, or at a rate that is not 1.
 *            REFUSED. The gap between the two totals may be a discount, may be
 *            the rate, may be both; nothing here can tell them apart.
 *   unknown  the snapshot predates the currency columns, so the document's
 *            currency was never exported. ALSO REFUSED — an absent column read
 *            as "MYR" is the original defect, restated.
 */
export function currencyVerdict(header) {
  if (!header) return { kind: 'unknown', why: 'the book states no header for this document' };
  const code = (header.currency ?? '').trim().toUpperCase();
  const rate = header.rate;
  if (!code || rate == null) {
    return {
      kind: 'unknown',
      why: 'this snapshot carries no currency for the document — re-cut it with a version of ' +
        'export-ac-reconcile-truth.mjs that exports CurrencyCode and CurrencyRate',
    };
  }
  if (code !== LOCAL_CURRENCY || Math.abs(rate - 1) > 1e-9) {
    /* `code` and `rate` are RETURNED so the caller can compare the book's
       currency against the ERP's OWN column. This used to say "and the ERP
       holds MYR" as a flat assertion — a sentence about a value nothing had
       read. HC-PO-009335 was repaired to CNY on 2026-09-07 (run 34143840216
       printed `verified HC-PO-009335 currency = 'CNY'`) and this text went on
       calling it MYR the next day. Stating a side you did not read is the same
       failure as counting a comparison that never ran (docs/bugs/0715). */
    return { kind: 'foreign', code, rate, why: `the document is in ${code} at rate ${rate}` };
  }
  return { kind: 'local', code, rate, why: `${code} at rate ${rate}` };
}

/** Decode `data/ac-reconcile-truth.json.gz` (already parsed) into typed maps.
 *  Named for the SNAPSHOT deliberately: variant-reconcile.mjs exports its own
 *  `decodeBook`, which decodes one line's BUILD TEXT and is a different thing. */
export function decodeSnapshot(snap) {
  const hIdx = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
  const lIdx = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const sen = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 100));

  /* Present ONLY on a snapshot cut 2026-09-07 or later.  `currency` / `rate` /
     `docTotal` / `docSubTotal` came in after a currency-blind checker read an
     exchange rate as a line discount and took RM 13,068.55 off a live CNY
     purchase order (docs/bugs/0665-*.md).  An older cut decodes them as NULL,
     which is the point: a consumer that needs the currency can then REFUSE,
     instead of reading an absent column as "MYR" — the mistake in miniature. */
  const hasCurrency = Object.hasOwn(hIdx, "currency") && Object.hasOwn(hIdx, "rate");

  const book = {};
  for (const [t, payload] of Object.entries(snap.types)) {
    const headers = new Map();
    for (const r of payload.headers) {
      headers.set(r[hIdx.docNo], {
        docNo: r[hIdx.docNo],
        docDate: r[hIdx.docDate],
        cancelled: r[hIdx.cancelled] === "T",
        /* LOCAL currency (MYR) — the books' own figure, unchanged. */
        totalSen: sen(r[hIdx.netTotal]),
        lineCount: Number(r[hIdx.lineCount]),
        /* DOCUMENT currency. On a MYR document these equal the two above; on a
           foreign one they are what the document itself says. */
        currency: hasCurrency ? (r[hIdx.currency] || null) : null,
        rate: hasCurrency ? num(r[hIdx.rate]) : null,
        docTotalSen: Object.hasOwn(hIdx, "docTotal") ? sen(r[hIdx.docTotal]) : null,
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
        /* LOCAL currency (MYR). `docSubTotalSen` is the same line stated in the
           DOCUMENT's currency, and is null on a snapshot cut before 2026-09-07. */
        subTotalSen: sen(r[lIdx.subTotal]),
        docSubTotalSen: Object.hasOwn(lIdx, "docSubTotal") ? sen(r[lIdx.docSubTotal]) : null,
        transferedQty: num(r[lIdx.transferedQty]),
        fromDocType: r[lIdx.fromDocType],
        fromDocNo: r[lIdx.fromDocNo],
        fromSoDtlKey: r[lIdx.fromSoDtlKey],
        /* The line's own stock location. APPENDED to the export 2026-09-08 and
           read BY NAME, exactly like the currency fields above: a snapshot cut
           before that carries no such column and decodes to null, so a consumer
           can say "this cut cannot answer where the goods shipped from" instead
           of reading an absent column as a blank location. Blank in the BOOK
           also decodes to null — 1,135 of 48,772 DO lines are genuinely blank —
           and the two are the same answer here, because the rule that consumes
           this (lib/ac-do-location.mjs) treats "no location" as "cannot
           resolve" either way and never defaults. */
        location: Object.hasOwn(lIdx, "location") ? (r[lIdx.location] || null) : null,
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

  /* An invoice belongs to the migration when the document it was raised FROM
     does. Owner 2026-09-07: 「没有的 SO DO 何来发票？有的 SO DO 自然要发票」. */
  const IV = new Set();
  for (const [docNo, h] of book.IV.headers) {
    if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
    const ls = book.IV.lines.get(docNo) || [];
    if (ls.some((l) => (l.fromDocType === "DO" && DO.has(l.fromDocNo)) ||
                       (l.fromDocType === "SO" && SO.has(l.fromDocNo)))) IV.add(docNo);
  }

  const PI = new Set();
  for (const [docNo, h] of book.PI.headers) {
    if (!docNo || h.cancelled || isTestDoc(docNo)) continue;
    const ls = book.PI.lines.get(docNo) || [];
    if (ls.some((l) => (l.fromDocType === "GR" && GR.has(l.fromDocNo)) ||
                       (l.fromDocType === "PO" && PO.has(l.fromDocNo)))) PI.add(docNo);
  }

  return { SO, PO, GR, DO, IV, PI, soDtlKeysInScope };
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
  /* CORRECTED 2026-09-07 with the population itself. These are not "no
     importer" — `create-migrated-invoices.mjs` turns the GR and DO the ERP
     already carries into the purchase and sales invoices AutoCount raised from
     them, which is exactly the owner's rule 「有的 SO DO 自然要发票」. It
     converts OUR documents; it still does not import AutoCount's invoice
     HISTORY, which he declined separately. */
  IV: {
    file: "ac-invoice-refs.json.gz",
    docField: null,
    keysOf: "ivMeta",
    writer: "backend/scripts/create-migrated-invoices.mjs",
    workflow: "create-migrated-invoices.yml",
    note: "created FROM the migrated delivery orders, not imported from the book's invoice history",
  },
  PI: {
    file: "ac-invoice-refs.json.gz",
    docField: null,
    keysOf: "piMeta",
    writer: "backend/scripts/create-migrated-invoices.mjs",
    workflow: "create-migrated-invoices.yml",
    note: "created FROM the migrated goods receipts, not imported from the book's invoice history",
  },
};
