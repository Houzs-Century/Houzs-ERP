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
 * ── TWO ARMS, AND THE SECOND ONE IS AN OWNER RULING ────────────────────────
 *
 * ARM 1 — NOTHING IN THE NUMERIC COLUMNS. No ItemCode, no quantity, no price,
 * no amount. This is the original class and it is unchanged. A Desc2 does NOT
 * disqualify a row here: `HC-SO-000814` key 58981 is blank in every numeric
 * column and carries "LEG: FOLLOW DISPLAY" — a build instruction, which in this
 * ERP belongs on the sofa line's variants and not on a line of its own. It is a
 * note, not a line, and the ERP holding no row for it is the two systems
 * agreeing.
 *
 * ARM 2 — THE ROW STATES NOTHING AT ALL, EVEN THOUGH IT CARRIES A QUANTITY.
 * The owner, 2026-09-08, told that this repo's standing convention is never
 * delete only cancel, and ruling anyway:
 *
 *     「删掉啊 没写的也删掉
 *       简单来说都要跟Autocount一样啊 你不懂吗？」
 *
 * `HC-SO-011384` DtlKey 783795 is the row he was shown: no ItemCode, no
 * Description, no Desc2, no money — and QUANTITY 4. Until that ruling this file
 * kept it a finding, on the reasoning that the book was ordering four of
 * something it did not name. His ruling is that a row the book DESCRIBES
 * NOTHING IN is nothing, whatever number sits in the quantity column: there is
 * no product to create and no money involved, so the ERP holding no row for it
 * is the two systems agreeing, exactly as in arm 1.
 *
 * THE ARM IS DELIBERATELY NARROW and every clause of it earns its place. The
 * ruling covers the rows below and the class they belong to; it is NOT a
 * general licence to declare a row away.
 *
 *   hasCode false     AutoCount's own flag. A coded line is a product line and
 *                     is never in this class, whatever its numbers.
 *   itemKey blank     The exporter writes ItemCode, or the DESCRIPTION when
 *                     ItemCode is blank (export-ac-reconcile-truth.mjs:239).
 *                     So an empty `itemKey` on a code-less row is the proof
 *                     that the book states NEITHER a code NOR a description.
 *                     `HC-SO-000102`'s "DELIVERY FEE " reaches this file as its
 *                     description and is therefore never in arm 2.
 *   no Desc2          the build text. A row carrying one is a note the shop
 *                     wrote, so it is judged by arm 1 only — a note with a
 *                     quantity is still a finding.
 *   no money          in EITHER currency column: UnitPrice, the line SubTotal,
 *                     and the document-currency SubTotal. MONEY IS THE HARD
 *                     BOUNDARY of both arms and the ruling does not move it. A
 *                     row carrying money is money the customer is charged and
 *                     it stays a finding whatever else is blank —
 *                     `HC-SO-000102`'s "DELIVERY FEE " (RM 50.00) and
 *                     `HC-DO-001604`'s "* DISPOSE 3S L SHAPE SOFA + CONSOLE
 *                     TABLE" (RM 150.00) are both code-less and both stay.
 *
 * WHY DECLARE RATHER THAN DELETE. The rows are COUNTED and LISTED by the
 * reconcile, in their own column, exactly the way the sofa decomposition and the
 * book's own missing purchase prices are. A suppression the reader cannot see is
 * a suppression nobody re-checks, which is the failure this whole reconcile
 * exists to prevent.
 *
 * WHAT ARM 2 ABSORBS, measured over the whole 2026-09-08 08:03 cut — every
 * header and every line of all six types, not just the reconcile's population:
 * EIGHT rows, and they are named in
 * docs/bugs/0712-the-owner-ruled-a-row-the-book-describes-nothing-in-is-not.md.
 */

const zero = (v) => v === null || v === undefined || Number(v) === 0;
const blank = (v) => String(v ?? "").trim() === "";

/** A book line the ERP cannot hold and the book states nothing in.
 *
 *  `desc2Text` is the line's own build text — `book[t].desc2.get(l.dtlKey)` —
 *  and it is REQUIRED, not optional. Arm 2 turns on the row saying nothing at
 *  all, so a caller that simply did not look up the Desc2 must not be able to
 *  produce the same answer as one that looked and found none.
 *
 *  @param {{hasCode?: boolean, itemKey?: string, qty?: number|null, unitPriceSen?: number|null, subTotalSen?: number|null, docSubTotalSen?: number|null}} l
 *  @param {string|null|undefined} desc2Text
 *  @returns {boolean}
 */
export function isBlankBookRow(l, desc2Text) {
  if (arguments.length < 2) {
    throw new TypeError(
      "isBlankBookRow(line, desc2Text): the build text is required. Pass book[type].desc2.get(line.dtlKey) — " +
        "an omitted argument and a genuinely absent Desc2 must not be the same answer.",
    );
  }
  if (!l || l.hasCode) return false;
  /* MONEY IS THE HARD BOUNDARY of both arms. */
  if (!zero(l.unitPriceSen) || !zero(l.subTotalSen)) return false;
  /* ARM 1 — nothing in the numeric columns. Unchanged; reads no text. */
  if (zero(l.qty)) return true;
  /* ARM 2 — a quantity, and the book describes nothing at all (owner ruling,
     2026-09-08). The document-currency amount is checked here and not in arm 1
     because this arm is the wider one and must be the narrower test. */
  if (!zero(l.docSubTotalSen)) return false;
  return blank(l.itemKey) && blank(desc2Text);
}

/** Split a document's book lines into the ones that are comparable and the
 *  blank rows, which are declared. Order is preserved in both.
 *
 *  `desc2` is the type's own Desc2 map (`book[t].desc2`) and is REQUIRED for the
 *  same reason the argument above is. */
export function splitBlankBookRows(acLines, desc2) {
  if (!desc2 || typeof desc2.get !== "function") {
    throw new TypeError(
      "splitBlankBookRows(acLines, desc2): pass the type's Desc2 map (book[type].desc2). Without it a row " +
        "carrying a build text would be declared away as if it carried none.",
    );
  }
  const lines = [];
  const blankRows = [];
  for (const l of acLines) (isBlankBookRow(l, desc2.get(l.dtlKey)) ? blankRows : lines).push(l);
  return { lines, blank: blankRows };
}

/** Which arm declared the row — for the reconcile's own listing, so a reader can
 *  see WHY a row was declared without re-deriving the rule. */
export function blankRowArm(l, desc2Text) {
  if (!isBlankBookRow(l, desc2Text)) return null;
  return zero(l.qty) ? "no-quantity" : "states-nothing";
}
