/* ac-blank-book-row — AutoCount's own EMPTY ROWS, which are not lines.
 *
 * NO SHEBANG — this module is imported by a test (CLAUDE.md: on Windows vitest
 * inlines the source, and a `#!` off byte 0 is a SyntaxError at LOAD).
 *
 * WHAT THIS IS FOR. AutoCount lets a salesperson leave a row on a document with
 * nothing in it: no ItemCode, no quantity, no price, no amount. The ERP cannot
 * hold such a row — `scm.mfg_sales_order_items.item_code` needs a product, and
 * `import-ac-outstanding-so.mjs` has no product to point at — so the migration
 * correctly carries nothing for it. The reconcile then compared 6 book rows
 * against 5 ERP rows and reported a MISSING LINE.
 *
 * Measured on the 2026-09-08 08:03 (Malaysia) cut, run `34186980493`: eleven
 * such rows across six sales orders were on the go-live reconcile's line-count
 * list, and on two more (`HC-SO-000102`, `HC-SO-001473`) the document's MONEY
 * ties out to the sen while the count does not — which is the signature of a
 * row that carries nothing.
 *
 *     BOOK seq=80 key=98858 "" code=N qty=0 unit=RM 0.00 sub=RM 0.00
 *         -> NO ERP ROW CLAIMS THIS KEY
 *
 * THE TEST IS DELIBERATELY NARROW, and every clause of it earns its place:
 *
 *   hasCode false   AutoCount's own flag. A coded line is a product line and is
 *                   never in this class, whatever its numbers.
 *   qty 0/absent    `HC-SO-011384` carries a row with NO item code and
 *                   QUANTITY 4. The book is ordering four of something it does
 *                   not name; that is a real gap and it stays a finding.
 *   price 0/absent  ) `HC-SO-000102`'s "DELIVERY FEE " and `HC-DO-001604`'s
 *   amount 0/absent ) "* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE" carry no item
 *                   code and REAL MONEY (RM 50.00 and RM 150.00). Money in a
 *                   row is money the customer is charged, and it stays a
 *                   finding.
 *
 * A Desc2 does NOT disqualify a row. `HC-SO-000814` key 58981 is blank in every
 * numeric column and carries "LEG: FOLLOW DISPLAY" — a build instruction, which
 * in this ERP belongs on the sofa line's variants and not on a line of its own.
 * It is a note, not a line, and the ERP holding no row for it is the two systems
 * agreeing.
 *
 * WHY DECLARE RATHER THAN DELETE. The rows are COUNTED and LISTED by the
 * reconcile, in their own column, exactly the way the sofa decomposition and the
 * book's own missing purchase prices are. A suppression the reader cannot see is
 * a suppression nobody re-checks, which is the failure this whole reconcile
 * exists to prevent.
 */

/** A book line the ERP cannot hold and the book states nothing in.
 *  @param {{hasCode?: boolean, qty?: number|null, unitPriceSen?: number|null, subTotalSen?: number|null}} l
 *  @returns {boolean}
 */
export function isBlankBookRow(l) {
  if (!l || l.hasCode) return false;
  const zero = (v) => v === null || v === undefined || Number(v) === 0;
  return zero(l.qty) && zero(l.unitPriceSen) && zero(l.subTotalSen);
}

/** Split a document's book lines into the ones that are comparable and the
 *  blank rows, which are declared. Order is preserved in both. */
export function splitBlankBookRows(acLines) {
  const lines = [];
  const blank = [];
  for (const l of acLines) (isBlankBookRow(l) ? blank : lines).push(l);
  return { lines, blank };
}
