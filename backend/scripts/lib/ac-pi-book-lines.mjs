/* ac-pi-book-lines — build a migrated purchase invoice's LINES out of the
 * account book's own purchase-invoice lines, and say which of our goods-receipt
 * lines each one bills.
 *
 * ── THE OWNER'S RULE THIS EXISTS FOR ───────────────────────────────────────
 * 2026-09-09: 「就是每一个 line item 都要跟 autocall 一样啊」 and, sharpening it,
 * 「total amount不需要 可是line amount一定一样」 — the invoice TOTAL need not
 * equal the book's, but every LINE AMOUNT must. 「如果 25% 的折扣，那你也要跟着
 * 25%」.
 *
 * ── WHY OUR RECEIPT'S LINES CANNOT SATISFY THAT RULE ──────────────────────
 * `create-migrated-invoices.mjs` used to build the invoice from the ERP
 * receipt's own lines. Two measured shapes make that unable to equal the book,
 * both taken from `data/ac-reconcile-truth.json.gz` (cut 2026-09-09T00:18Z):
 *
 *   1. THE BOOK SPLITS ONE RECEIPT LINE ACROSS TWO INVOICES. `GR-003813` holds
 *      1 x 920 and 2 x 850; `PI-006011` bills 1 x 850 and `PI-006012` bills
 *      1 x 920 + 1 x 850. A converter that copies the receipt's `2 x 850` row
 *      cannot produce that shape at all, whatever price it puts on it.
 *
 *   2. AUTOCOUNT ROUNDS AN AMOUNT-SHAPED DISCOUNT DIFFERENTLY ON ITS OWN TWO
 *      DOCUMENTS. `GR-001910` dtl 410660 is 3 x 32.94 = 98.82 and the book's
 *      RECEIPT says 84.00, while `PI-002949` dtl 410782 says 83.99. Same for
 *      `GR-003750` dtl 700960 (receipt 12,093.52, `PI-005629` 12,093.51).
 *      Neither equals qty x unit, so nothing derived from a unit price and a
 *      quantity reproduces them. Only copying the INVOICE line does.
 *
 * So the line is copied, never computed: item, quantity, unit price and amount
 * all come off `PIDTL` exactly as the snapshot carries them.
 *
 * ── HOW A BOOK INVOICE LINE IS TIED TO ONE OF OUR RECEIPT LINES ───────────
 * AutoCount records the source DOCUMENT and never the source LINE —
 * `PIDTL.FromDocDtlKey` is empty on every row, which
 * `lib/ac-pi-gr-line-match.mjs` re-asserts on each run and
 * `repair-pi-gr-links.mjs` refuses to run without. And the migration never
 * stamped the book's line key onto our receipts either: 0 of 636 goods-receipt
 * lines carried `linked_ac_dtlkey` when `lib/ac-forced-line-pairing.mjs`
 * measured production on 2026-09-08.
 *
 * What both sides DO state is the item code and the quantity, so the tie is
 * made on those, inside the one receipt the book names, and in two passes:
 *
 *   pass 1  exact (item code, quantity). One of our lines to one book line.
 *   pass 2  the SPLIT of shape 1 above: our line's quantity is reached
 *           EXACTLY by a run of book lines of the same item code, in the
 *           book's own (document, seq) order. All of them bill that one
 *           receipt line, and they may sit on different invoices.
 *
 * NEVER BY POSITION, and never by "close enough". A run that overshoots is not
 * taken. Anything left over on either side is COUNTED AND NAMED — an unbilled
 * receipt line of ours, or a book line billing goods the migration never
 * carried — because the cutover carried the OUTSTANDING part of a receipt and
 * the book's invoice bills the whole of it, so a surplus on the book's side is
 * the normal shape here and not a defect. `lib/ac-gr-po-line-match.mjs` records
 * what position matching cost when it was tried (docs/bugs/0690, 0730).
 *
 * PURE: rows in, an assignment out. No filesystem, no database, no clock, no
 * printing, no process.exit. The runner owns the I/O.
 *
 * NO SHEBANG: tests/acPiBookLines.test.mjs imports this module, and on Windows
 * vitest inlines it, where a `#!` no longer at byte 0 is a load-time
 * SyntaxError (see lib/ac-mapping-csv.mjs for the same reason).
 */

/** An item code, trimmed and NOTHING else — deliberately the same reading as
 *  `lib/ac-pi-gr-line-match.mjs`'s `code`. Real codes carry meaningful spaces
 *  and brackets ("HOK-1030 (HF)(W) (Q)"), and folding case would merge codes
 *  the item master keeps apart. */
const code = (s) => String(s ?? "").trim();

/** Quantities are float8 in the ERP and decimal in the book; 4dp is finer than
 *  any quantity either system records and coarser than the float noise. Same
 *  reading as `lib/ac-forced-line-pairing.mjs`'s `qtyKey`. */
const qty4 = (q) => Number(Number(q ?? 0).toFixed(4));

/** The book's own order for a line: its document, then its sequence. */
const bookOrder = (a, b) =>
  String(a.docNo).localeCompare(String(b.docNo)) || (a.seq ?? 0) - (b.seq ?? 0) ||
  String(a.dtlKey).localeCompare(String(b.dtlKey));

/**
 * Assign one migrated goods receipt's lines to the account book's purchase
 * invoice lines that bill it.
 *
 * @param {object}   args
 * @param {Array<{lineId: string, itemCode: string, qty: number}>} args.ourLines
 *        our receipt's lines, already net of anything invoiced or returned.
 * @param {Array<{docNo: string, dtlKey: string, seq: number, itemKey: string,
 *                qty: number, unitPriceSen: number, amountSen: number}>} args.bookLines
 *        every book PURCHASE-INVOICE line raised from the AutoCount receipt(s)
 *        this ERP receipt mirrors, cancelled invoices already removed.
 * @param {Set<string>} [args.taken]
 *        DtlKeys already claimed, carried ACROSS calls and mutated. Two of our
 *        receipts can name the same AutoCount receipt — one ERP receipt folds
 *        several of the book's, and the fold list is the purchase order's, so
 *        both receipts under one order list both — and without a shared set
 *        each of them would bill the same book line. Billing something twice is
 *        the expensive direction.
 * @returns {{
 *   assigned: Array<{lineId: string, acInvoiceNo: string, book: object, how: string}>,
 *   unbilled: Array<{lineId: string, itemCode: string, qty: number, why: string}>,
 *   surplus:  Array<{docNo: string, dtlKey: string, itemKey: string, qty: number, amountSen: number}>,
 * }}
 */
export function assignBookInvoiceLines({ ourLines, bookLines, taken: sharedTaken }) {
  const assigned = [];
  const unbilled = [];

  /* Book lines bucketed by item code, in the book's own order, each taken at
     most once. `taken` is the single source of truth for consumption so a line
     can never reach two invoices or two receipt lines. */
  const byItem = new Map();
  for (const b of [...(bookLines ?? [])].sort(bookOrder)) {
    const k = code(b.itemKey);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(b);
  }
  const taken = sharedTaken ?? new Set();
  const free = (k) => (byItem.get(k) ?? []).filter((b) => !taken.has(b.dtlKey));

  const ours = [...(ourLines ?? [])];

  /* ── PASS 1: exact (item code, quantity) ──────────────────────────────── */
  const stillOurs = [];
  for (const l of ours) {
    const k = code(l.itemCode);
    const want = qty4(l.qty);
    const hit = free(k).find((b) => qty4(b.qty) === want);
    if (!hit) { stillOurs.push(l); continue; }
    taken.add(hit.dtlKey);
    assigned.push({
      lineId: l.lineId, acInvoiceNo: hit.docNo, book: hit,
      how: `the book's ${hit.docNo} line ${hit.dtlKey} bills ${want} x ${k} off this receipt`,
    });
  }

  /* ── PASS 2: the book SPLIT this receipt line across several invoice lines ─
     Only an EXACT sum counts. A run that overshoots our quantity is left
     alone: taking part of it would bill a quantity neither document states. */
  for (const l of stillOurs) {
    const k = code(l.itemCode);
    const want = qty4(l.qty);
    const cands = free(k);
    let sum = 0;
    const run = [];
    for (const b of cands) {
      const next = qty4(sum + qty4(b.qty));
      if (next > want) break;
      run.push(b); sum = next;
      if (sum === want) break;
    }
    if (sum !== want || run.length === 0) {
      unbilled.push({
        lineId: l.lineId, itemCode: k, qty: want,
        why: cands.length === 0
          ? `the book's purchase invoices bill no line of ${k} off this receipt`
          : `the book bills ${cands.map((b) => qty4(b.qty)).join(" + ")} of ${k} off this receipt `
            + `and no run of those adds up to our ${want}`,
      });
      continue;
    }
    for (const b of run) {
      taken.add(b.dtlKey);
      assigned.push({
        lineId: l.lineId, acInvoiceNo: b.docNo, book: b,
        how: `the book split this receipt line into ${run.length} invoice line(s); `
          + `${b.docNo} line ${b.dtlKey} is ${qty4(b.qty)} of our ${want}`,
      });
    }
  }

  /* What the book bills off this receipt that we do not hold. EXPECTED, not a
     defect: the cutover carried the outstanding part of a receipt and the
     book's invoice bills the whole of it. */
  const surplus = [];
  for (const list of byItem.values()) {
    for (const b of list) {
      if (taken.has(b.dtlKey)) continue;
      surplus.push({ docNo: b.docNo, dtlKey: b.dtlKey, itemKey: code(b.itemKey), qty: qty4(b.qty), amountSen: b.amountSen });
    }
  }
  return { assigned, unbilled, surplus };
}

/**
 * The discount that makes `qty x unitPrice` come out at the book's amount.
 *
 * The ERP stores a unit price, a discount and a line total; the book stores a
 * unit price and an amount, with any discount already inside the amount. The
 * amount is COPIED (that is the owner's rule) and the discount is whatever
 * reconciles the other two columns to it, so the row is self-consistent when a
 * human reads it.
 *
 * A NEGATIVE result is not written as a negative discount. It would mean the
 * book charged MORE than qty x unit — a surcharge, which this ERP has no column
 * for — so the discount stays 0, the book's amount still stands, and the caller
 * is told the row does not reconcile so it can be counted rather than hidden.
 */
export function discountForBookAmount({ qty, unitPriceSen, amountSen }) {
  const gross = Math.round(qty4(qty) * Math.round(unitPriceSen ?? 0));
  const discountSen = gross - Math.round(amountSen ?? 0);
  return discountSen >= 0
    ? { discountSen, reconciles: true }
    : { discountSen: 0, reconciles: false, surchargeSen: -discountSen };
}
