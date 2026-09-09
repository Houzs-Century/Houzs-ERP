/* The NAMED delivery-note lines topup-ac-lines-from-truth.mjs may add.
 *
 * Extracted from that script so a test can read it. The DO lane is a named
 * list rather than a rule (the reasoning is in that file's header), which means
 * every entry is a hand-written assertion about the account book — and a
 * hand-written assertion nothing checks is how a wrong DtlKey gets written onto
 * a live delivery note. `tests/doTopupTargets.test.mjs` resolves every entry
 * against the committed book snapshot and fails on any drift.
 *
 * NO SHEBANG, deliberately: a test imports this, and on Windows vitest inlines
 * the module and wraps it before `vm.runInThisContext`, so a `#!` no longer at
 * byte 0 is a SyntaxError that reports as a corrupt file with zero tests.
 */
export const DO_TARGETS = [
  {
    acDoc: "DO-001604",
    dtlKey: "199273",
    erpCode: "DISPOSE",
    group: "service",
    /* Asserted against the book before anything is written. A target whose
       book row has moved is REFUSED, never adjusted to fit. */
    expect: { hasCode: false, qty: 1, unitSen: 15000, subTotalSen: 15000 },
    why: "docs/cutover-so-do-remainder-2026-09-08.md section G — a text-only line carrying real money, explicitly NOT in the blank-row class of docs/bugs/0695",
  },
  /* ── THE FOUR LINES WHOSE CODE WAS CHANGED AFTER THE CONVERSION ───────────
   * `substituted: true` is the shape docs/modules/delivery-order.md declares for
   * a delivery line whose code the ordering document does not carry: the book's
   * code verbatim, `so_item_id` NULL, `item_group` / `variants` blank, and
   * `ac_substituted` true so both surfaces badge it. It is the SAME shape
   * lib/migrated-do-writer.mjs wrote for HC-DO-001800 and HC-DO-005583; those
   * two notes were CREATED by that writer because every line of them was a
   * substitution, while these two notes already existed, and
   * create-migrated-documents.mjs filters its plan by
   * `!done.has(d.doNo)` (lib/migrated-do-writer.mjs:293) — a document already in
   * the ERP is skipped whole, so the substitution ruling could never reach a
   * line INSIDE one. That is why these four rows are still missing and the two
   * sibling documents are complete.
   *
   * `description` is the book's own LineDesc, read from
   * data/ac-partial-dos.json.gz — the same cut migrated-do-writer.mjs read when
   * it wrote HC-DO-001800's two rows, so the four rows here read identically to
   * their siblings. It is a DECLARED literal because the reconcile snapshot
   * carries no LineDesc column; `expect` still asserts every value that decides
   * the write against the book itself.
   *
   * `so_item_id` stays NULL and that is the whole point: SO-003186 transferred
   * 4 of `NTYR-CS LTX PIL + CSC` and 4 of `AK- LTX CLS PIL`, and the note ships
   * 4 pillows and 4 covers. {4,4} answers {4,4} as a multiset and the book
   * cannot say which answers which — `FromDocDtlKey` is empty on all 48,772 DO
   * lines in this book. docs/bugs/0706 ruled on exactly that shape.
   */
  {
    acDoc: "DO-001953",
    dtlKey: "234488",
    erpCode: "HB109M-CC",
    group: null,
    substituted: true,
    description: "COOL SILK LATEX PILLOW COVER",
    expect: { hasCode: true, qty: 4, unitSen: 0, subTotalSen: 0 },
    why: "docs/bugs/0713 — the book's delivery note carries this code and SO-003186 does not; the ERP note was created before the 2026-09-07 substitution ruling and dropped it",
  },
  {
    acDoc: "DO-001953",
    dtlKey: "234490",
    erpCode: "HB109NL",
    group: null,
    substituted: true,
    description: "LATEX PILLOW",
    expect: { hasCode: true, qty: 4, unitSen: 0, subTotalSen: 0 },
    why: "docs/bugs/0713 — same document, the other dropped line",
  },
  {
    acDoc: "DO-004903",
    dtlKey: "465251",
    erpCode: "HB109NL",
    group: null,
    substituted: true,
    description: "LATEX PILLOW",
    expect: { hasCode: true, qty: 1, unitSen: 0, subTotalSen: 0 },
    why: "docs/bugs/0713 — the book's delivery note carries this code and SO-006438 does not",
  },
  {
    acDoc: "DO-004903",
    dtlKey: "465254",
    erpCode: "HB109M-CC",
    group: null,
    substituted: true,
    description: "COOL SILK LATEX PILLOW COVER",
    expect: { hasCode: true, qty: 1, unitSen: 0, subTotalSen: 0 },
    why: "docs/bugs/0713 — same document, the other dropped line",
  },
  /* ── THE TWO FREE LINES THE ALIGNMENT LANE FOUND, 2026-09-09 ──────────────
   * Both are RM 0.00 in the book, so neither moves a single sen: the delivery
   * note's header is already the book's total and stays there. Both parent
   * documents carry ZERO stock movements, re-measured by probe-doc-alignment
   * immediately before the apply — a free line onto a note that has shipped
   * would move an on-hand figure, and 「库存先不看」 forbids that.
   *
   * `description2` is now carried from the book's OWN Desc2 for the DtlKey
   * (`book.DO.desc2`) rather than left NULL — 「autocount怎么写我们就怎么写」.
   * That is a copy of the account book, not a value typed here.
   */
  {
    acDoc: "DO-011465",
    dtlKey: "924550",
    /* The ERP code, NOT the book's. The book names `HOK-SQUARE PILLOW`; this
       ERP drops the brand prefix on accessories, and
       data/autocount-erp-mapping-1561.csv states the pair on one row:
       `HOK-SQUARE PILLOW,SQUARE PILLOW,NEW,ACCESSORY,400-O002`. Declaring the
       book's code here would have been refused at plan time as "not in
       scm.mfg_products" — the four targets that came before happen to be codes
       AutoCount and the ERP spell identically, so this never came up. The test
       now resolves every coded target THROUGH that mapping rather than
       expecting the two spellings to match. */
    erpCode: "SQUARE PILLOW",
    group: null,
    /* NO `description` is declared, deliberately. The book's LineDesc for this
       line is in no cut this repo holds — `ac-partial-dos.json.gz` and
       `ac-fidelity-do-lines.json.gz` were both cut before this note existed
       (2026-09-04 against a fidelity export of 2026-08-11) — so the write falls
       back to the book's own ItemCode. That is the least-wrong COPY available
       and it is stated rather than dressed up; a LineDesc typed from memory
       would be an invention. Desc2 IS carried, from the book. */
    expect: { hasCode: true, qty: 4, unitSen: 0, subTotalSen: 0 },
    why: "the four compensation pillows the book gives away free — its Desc2 reads \"for conpesantion wrong item delivery.\" The ERP note holds only the sofa. 「一律跟账本」",
  },
  /* ── DO-010332 IS NOT IN THIS LIST, AND THAT IS THE FINDING ───────────────
   * It was, until probe-doc-alignment run 34328818076 read the live row:
   *
   *   HC-DO-010332  1 line
   *     item 8050-1S  qty 2 @ RM 3,250   ac_dtlkey 836939
   *     description2 "BO315-11 metal/75cm/1S"
   *
   * The book has TWO lines on that note — 836939, `2 x RM 3,250`, Desc2
   * ".../2S", and 836941, `1 @ RM 0.00`, Desc2 ".../1S". Our single row is
   * KEYED to the 2S line and carries the 1S line's build text — and its item
   * code, `8050-1S`, says 1S as well.
   *
   * So this is not a free-line insert. Adding 836941 on its own would leave the
   * note with TWO rows both claiming 1S, one of them priced at the 2S line's
   * money. The existing row has to become the 2S line FIRST, and that is a seat
   * size on a delivered document — 「never invent a seat size」, and a seat
   * change belongs to the sofa tooling, not to a line top-up that copies
   * quantities and prices.
   *
   * It stays OPEN, with the evidence, rather than half-written. See
   * docs/cutover-book-line-align-seven-2026-09-09.md.
   */
];
