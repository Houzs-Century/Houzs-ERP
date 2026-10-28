/* so-po-counter-cause — WHY a sales-order line's purchase counter disagrees
 * with the account book. The PURE classifier, and nothing else.
 *
 * ── THE QUESTION THIS ANSWERS, AND WHY IT IS NOT THE ONE ALREADY ASKED ─────
 * lib/transfer-counter-verdict.mjs says WHETHER `po_qty_picked` and
 * `SODTL.TransferedPOQty` disagree. It cannot say why, and on 2026-09-08 the
 * sales-order verdict carried 35 documents on that axis with no cause split at
 * all — which is exactly the shape that gets swept: a cause-mixed repair
 * overwrites the rows that were right.
 *
 * The two causes look identical in the counter and are opposite in what they
 * are owed:
 *
 *   A DEFECT   the ERP holds the purchase order, holds the line, and the line
 *              points at this sales-order line — so the app's OWN rule
 *              (recomputeSoPicked, src/scm/routes/mfg-purchase-orders.ts) would
 *              count it and the stored number is simply stale.
 *   A DECISION the app's own rule DROPS that purchase-order line on purpose —
 *              `from_mrp` lines are reference-only by the 2026-05-31 decision
 *              and a DRAFT purchase order must not close the From-SO picker
 *              before it commits. The counter reading 0 is the rule working.
 *
 * and between them sit the three that are neither: the ERP holds no such
 * purchase order, holds it but not that line, or holds the line pointing
 * somewhere else. Those are LINK questions, and repairing them is a different
 * job from recomputing a counter.
 *
 * ── IT CLASSIFIES THE CHILD, THEN THE GROUP ────────────────────────────────
 * The book states, per purchase-order line, which sales-order line it was
 * raised from (`PODTL.FromSODtlKey` — the ONE edge AutoCount records at line
 * grain; see lib/transfer-chain-verdict.mjs fact 1). So a sales-order line's
 * counter is owed by the SET of book purchase-order lines naming it, and the
 * cause is per child. `causeForGroup` folds them: if every child is one the
 * app's rule counts, the only thing left that can be wrong is the stored
 * number.
 *
 * PURE. No filesystem, no database, no clock, no printing.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** Every cause a single book purchase-order line can land on. */
export const CHILD_CAUSES = Object.freeze([
  /* the ERP holds no purchase order carrying that AutoCount number at all */
  "po_doc_absent",
  /* the ERP holds the purchase order and no line carrying that AutoCount line key */
  "po_line_absent",
  /* the line is there and points at NO sales-order line */
  "link_missing",
  /* the line is there and points at a DIFFERENT sales-order line */
  "link_elsewhere",
  /* the purchase order is DRAFT or CANCELLED — recomputeSoPicked drops both */
  "po_not_committed",
  /* the line is reference-only by the 2026-05-31 MRP decision — dropped too */
  "from_mrp",
  /* the app's own rule counts this line */
  "counted",
]);

/** Causes where the app's own counter rule DOES count the line. */
export const IS_COUNTED = Object.freeze(new Set(["counted"]));

/**
 * Causes that are the rule working as designed, not a defect. They are
 * reported in their own bucket and must never be summed into a defect count.
 */
export const IS_BY_DESIGN = Object.freeze(new Set(["po_not_committed", "from_mrp"]));

/** Causes where a LINK is missing or wrong — a different repair from a counter. */
export const IS_LINK_GAP = Object.freeze(new Set(["po_doc_absent", "po_line_absent", "link_missing", "link_elsewhere"]));

/* The statuses recomputeSoPicked excludes, stated once. A DRAFT purchase order
   must not drop its sales order off the From-SO picker before it commits, and a
   cancelled one bought nothing. */
export const UNCOUNTED_PO_STATUSES = Object.freeze(new Set(["DRAFT", "CANCELLED"]));

/**
 * Did we record exactly what the book moved, over a decomposition the book does
 * not have? Quantities are the scaled integers the counter lane already uses.
 *
 * ARITHMETIC, NOT A GUESS ABOUT FURNITURE. A group is only this shape when the
 * ERP counter EQUALS the book's transferred quantity and the ERP quantity is
 * exactly the book quantity times the row count. A partial, a different
 * quantity, or a single row is not this and falls through to the next cause.
 */
export function isDecomposedGrain(c) {
  if (!c) return false;
  const { rows, bookQty, bookTransfered, erpQty, erpCounter } = c;
  if (!(rows > 1)) return false;
  if (!(bookQty > 0) || !(erpQty > 0)) return false;
  if (erpCounter !== bookTransfered) return false;
  return erpQty === bookQty * rows;
}

const norm = (s) => String(s ?? "").trim().toUpperCase();
const key = (s) => String(s ?? "").trim();

/**
 * The cause for ONE book purchase-order line.
 *
 * c = {
 *   erpHasPoDoc,     does the ERP hold a purchase order with that AutoCount number
 *   erpHasPoLine,    does it hold a line with that AutoCount line key
 *   erpPoStatus,     that purchase order's status, or null
 *   erpFromMrp,      is the ERP line flagged from_mrp
 *   erpSoLineKey,    the AutoCount line key of the sales-order line it points at,
 *                    or null/"" when it points at nothing
 *   bookSoLineKey,   the sales-order line the BOOK says it was raised from
 * }
 */
export function causeForChild(c) {
  if (!c?.erpHasPoDoc) return "po_doc_absent";
  if (!c.erpHasPoLine) return "po_line_absent";

  const mine = key(c.erpSoLineKey);
  if (!mine) return "link_missing";
  if (mine !== key(c.bookSoLineKey)) return "link_elsewhere";

  /* The link is right. Now the two the app's own rule drops ON PURPOSE. The
     document's status is checked first because it is a fact about the whole
     purchase order, not about this line. */
  if (UNCOUNTED_PO_STATUSES.has(norm(c.erpPoStatus))) return "po_not_committed";
  if (c.erpFromMrp === true) return "from_mrp";

  return "counted";
}

/**
 * The cause for a sales-order line whose counter DISAGREES with the book.
 *
 * Only call this on a group already found to disagree — lib/
 * transfer-counter-verdict.mjs decides that, and this file must never be a
 * second opinion about whether two numbers are equal.
 *
 * @param {Array<object>} children the book purchase-order lines naming this line
 * @returns {{cause: string, children: string[]}}
 */
export function causeForGroup(children, counters = null) {
  const kids = Array.isArray(children) ? children : [];

  /* THE BOOK NAMES NO CHILD AT ALL. The book's own counter says a purchase was
     made and its own purchase-order table names no line that made it — a
     question for the book, not a defect of ours. Named rather than folded into
     one of the others, which would attribute it to the ERP. */
  if (!kids.length) return { cause: "book_names_no_child", children: [] };

  const causes = kids.map(causeForChild);

  /* THE BOOK'S OWN EDGE NAMES A SOURCE LINE FOR A DIFFERENT PRODUCT.
     Checked FIRST, because it is a fact about the BOOK and no repair of ours can
     settle it. Measured live 2026-09-08: PO-000290 line 61216 is an NB-KHJ57(K)
     bedframe whose FromSODtlKey names SO-000870 line 60700, which is a
     MYLATEX LUMBARIA (K) MATTRESS. Copying that edge would put a bedframe
     purchase on a customer's mattress line, and a key match is not an identity
     match - which is exactly what docs/bugs/0671 cost. */
  if (kids.some((k) => k && k.bookSourceProductDiffers === true)) {
    return { cause: "book_source_is_another_product", children: causes };
  }

  /* ONE BOOK LINE, SEVERAL ERP COMPARTMENT ROWS, AND WE RECORDED EXACTLY WHAT
     THE BOOK MOVED. The book buys one sofa; we hold one row per compartment, so
     the FRACTION cannot equal the book's however right the link is - our
     denominator is the compartment count. Recognised on the exact arithmetic,
     never on "it is a sofa". */
  if (isDecomposedGrain(counters) && causes.every((v) => IS_COUNTED.has(v))) {
    return { cause: "decomposed_grain", children: causes };
  }

  /* Every child is one the app's rule counts, so the links are all right and
     the only thing left that can be wrong is the stored number. */
  if (causes.every((v) => IS_COUNTED.has(v))) return { cause: "counter_stale", children: causes };

  /* One cause explains everything the rule did not count. */
  const uncounted = [...new Set(causes.filter((v) => !IS_COUNTED.has(v)))];
  if (uncounted.length === 1) return { cause: uncounted[0], children: causes };

  /* Two or more different causes on one sales-order line. Named, never
     collapsed onto whichever came first — a mixed group is precisely the one a
     single-cause sweep gets wrong. */
  return { cause: "mixed", children: causes };
}

/** Every cause `causeForGroup` can return. */
export const GROUP_CAUSES = Object.freeze([
  "counter_stale",
  "decomposed_grain",
  "book_source_is_another_product",
  ...CHILD_CAUSES.filter((v) => !IS_COUNTED.has(v)),
  "book_names_no_child",
  "mixed",
]);

/**
 * Group causes that are NOT a defect of ours. Reported in their own bucket,
 * with the reason, and never summed into a defect count.
 */
export const IS_NOT_OUR_DEFECT = Object.freeze(new Set([
  "decomposed_grain",
  "book_source_is_another_product",
  "book_names_no_child",
]));

/** Counts per cause, for a list of disagreeing groups. */
export function tallyCauses(groups) {
  const t = Object.fromEntries(GROUP_CAUSES.map((v) => [v, 0]));
  for (const g of groups) t[causeForGroup(g).cause] += 1;
  return t;
}

/* ── PLANTED CASES ──────────────────────────────────────────────────────────
 * Every one must land on its own cause and nothing else. The runner calls
 * `runSelfTest()` BEFORE it reads a row and REFUSES on a failure: a classifier
 * that cannot classify must not go on reporting confidently. */
export function selfTestCases() {
  const ok = {
    erpHasPoDoc: true, erpHasPoLine: true, erpPoStatus: "SENT",
    erpFromMrp: false, erpSoLineKey: "770342", bookSoLineKey: "770342",
  };
  return [
    { name: "everything lines up — the app's own rule counts this line",
      c: ok, want: "counted" },
    { name: "the ERP holds no such purchase order",
      c: { ...ok, erpHasPoDoc: false }, want: "po_doc_absent" },
    { name: "the ERP holds the purchase order but not that line",
      c: { ...ok, erpHasPoLine: false }, want: "po_line_absent" },
    { name: "the line points at nothing",
      c: { ...ok, erpSoLineKey: null }, want: "link_missing" },
    { name: "the line points at a DIFFERENT sales-order line",
      c: { ...ok, erpSoLineKey: "770343" }, want: "link_elsewhere" },
    { name: "a DRAFT purchase order — the rule drops it so the picker stays open",
      c: { ...ok, erpPoStatus: "DRAFT" }, want: "po_not_committed" },
    { name: "a CANCELLED purchase order bought nothing",
      c: { ...ok, erpPoStatus: "CANCELLED" }, want: "po_not_committed" },
    { name: "an MRP-origin line is reference-only by the 2026-05-31 decision",
      c: { ...ok, erpFromMrp: true }, want: "from_mrp" },
    /* THE NON-DEFECTS. Whitespace and case on a status, and a line key that
       arrives as a number rather than a string, are not causes. */
    { name: "a lower-case status is the same status",
      c: { ...ok, erpPoStatus: "draft" }, want: "po_not_committed" },
    { name: "a line key that arrives as a number still matches its string twin",
      c: { ...ok, erpSoLineKey: 770342, bookSoLineKey: "770342" }, want: "counted" },
    /* A wrong LINK outranks a status the rule would have dropped anyway: the
       link is what somebody has to repair, and reporting it as "draft" would
       send them to the wrong screen. */
    { name: "a wrong link on a DRAFT order is reported as the wrong link",
      c: { ...ok, erpPoStatus: "DRAFT", erpSoLineKey: "999999" }, want: "link_elsewhere" },
  ];
}

export function groupSelfTestCases() {
  const counted = {
    erpHasPoDoc: true, erpHasPoLine: true, erpPoStatus: "SENT",
    erpFromMrp: false, erpSoLineKey: "770342", bookSoLineKey: "770342",
  };
  return [
    { name: "every child counted, and the number still disagrees — the counter is stale",
      kids: [counted], want: "counter_stale" },
    { name: "two children, both counted",
      kids: [counted, { ...counted }], want: "counter_stale" },
    { name: "the one child is MRP-origin — the rule dropping it is the rule working",
      kids: [{ ...counted, erpFromMrp: true }], want: "from_mrp" },
    { name: "one counted child and one unlinked child is ONE cause: the missing link",
      kids: [counted, { ...counted, erpSoLineKey: null }], want: "link_missing" },
    { name: "an MRP line AND a missing link on one sales-order line is MIXED, never one of them",
      kids: [{ ...counted, erpFromMrp: true }, { ...counted, erpSoLineKey: null }], want: "mixed" },
    { name: "the book's counter moved and its own purchase-order table names no child",
      kids: [], want: "book_names_no_child" },
    /* MEASURED SHAPES, both live on production 2026-09-08. */
    { name: "one book sofa, three ERP compartments, and we moved exactly what the book moved",
      kids: [counted],
      counters: { rows: 3, bookQty: 10000, bookTransfered: 10000, erpQty: 30000, erpCounter: 10000 },
      want: "decomposed_grain" },
    { name: "a decomposition where we moved LESS than the book is NOT excused as grain",
      kids: [counted],
      counters: { rows: 3, bookQty: 10000, bookTransfered: 10000, erpQty: 30000, erpCounter: 0 },
      want: "counter_stale" },
    { name: "a single row is never decomposition grain, whatever the numbers",
      kids: [counted],
      counters: { rows: 1, bookQty: 10000, bookTransfered: 10000, erpQty: 10000, erpCounter: 10000 },
      want: "counter_stale" },
    { name: "the BOOK's own edge names a source line for a different product",
      kids: [{ ...counted, bookSourceProductDiffers: true }],
      counters: { rows: 1, bookQty: 20000, bookTransfered: 10000, erpQty: 20000, erpCounter: 0 },
      want: "book_source_is_another_product" },
    { name: "the book's wrong product outranks a decomposition that would have excused it",
      kids: [{ ...counted, bookSourceProductDiffers: true }],
      counters: { rows: 3, bookQty: 10000, bookTransfered: 10000, erpQty: 30000, erpCounter: 10000 },
      want: "book_source_is_another_product" },
  ];
}

export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = causeForChild(c.c);
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  for (const c of groupSelfTestCases()) {
    const got = causeForGroup(c.kids, c.counters ?? null).cause;
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  /* The three sets must not overlap: a cause that was both by-design and a link
     gap would be counted in two columns of the same report. */
  for (const v of CHILD_CAUSES) {
    const n = [IS_COUNTED, IS_BY_DESIGN, IS_LINK_GAP].filter((s) => s.has(v)).length;
    if (n > 1) failures.push(`${v} belongs to ${n} cause classes`);
  }
  for (const v of [...IS_COUNTED, ...IS_BY_DESIGN, ...IS_LINK_GAP]) {
    if (!CHILD_CAUSES.includes(v)) failures.push(`${v} is classified but is not a declared cause`);
  }
  for (const v of IS_NOT_OUR_DEFECT) {
    if (!GROUP_CAUSES.includes(v)) failures.push(`${v} is excluded from work but is not a declared group cause`);
  }
  return failures;
}
