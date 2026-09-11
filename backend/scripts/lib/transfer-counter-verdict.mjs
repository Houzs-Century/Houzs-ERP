/* transfer-counter-verdict — the PURE classifier behind check-ac-transfer-counters.
 *
 * Lives in lib/ so the self-test exercises the same function the check calls.
 * A self-test against a copy proves nothing; this repo has paid for one of
 * those already (docs/bugs/0700, the guard that counted the whole table).
 *
 * THE ONE THING THAT MAKES THIS HARDER THAN A SUBTRACTION: one AutoCount line
 * can be carried by SEVERAL ERP rows. A sofa is one DtlKey in the book and six
 * compartment rows in the ERP (mig 0273/0280), so summing the ERP's counter
 * across those rows and comparing it to the book's number reports the
 * decomposition as a defect. The comparison that survives decomposition is the
 * FRACTION transferred: the book moved t of q, the ERP moved T of Q, and
 * t/q === T/Q is the same fact in both systems whatever Q is.
 *
 * Compared as cross-multiplied integers. t/q === T/Q  <=>  t*Q === T*q, which
 * needs no division and therefore cannot round. Quantities arrive already
 * scaled by 10000 (decimal(19,4)), so the products fit comfortably in a double
 * for any quantity this business will ever hold.
 */

export const VERDICTS = [
  "agree",
  "erp_low",
  "erp_high",
  "erp_asserts_untransferred",
  "book_qty_zero",
  "erp_qty_zero",
];

/* group = { bookQty, bookTransfered, erpQty, erpCounter, rows }
 * All four quantities are integers scaled by 10000. */
export function verdictFor(g) {
  const { bookQty, bookTransfered, erpQty, erpCounter } = g;

  /* A zero denominator on either side cannot express a fraction. Say so rather
     than dividing by it or quietly calling it agreement. */
  if (bookQty === 0) return "book_qty_zero";
  if (erpQty === 0) return "erp_qty_zero";

  /* The BACKWARD direction on this axis, and the one that matters most: the ERP
     records a transfer the book does not have at all. Named separately from
     erp_high because "the book says none and we say some" is an INVENTED
     transfer, while erp_high is a disagreement about how much. */
  if (bookTransfered === 0 && erpCounter > 0) return "erp_asserts_untransferred";

  const left = bookTransfered * erpQty;
  const right = erpCounter * bookQty;
  if (left === right) return "agree";
  return left > right ? "erp_low" : "erp_high";
}

/* The strongest evidence is a 1:1 group, where the two numbers are directly
   comparable with no fraction at all. Reported separately so a reader can see
   how much of the verdict rests on the decomposition-safe comparison. */
export const isOneToOne = (g) => g.rows === 1;

export function tally(groups) {
  const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const g of groups) t[verdictFor(g)]++;
  return t;
}

/* Planted cases. Every one must land on its own verdict and nothing else. */
export function selfTestCases() {
  return [
    { name: "1:1 both fully transferred",
      g: { bookQty: 10000, bookTransfered: 10000, erpQty: 10000, erpCounter: 10000, rows: 1 },
      want: "agree" },
    { name: "1:1 neither transferred",
      g: { bookQty: 10000, bookTransfered: 0, erpQty: 10000, erpCounter: 0, rows: 1 },
      want: "agree" },
    { name: "sofa: one book line of 1, six ERP rows of 1, all received both sides",
      g: { bookQty: 10000, bookTransfered: 10000, erpQty: 60000, erpCounter: 60000, rows: 6 },
      want: "agree" },
    { name: "sofa: book received the whole line, the ERP only half its rows",
      g: { bookQty: 10000, bookTransfered: 10000, erpQty: 60000, erpCounter: 30000, rows: 6 },
      want: "erp_low" },
    { name: "book received 5 of 10, ERP records 2 of 10",
      g: { bookQty: 100000, bookTransfered: 50000, erpQty: 100000, erpCounter: 20000, rows: 1 },
      want: "erp_low" },
    { name: "book received 2 of 10, ERP records 5 of 10",
      g: { bookQty: 100000, bookTransfered: 20000, erpQty: 100000, erpCounter: 50000, rows: 1 },
      want: "erp_high" },
    { name: "the book moved nothing and the ERP claims a transfer",
      g: { bookQty: 10000, bookTransfered: 0, erpQty: 10000, erpCounter: 10000, rows: 1 },
      want: "erp_asserts_untransferred" },
    { name: "a book line of quantity zero cannot express a fraction",
      g: { bookQty: 0, bookTransfered: 0, erpQty: 10000, erpCounter: 0, rows: 1 },
      want: "book_qty_zero" },
    { name: "an ERP group of quantity zero cannot either",
      g: { bookQty: 10000, bookTransfered: 10000, erpQty: 0, erpCounter: 0, rows: 1 },
      want: "erp_qty_zero" },
    /* THE NON-DEFECT. A partial transfer that agrees exactly across a
       decomposition must NOT be reported: 1 of 2 in the book is 3 of 6 here. */
    { name: "partial, decomposed, and exactly equal - must be silent",
      g: { bookQty: 20000, bookTransfered: 10000, erpQty: 60000, erpCounter: 30000, rows: 3 },
      want: "agree" },
  ];
}

export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = verdictFor(c.g);
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  return failures;
}
