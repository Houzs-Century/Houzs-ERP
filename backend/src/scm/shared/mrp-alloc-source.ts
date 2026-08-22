/* ----------------------------------------------------------------------------
   mrp-alloc-source — what is covering this demand: stock, a PO, or nothing.

   WHY THIS FILE EXISTS. The rule was three-way in the backend and two-way in
   the frontend, and the frontend's copy is the one the operator looks at.

     backend  routes/mrp.ts   need > 0 ? 'shortage' : poNumber != null ? 'po' : 'stock'
     frontend Mrp.tsx:307     shortageQty > 0 ? 'shortage' : 'po'

   The frontend synthesises the sofa-SET rows itself (the backend returns sets in
   a different shape from general lines), and in doing so it dropped the `stock`
   arm. So a sofa set with no shortage and no covering purchase order — a set
   sitting in the warehouse, already received — was labelled `po`. The chip then
   has no number to print and falls back to the word **"ordered"**.

   Goods in the warehouse, on a board that says they are still on order. Owner,
   2026-08-21: 「然后我不是收货了吗？为什么是show PO outstanding？还显示ordered？
   那么奇怪的」. Two separate defects wore that one sentence; this is the half
   that put the word on the screen.

   THE FALLBACK WAS THE TELL. `'ordered'` was never a state the system computes —
   it is what the chip prints when it has been told `source === 'po'` and cannot
   find a PO. A label that only appears when the data contradicts itself is a
   bug report the UI was writing to itself every time it rendered.

   One function, mirrored byte-identically into
   frontend/src/vendor/shared/mrp-alloc-source.ts, so the two cannot disagree
   again. check-shared-mirrors enforces that.
   -------------------------------------------------------------------------- */

/** What is covering a line or set of demand.
 *
 *  `stock`    on-hand units cover it
 *  `po`       an outstanding purchase order covers it, and NAMES itself
 *  `shortage` nothing covers it
 */
export type AllocSource = 'stock' | 'po' | 'shortage';

/**
 * The ONE rule. Order matters and each arm is load-bearing:
 *
 *  1. still uncovered -> `shortage`, whatever else is true;
 *  2. else a purchase order that NAMES ITSELF covers it -> `po`;
 *  3. else stock covered it.
 *
 * Arm 2 tests the NUMBER, not "was a PO involved". A covering PO the caller
 * cannot name is not evidence of an order — it is missing data, and calling it
 * `po` is what printed "ordered" over goods that had already arrived. When the
 * number is absent the honest answer is the one arm 3 gives.
 */
export function allocSourceOf(
  shortageQty: number | null | undefined,
  poNumber: string | null | undefined,
): AllocSource {
  if ((shortageQty ?? 0) > 0) return 'shortage';
  /* Trimmed: a PO number that is whitespace names nothing, and PostgREST
     hands back '' for a text column that was never filled. */
  if (typeof poNumber === 'string' && poNumber.trim() !== '') return 'po';
  return 'stock';
}

/**
 * The SAME three labels, answering a DIFFERENT question, and the difference is
 * deliberate — it is written down here because it was previously an unexplained
 * disagreement between two hand-written copies in one file.
 *
 *   allocSourceOf         "is this demand COVERED, and by what?"
 *                         A shortage wins, whatever else is true.
 *   allocSourceCoveringPo "is a purchase order INVOLVED in this line?"
 *                         A named PO wins, even when the line is still short.
 *
 * The second is what the purchase side asks (`SoLineCoverage` /
 * `PoCoverageAssignment` — "a PO's supply is currently covering this
 * outstanding Sales-Order line. Advisory only."). There, a partly-covering PO
 * is exactly the thing being reported, so collapsing it to `shortage` would
 * hide the answer.
 *
 * Both arms still test the NUMBER rather than "was a PO involved", for the
 * reason allocSourceOf gives: a PO that cannot name itself is missing data, not
 * an order.
 */
export function allocSourceCoveringPo(
  shortageQty: number | null | undefined,
  poNumber: string | null | undefined,
): AllocSource {
  if (typeof poNumber === 'string' && poNumber.trim() !== '') return 'po';
  return (shortageQty ?? 0) > 0 ? 'shortage' : 'stock';
}
