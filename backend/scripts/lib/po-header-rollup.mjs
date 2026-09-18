// Which purchase-order headers may be rolled up from their own lines, and what
// each one becomes. PURE: rows in, findings out. No filesystem, no database, no
// process.exit - the runner (../rollup-po-header-total.mjs) does the I/O.
//
// NO SHEBANG: backend/tests/poHeaderRollup.test.mjs imports this module, and on
// Windows vitest inlines it, where a `#!` that is no longer at byte 0 is a
// load-time SyntaxError (CLAUDE.md, "Anything a TEST imports lives in
// backend/scripts/lib/").
//
// THE OWNER'S RULING, 2026-09-08: recompute the header = add up the lines.
//
// WHAT WENT WRONG (docs/bugs/0675-70-migrated-purchase-orders-*). Both purchase
// -order importers write the header as `total_sen = SUM(qty x priceSen)` with
// `priceSen` copied straight from AutoCount's `PODTL.UnitPrice`, which is
// RM 0.00 on 10,810 of the book's 18,890 PO lines - Houzs does not price factory
// purchase orders in AutoCount. The ERP's LINE prices were set later by
// something other than the import, and that repricing never rolled back up to
// the header. So the header faithfully copied a zero and the lines have since
// grown real money.
//
// THE RULE IS THE APP'S OWN, NOT A NEW ONE. `applyPoAmendment`
// (src/scm/lib/po-revision.ts:285-303) re-reads the lines and writes
// `subtotal_sen = SUM(line_total_sen)` and `total_sen = subtotal + tax_sen`.
// Copying that here means a rolled-up header is indistinguishable from one the
// app itself would have written after an amendment. A second definition of what
// a purchase order is worth is exactly this repo's most expensive recurring bug.
//
// CURRENCY. `purchase_order_items` has NO currency column: a line is stated in
// its document's currency by construction, so summing a document's OWN lines
// into its OWN header cannot mix currencies. That is the reason it is safe, and
// it is the reason the amounts are NEVER compared against the book's `netTotal`
// - that column is the LOCAL (MYR) amount, and reading it against a
// document-currency figure is what wrote RM 13,068.55 of fabricated discount
// onto a CNY purchase order (docs/bugs/0665, 0666). Non-MYR documents are
// counted, listed and rolled up in their OWN currency, and every total this
// module reports is per-currency. Nothing sums two currencies together.

/** A document whose header is zero while its own lines carry money. */
export const isZeroHeaderWithPricedLines = (h) =>
  Number(h.total_sen) === 0 && Number(h.line_sum_sen) > 0;

/**
 * @param {object} a
 * @param {Array}  a.headers  one row per purchase order: id, po_number, currency,
 *                            subtotal_sen, tax_sen, total_sen, line_count,
 *                            line_sum_sen, qty_price_sum_sen
 * @returns {{plan: Array, refused: Array, counts: Object, byCurrency: Map}}
 */
export function planPoHeaderRollups({ headers }) {
  const plan = [];
  const refused = [];
  const counts = {
    documents: 0, zeroHeaderPricedLines: 0, zeroHeaderZeroLines: 0,
    headerAlreadyEqualsLines: 0, headerDisagreesButNotZero: 0, noCurrency: 0, lineSumUnsound: 0,
  };
  /* Per-currency, ALWAYS. A single grand total across currencies is the shape
     that has already cost this project money once. */
  const byCurrency = new Map();
  const bump = (cur, field, n) => {
    if (!byCurrency.has(cur)) byCurrency.set(cur, { documents: 0, before_sen: 0, after_sen: 0 });
    byCurrency.get(cur)[field] += n;
  };

  for (const h of headers ?? []) {
    counts.documents++;
    const total = Number(h.total_sen);
    const subtotal = Number(h.subtotal_sen);
    const tax = Number(h.tax_sen);
    const lineSum = Number(h.line_sum_sen ?? 0);
    const qtyPriceSum = Number(h.qty_price_sum_sen ?? 0);
    const cur = h.currency ? String(h.currency) : null;

    /* Counted FIRST and apart, even though it also satisfies "the header equals
       its lines": a zero over zero is the book pricing no factory purchase
       order, and rolling the two buckets together is what would let the 70 hide
       inside a five-hundred-document "already fine". */
    if (total === 0 && lineSum === 0) { counts.zeroHeaderZeroLines++; continue; }

    if (total === subtotal + tax && subtotal === lineSum) { counts.headerAlreadyEqualsLines++; continue; }

    if (!isZeroHeaderWithPricedLines({ total_sen: total, line_sum_sen: lineSum })) {
      counts.headerDisagreesButNotZero++;
      refused.push({
        why: "notZero", poNumber: h.po_number, currency: cur,
        detail: `header ${total} <> lines ${lineSum} + tax ${tax}, but the header is NOT zero - outside the ruling (the owner ruled on the 70 zero-total documents). Reported, never written.`,
      });
      continue;
    }
    counts.zeroHeaderPricedLines++;

    /* A document with no currency cannot be reasoned about at all, so it is
       refused rather than assumed to be ringgit. */
    if (!cur) {
      counts.noCurrency++;
      refused.push({ why: "noCurrency", poNumber: h.po_number, currency: null, detail: "the header carries no currency - REFUSED rather than assumed MYR." });
      continue;
    }

    /* `line_total_sen` is the column the app's own roll-up reads. When it
       disagrees with qty x unit_price the LINE is the defect, and rolling that
       disagreement up into the header would bury it. */
    if (lineSum !== qtyPriceSum) {
      counts.lineSumUnsound++;
      refused.push({
        why: "lineSumUnsound", poNumber: h.po_number, currency: cur,
        detail: `SUM(line_total_sen) ${lineSum} <> SUM(qty x unit_price_sen) ${qtyPriceSum} - the LINES disagree with themselves; a person owns that before any header is rolled up.`,
      });
      continue;
    }

    bump(cur, "documents", 1);
    bump(cur, "before_sen", total);
    bump(cur, "after_sen", lineSum + tax);

    plan.push({
      id: h.id,
      poNumber: h.po_number,
      acDocNo: h.linked_ac_docno ?? null,
      currency: cur,
      status: h.status ?? null,
      lineCount: Number(h.line_count ?? 0),
      fromSubtotalSen: subtotal,
      fromTotalSen: total,
      taxSen: tax,
      toSubtotalSen: lineSum,
      toTotalSen: lineSum + tax,
    });
  }

  return { plan, refused, counts, byCurrency };
}
