/* so-tally-verdict — ONE artifact that answers 「所以SO 都tally了吗?」
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * The owner has asked the same question three times in three ways:
 *
 *     「所以SO 都tally了吗?」
 *     「确保全部SO 都是准确的」
 *     「处理完了我要知道是不是全部SO 都tally了内容包裹SKU?包裹sofa compartment?」
 *
 * He asked again because no single artifact answered it. The answer had to be
 * assembled by hand from three places in one 1,300-line reconcile log — the
 * per-type SUMMARY table, the variants-inside-the-line table, and the unread
 * cross-tab — and each assembly is a fresh chance to quote the wrong column.
 * On 2026-09-08 the SAME corpus was reported truthfully as "0 differ" (the
 * SUMMARY row, whose axes were all zero) and as "8 differ" (the compartment
 * axis, proceeded arm) within the same day, and the per-document verdict said
 * "149 still differ". Three true sentences about three different axes, and not
 * one of them was an answer.
 *
 * ── IT MEASURES NOTHING ─────────────────────────────────────────────────────
 * Every number here comes out of check-ac-erp-reconcile.mjs's own verdict file.
 * This module CLASSIFIES rows that file already decided; it never compares a
 * book value to an ERP value, and it must never learn how. A second
 * implementation of "different" is the failure this repo has paid for three
 * times — most recently two copies of the sofa pairing rule answering
 * oppositely about HC-PO-010040 twenty minutes apart (docs/bugs/0708).
 *
 * ── THE FOUR ANSWERS, AND WHY THE THIRD ONE MUST EXIST ──────────────────────
 * A sofa whose pieces the book's own text does not state is NEITHER agreeing
 * NOR differing. Rolling it into either is how the number came out wrong in
 * both directions on the same day: fold it into DIFFER and 110 documents look
 * like a backlog nobody owes; fold it into IDENTICAL and 110 documents are
 * called checked when nothing checked them. It gets its own column, always, and
 * `bucketOf` cannot put a row in two.
 *
 *   identical      compared on every axis, and every axis agreed.
 *   work           at least one axis where both sides state something and the
 *                  two things are different — or the document is absent, or the
 *                  ERP claims one the book does not have. Somebody owes this.
 *   unanswerable   the ONLY findings are axes the checker refused to answer.
 *                  Not work: the owner's drawing decides these, or a line key
 *                  has to be stamped first. `UNANSWERABLE_AXES` in
 *                  lib/so-verdict-derive.mjs is the list, and it is asserted
 *                  there to be a subset of the LOCKING axes so nothing here can
 *                  open a document the comparison never reached.
 *   book-gap       nothing differs and nothing is unanswerable, but the ERP
 *                  carries a value the BOOK never stated. Already accepted as
 *                  一模一样 — an operator filled in a field the book never had,
 *                  which is allowed. Counted apart from `identical` so the
 *                  owner can see the size of it rather than take it on trust.
 *
 * PRECEDENCE IS DELIBERATE and is work > unanswerable > book-gap > identical.
 * A document with a real difference AND an unreadable sofa is work: the work is
 * owed whatever the sofa turns out to be. A document that is unanswerable AND
 * book-blank is unanswerable: an unfinished comparison outranks a declaration.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * `isTallied` is the ONLY place the word TALLIED is decided, so no summary can
 * soften it and no reader has to. It is zero WORK — not "few", not "only
 * declared ones left". Unanswerable documents do not block it, on purpose: they
 * are the owner's to adjudicate from the drawing, and they are printed on their
 * own line right beside the verdict so nobody can read TALLIED as "everything
 * was compared".
 *
 * PURE: a verdict payload in, counts and printable lines out. No filesystem, no
 * database, no printing, no clock. The caller owns the I/O.
 *
 * NO SHEBANG: tests/soTallyVerdict.test.mjs imports this module (see
 * lib/ac-mapping-csv.mjs for the Windows vitest reason).
 */
import { LOCKING_AXES, UNANSWERABLE_AXES } from "./so-verdict-derive.mjs";
import { UNREAD_LABEL, MECHANICAL } from "./sofa-unread-split.mjs";

const UNANSWERABLE = new Set(UNANSWERABLE_AXES);

export const BUCKETS = Object.freeze(["identical", "work", "unanswerable", "book-gap"]);

/* ── THE OWNER'S VOCABULARY ──────────────────────────────────────────────────
 * Every locking axis belongs to exactly ONE group, and the group carries the
 * words he used. The reconcile's axis names are the engineering ones; a report
 * that prints them is a report he has to translate, and 「包裹SKU?包裹sofa
 * compartment?」 is him asking whether two specific things were covered.
 *
 * `key` is stable (used by tests and by the workflow's grep-able output);
 * `label` is what he reads. The completeness assertion below is the whole point
 * of the table: a NEW locking axis added by a later lane cannot quietly fail to
 * appear in this report — the module refuses to load. */
export const AXIS_GROUPS = Object.freeze([
  {
    key: "document",
    label: "the document itself — is it in both places",
    axes: [],
  },
  {
    key: "lines",
    label: "the lines — how many, and every book line present",
    axes: ["line count", "a book line we do not have", "a line key on the wrong document", "lines could not be matched"],
  },
  { key: "item-code", label: "the SKU / item code", axes: ["item code"] },
  { key: "quantity", label: "quantity", axes: ["quantity"] },
  { key: "price", label: "unit price and the document total", axes: ["unit price", "document total", "currency"] },
  { key: "colour", label: "colour / fabric", axes: ["colour / fabric"] },
  { key: "seat-size", label: "seat size", axes: ["seat size"] },
  { key: "specials", label: "specials", axes: ["specials"] },
  { key: "sofa-compartments", label: "sofa compartments", axes: ["sofa compartments", "sofa build not verifiable"] },
  {
    /* 「transfer from和transfer to」 — the owner, 2026-09-08. Which document a
       line was raised FROM, and how much of it has been transferred ON. */
    key: "transfer-chain",
    label: "单据转换链 — which document the line came FROM, and how much has gone ON",
    axes: ["transfer from", "transfer to", "transfer chain not verifiable"],
  },
  {
    key: "bedframe-build",
    label: "bedframe build (divan / gap / leg / total height)",
    axes: ["divan height", "gap", "leg height", "T.Heights"],
  },
]);

/* ── ONE DOCUMENT TYPE'S VOCABULARY, STATED ONCE ────────────────────────────
 * 2026-09-08, the owner: 「然后把PO GR也tally掉」 — do for purchase orders and
 * goods receipts what was just done for sales orders.
 *
 * The BUCKETING above is type-independent and stays that way: `bucketOf` and
 * `isTallied` never learn what a purchase order is. What genuinely differs
 * between the types is only WORDS and one GRAIN note, so that is all this table
 * holds. Adding a fourth type must not be able to change what TALLIED means.
 *
 * WHY THE LABELS HAVE TO MOVE AT ALL. Two of them would be lies if they did
 * not:
 *   - a goods receipt's `quantity` is the quantity RECEIVED, not ordered, and
 *     the owner reads those as different questions;
 *   - a goods receipt's unit price is DECLARED — grn_items.unit_price_sen is
 *     copied from the purchase-order line by design, never from GRDTL.UnitPrice
 *     (lib/ac-reconcile-erp-sql.mjs, `priceDeclared`). Printing "unit price"
 *     as a checked axis for GR would report our own derivation as agreement.
 *
 * `scope` is a function of the verdict because each type's population rule is
 * its own: the sales orders are scoped by the DO rule, the purchase orders and
 * the goods receipts by the outstanding rule in lib/ac-scope.mjs.
 */
export const DOC_TYPES = Object.freeze({
  SO: {
    key: "SO",
    heading: "全部 SALES ORDER 对账结论 — SALES ORDERS vs THE ACCOUNT BOOK",
    plural: "sales orders",
    headline: "SALES ORDERS",
    grain: null,
    scope: (v, num) =>
      `${num(v.documents.book)} sales orders in the account book; ${num(v.documents.scope)} are OUTSTANDING and ` +
      `expected in the ERP (the owner's DO rule — a fully delivered order is correctly absent); ` +
      `${num(v.documents.outOfScopeAbsent)} are out of scope and absent, which is that rule working.`,
    labels: {},
    tallied:
      "agree with the account book on the document, the lines, the SKU, the quantity, the price, the total and " +
      "every variant inside the line.",
  },
  PO: {
    key: "PO",
    heading: "全部 PURCHASE ORDER 对账结论 — PURCHASE ORDERS vs THE ACCOUNT BOOK",
    plural: "purchase orders",
    headline: "PURCHASE ORDERS",
    grain: null,
    scope: (v, num) =>
      `${num(v.documents.book)} purchase orders in the account book; ${num(v.documents.scope)} are OUTSTANDING and ` +
      `expected in the ERP; ${num(v.documents.outOfScopeAbsent)} are out of scope and absent, which is that rule ` +
      "working.",
    /* CURRENCY IS NAMED IN THE PRICE LABEL, and that is not decoration. A
       foreign purchase order is where the book and the ERP can hold the same
       NUMBER and still disagree, and reading the local-currency total as the
       document's once wrote RM 13,068.55 of imaginary discount onto a CNY order
       (docs/bugs/0665). The axis locks; the SUMMARY's `non-MYR` column does not
       count it as a gap, which is exactly why it has to be visible here. */
    labels: { price: "unit price, the document total, and the CURRENCY" },
    tallied:
      "agree with the account book on the document, the lines, the SKU, the quantity, the price, the total, the " +
      "currency and every variant inside the line.",
  },
  GR: {
    key: "GR",
    heading: "全部 GOODS RECEIPT 对账结论 — GOODS RECEIPTS vs THE ACCOUNT BOOK",
    plural: "goods receipts",
    headline: "GOODS RECEIPTS",
    /* THE GRAIN NOTE IS NOT OPTIONAL. One "document" here is a
       (AutoCount receipt × purchase order) PAIR: an ERP goods receipt belongs to
       ONE purchase order while an AutoCount receipt can span several, and 51 of
       the 214 in-scope receipts do. A reader who takes the population as
       "receipts" reads a right number as the wrong fact. */
    grain:
      'GRAIN: one "document" below is a (AutoCount receipt × purchase order) PAIR, written `GR-nnn|PO-nnn`. An ERP ' +
      "goods receipt belongs to ONE purchase order while an AutoCount receipt can span several, so the pair is the " +
      "finest grain BOTH sides can state. Counting receipts instead would report every multi-order receipt as short " +
      "by the part of it raised against another order.",
    scope: (v, num) =>
      `${num(v.documents.book)} receipt×order pairs in the account book; ${num(v.documents.scope)} are in the ` +
      `expected ERP population; ${num(v.documents.outOfScopeAbsent)} are out of scope and absent, which is that ` +
      "rule working.",
    labels: {
      quantity: "quantity RECEIVED",
      price: "the money the book states (document total)",
    },
    tallied:
      "agree with the account book on the document, the lines, the SKU, the quantity received and the money the " +
      "book states.",
  },
  /* ── THE THREE THE OWNER NAMED ON 2026-09-08 ───────────────────────────────
   * 「SO PO GR PI SI DO 等等？都解决了吗？」 — six types, and only three had a
   * spec, so `docTypeSpec` THREW for the other three and no report could be
   * asked for them. The reconcile has always compared all six and the recorder
   * has always been keyed by type; what was missing was the words.
   *
   * The BUCKETING is untouched and stays that way: `bucketOf` and `isTallied`
   * do not learn what a delivery order is, and adding these three cannot change
   * what TALLIED means. Only labels and one scope sentence differ.
   *
   * Two of the labels would be LIES if they did not move, and that is the whole
   * reason the table exists rather than a default:
   *   - a delivery order's item code is taken from the SALES ORDER line by
   *     design, never from DODTL.ItemCode (lib/ac-reconcile-erp-sql.mjs,
   *     `itemCodeDeclared`), and a migrated delivery carries no money at all;
   *   - a purchase invoice's and a sales invoice's LINES come from OUR receipt
   *     or delivery, not from the book's PIDTL / IVDTL (`migratedChainLineShape`
   *     on both), so the line SHAPE is ours and the money is what must agree.
   * Printing "unit price" as a checked axis for any of the three would report
   * our own derivation back as agreement. */
  DO: {
    key: "DO",
    heading: "全部 DELIVERY ORDER 对账结论 — DELIVERY ORDERS vs THE ACCOUNT BOOK",
    plural: "delivery orders",
    headline: "DELIVERY ORDERS",
    grain: null,
    scope: (v, num) =>
      `${num(v.documents.book)} delivery orders in the account book; ${num(v.documents.scope)} are raised against ` +
      `an OUTSTANDING sales order and expected in the ERP; ${num(v.documents.outOfScopeAbsent)} are out of scope ` +
      "and absent, which is that rule working. The owner declined importing the delivery HISTORY — 11,443 " +
      "documents — and that decision is what keeps this population small.",
    labels: {
      "item-code": "the SKU (taken from the sales-order line by design, so this is our own copy)",
      price: "the money the book states (document total)",
    },
    tallied:
      "agree with the account book on the document, the lines, the quantity delivered, and which sales order each " +
      "line was delivered against.",
  },
  IV: {
    key: "IV",
    heading: "全部 SALES INVOICE 对账结论 — SALES INVOICES vs THE ACCOUNT BOOK",
    plural: "sales invoices",
    headline: "SALES INVOICES",
    grain: null,
    scope: (v, num) =>
      `${num(v.documents.book)} sales invoices in the account book; ${num(v.documents.scope)} belong to a sales ` +
      `order or delivery order the ERP holds — the owner's own ruling 「没有的 SO DO 何来发票？有的 SO DO 自然要发票」 ` +
      `— and ${num(v.documents.outOfScopeAbsent)} are out of scope and absent, which is that rule working.`,
    labels: {
      lines: "the lines (built from OUR delivery order, so the number of rows is ours and the money is what must agree)",
      price: "the money the book states (document total)",
    },
    tallied:
      "agree with the account book on the document, the money, and which delivery order or sales order each line " +
      "was invoiced against.",
  },
  PI: {
    key: "PI",
    heading: "全部 PURCHASE INVOICE 对账结论 — PURCHASE INVOICES vs THE ACCOUNT BOOK",
    plural: "purchase invoices",
    headline: "PURCHASE INVOICES",
    grain: null,
    scope: (v, num) =>
      `${num(v.documents.book)} purchase invoices in the account book; ${num(v.documents.scope)} belong to a ` +
      `goods receipt or purchase order the ERP holds; ${num(v.documents.outOfScopeAbsent)} are out of scope and ` +
      "absent, which is that rule working.",
    labels: {
      lines: "the lines (built from OUR goods receipt, so the number of rows is ours and the money is what must agree)",
      price: "the money the book states (document total)",
    },
    tallied:
      "agree with the account book on the document, the money, and which goods receipt or purchase order each " +
      "line was invoiced against.",
  },
});

/** The spec for a type, or a refusal. A typo must not silently render as SO. */
export function docTypeSpec(type) {
  const spec = DOC_TYPES[String(type || "SO").toUpperCase()];
  if (!spec) throw new Error(`no DOC_TYPES spec for document type "${type}" — add one before reporting on it`);
  return spec;
}

const GROUP_OF = new Map();
for (const g of AXIS_GROUPS) {
  for (const a of g.axes) {
    if (GROUP_OF.has(a)) throw new Error(`axis "${a}" is in two AXIS_GROUPS: ${GROUP_OF.get(a)} and ${g.key}`);
    GROUP_OF.set(a, g.key);
  }
}
for (const a of LOCKING_AXES) {
  /* A locking axis with no group would be a difference the owner's report never
     prints while the lock still shuts documents for it — the exact shape of
     "assembled by hand, and a column got missed" this file exists to end. */
  if (!GROUP_OF.has(a)) throw new Error(`locking axis "${a}" belongs to no AXIS_GROUP — add it to one`);
}

/** The declared classes, in the owner's words, with WHO declared each. */
export const DECLARED_LABEL = Object.freeze({
  "book-blank": "the ERP states a value the BOOK never did — an operator filled it in, which is allowed",
  pending: "the book itself says TBC / KIV, so there is nothing to copy yet",
  /* The jsonb key this is carried under is deliberately NOT spelled here: a
     tree scan in backend/tests asserts that only display surfaces name it, and a
     mention would have to become an exception in that scan. A check with an
     exception in it is the shape this repo keeps paying for.
     lib/variant-reconcile.mjs owns the verdict and names the key. */
  recorded:
    "the book asks for a PRICED special the line does not tick, and the line already carries it as recorded — " +
    "your 2026-09-03 ruling 甲: the factory sees the option and the document's money did not move",
  "no-line-key":
    "our rows carry no AutoCount line number, so which of ours answers which of the book's was the checker's guess — " +
    "and both sides state the SAME set of values, which no ordering can fake",
  "erp-blank-not-proceeded":
    "the ERP is blank on an order NOBODY HAS PROCEEDED — your rule 还没proceed还没确认的就可以直接放空的",
  "sofa-decomposition": "one book line is one ERP line PER COMPARTMENT, so line count and per-line price are not comparable",
  "blank-book-row": "AutoCount's own EMPTY row — no item code, no quantity, no money for the ERP to hold",
  "erp-zero-money":
    "a MIGRATED goods receipt carrying RM 0.00 — your decision 2026-09-08 「GR 0 没关系」. PROVED per document " +
    "(migrated paperwork, zero inventory movements), never assumed; the ones that could NOT be proved are still " +
    "counted as differences",
  "chain-line-not-in-book":
    "the account book itself does not record WHICH LINE a delivery / invoice / receipt was raised from — only " +
    "which DOCUMENT. Our link names the same document the book does; there is no finer answer in the book to " +
    "check against, and none is claimed",
  "chain-no-source":
    "the book raised this line from nothing at all — it is the head of a chain, typed from scratch",
  "chain-no-erp-counter":
    "this edge has no stored ceiling in the ERP: how much has gone on is worked out from the child documents " +
    "every time it is asked, so there is no saved number that can drift out of step",
  "chain-onward-not-migrated":
    "the account book has moved this line ON to a document type the cutover deliberately did NOT bring over — " +
    "the book holds 5,283 purchase invoices and we hold 55, and only receipts against OUTSTANDING orders were " +
    "imported. So we record 0 transferred: not a wrong number, an ABSENT one, and your decision rather than a " +
    "defect. PROVED per document (every onward document the book raised off this one is absent from ours); a " +
    "line whose onward document we DO hold is still counted as a difference",
  "owner-model-override":
    "the ERP names a different product from the account book because YOU decided it — 「那就放8030 daybed把」. " +
    "The decision is written down with the book's own model beside it, so if the book ever stops saying that, " +
    "this goes straight back to being a difference without anybody editing anything",
});

/* The note classes that are NOT printed in "WHAT THIS VERDICT EXCLUDED": they
 * have a section of their own. Named ONCE, here, because the divert below and
 * the test that every other class carries a readable sentence must agree about
 * which classes are exempt — two hand-kept lists is how a class comes to be
 * exempt from a guard nobody meant to exempt it from.
 *
 * `unanswerable-cause` is not an exclusion at all: it is WHY a compartment
 * could not be read, and it prints under "WHAT 'CANNOT BE COMPARED' MEANS, BY
 * CAUSE" with its own vocabulary (`UNREAD_LABEL`). */
export const NOT_DECLARED_CLASSES = Object.freeze(["unanswerable-cause"]);

/**
 * Which of the four this document is. Exactly one, always.
 * @param {{axes?: string[], notes?: Record<string, unknown>}} row
 */
export function bucketOf(row) {
  const axes = Array.isArray(row?.axes) ? row.axes : [];
  if (axes.some((a) => !UNANSWERABLE.has(a))) return "work";
  if (axes.length) return "unanswerable";
  if (row?.notes && Object.keys(row.notes["book-blank"] || {}).length) return "book-gap";
  return "identical";
}

const zero = () => ({ docs: 0, docsProceeded: 0 });

/**
 * The whole verdict, from ONE reconcile verdict payload.
 *
 * `payload` is the JSON check-ac-erp-reconcile.mjs writes to VERDICT_OUT.
 * Nothing is read from anywhere else, and nothing is recomputed: `population`
 * is that run's own SUMMARY row, by reference, and the per-document rows are
 * that run's own findings.
 */
export function tallyVerdict(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const pop = payload?.population || {};
  const presence = payload?.presence || {};

  const absent = (presence.absent || []).length;
  const phantom = (presence.phantom || []).length;
  const decided = (presence.decided || []).length;

  const buckets = { identical: 0, work: 0, unanswerable: 0, "book-gap": 0 };
  /* group key -> {work, unanswerable} tallies, each split by proceeded */
  const byGroup = new Map(AXIS_GROUPS.map((g) => [g.key, { work: zero(), unanswerable: zero() }]));
  /* the raw axis name -> the same, so nothing hides inside a group label */
  const byAxis = new Map();
  const declared = new Map();
  const causes = new Map();
  const examples = { work: [], unanswerable: [] };

  for (const row of rows) {
    const b = bucketOf(row);
    buckets[b] += 1;
    const axes = Array.isArray(row.axes) ? row.axes : [];
    const proceededAxes = new Set(Array.isArray(row.axes_proceeded) ? row.axes_proceeded : []);

    for (const a of axes) {
      const kind = UNANSWERABLE.has(a) ? "unanswerable" : "work";
      const g = byGroup.get(GROUP_OF.get(a));
      if (g) {
        g[kind].docs += 1;
        if (proceededAxes.has(a)) g[kind].docsProceeded += 1;
      }
      if (!byAxis.has(a)) byAxis.set(a, { axis: a, kind, ...zero() });
      const cell = byAxis.get(a);
      cell.docs += 1;
      if (proceededAxes.has(a)) cell.docsProceeded += 1;
    }

    if (b === "work" || b === "unanswerable") {
      examples[b].push({
        doc_no: row.doc_no,
        ac_doc_no: row.ac_doc_no ?? null,
        axes,
        proceeded: proceededAxes.size > 0,
        detail: row.detail ?? null,
      });
    }

    for (const [klass, byAxisNotes] of Object.entries(row.notes || {})) {
      if (NOT_DECLARED_CLASSES.includes(klass)) {
        for (const [cause, cell] of Object.entries(byAxisNotes)) {
          if (!causes.has(cause)) causes.set(cause, { cause, docs: 0, findings: 0, findingsProceeded: 0 });
          const c = causes.get(cause);
          c.docs += 1;
          c.findings += cell.n ?? 0;
          c.findingsProceeded += cell.proceeded ?? 0;
        }
        continue;
      }
      if (!declared.has(klass)) declared.set(klass, { klass, docs: 0, findings: 0, findingsProceeded: 0, axes: new Set() });
      const d = declared.get(klass);
      d.docs += 1;
      for (const [axis, cell] of Object.entries(byAxisNotes)) {
        d.findings += cell.n ?? 0;
        d.findingsProceeded += cell.proceeded ?? 0;
        d.axes.add(axis);
      }
    }
  }

  /* THE DOCUMENT AXIS. An absent or phantom document never reached the line
     comparison at all, so it has no row above; counting it here is the only way
     the four buckets partition the whole population instead of only the part
     that happened to be comparable. */
  const docGroup = byGroup.get("document");
  docGroup.work.docs = absent + phantom;
  docGroup.work.docsProceeded = 0; /* not knowable for a document we do not hold */
  buckets.work += absent + phantom;

  const compared = rows.length;
  const population = compared + absent + phantom;

  return {
    companyId: payload?.company_id ?? null,
    measuredAt: payload?.measured_at ?? null,
    runId: payload?.run_id ?? null,
    source: payload?.source ?? null,
    snapshotExportedAt: payload?.snapshot_exported_at ?? null,
    documents: {
      population,
      compared,
      absent,
      phantom,
      decided,
      book: pop.acDocs ?? null,
      scope: pop.scope ?? null,
      erpLinked: pop.erpLinked ?? null,
      outOfScopeAbsent: pop.outOfScopeAbsent ?? null,
      /* NAMED, not only counted. A document counted into WORK that the offender
         list cannot show is a number nobody can act on — and absent/phantom are
         precisely the two that have no comparison row to be listed from. */
      absentDocs: presence.absent || [],
      phantomDocs: presence.phantom || [],
      decidedDocs: presence.decided || [],
    },
    lines: {
      compared: pop.comparedLines ?? null,
      acLinesPaired: pop.acLinesPaired ?? null,
      sofaDocs: pop.sofaDocs ?? null,
    },
    buckets,
    groups: AXIS_GROUPS.map((g) => ({ key: g.key, label: g.label, ...byGroup.get(g.key) })),
    axes: [...byAxis.values()].sort((a, b) => b.docs - a.docs || (a.axis < b.axis ? -1 : 1)),
    declared: [...declared.values()]
      .map((d) => ({ ...d, axes: [...d.axes].sort() }))
      .sort((a, b) => b.findings - a.findings),
    unanswerableCauses: [...causes.values()].sort((a, b) => b.findings - a.findings),
    /* The reconcile's own summary row, verbatim, so a reader can put this
       report and the reconcile log side by side without trusting either. */
    reconcileSummary: pop,
    examples,
  };
}

/**
 * THE GATE. The only statement of what TALLIED means, anywhere.
 *
 * Zero work. Not "few"; not "only the declared ones are left"; not "the
 * unanswerable ones do not count so round down". A future summary writer does
 * not get to decide this, which is the point of it being a function.
 */
export function isTallied(v) {
  return v.buckets.work === 0;
}

const num = (n) => (n == null ? "?" : Number(n).toLocaleString("en-US"));
const pad = (s, w) => String(s).padEnd(w);
const rpad = (n, w) => String(n).padStart(w);

/**
 * The artifact, as lines of text. `show` caps every offender list.
 *
 * Ordered so the answer is readable top-down by somebody who is not an
 * engineer: what population, then each axis in his words, then what was
 * excluded and under whose ruling, then the four numbers, then the sentence.
 */
export function renderVerdict(v, { show = 20, type = "SO" } = {}) {
  const spec = docTypeSpec(type);
  const out = [];
  const p = (s = "") => out.push(s);

  p("");
  p(`═════════════ ${spec.heading} ═════════════`);
  p(
    `company ${v.companyId} · measured ${v.measuredAt} · book snapshot ${v.snapshotExportedAt} · ${v.source}`,
  );
  if (spec.grain) p(spec.grain);
  p(spec.scope(v, num));
  p(
    `THIS VERDICT COVERS ${num(v.documents.population)} document(s): ${num(v.documents.compared)} present on both ` +
      `sides and compared line by line, ${num(v.documents.absent)} in scope and absent from the ERP, ` +
      `${num(v.documents.phantom)} the ERP claims and the book does not have. ` +
      `${num(v.lines.acLinesPaired)} book line(s) were paired to an ERP line.`,
  );
  if (v.documents.decided) {
    p(
      `   plus ${num(v.documents.decided)} absentee(s) you have already ruled on. Named in the reconcile log with ` +
        "the ruling and what is still owed; NOT counted as a gap here.",
    );
  }

  p("");
  p("─── EVERY AXIS, IN YOUR WORDS. `differ` is work; `cannot compare` is not, and is never folded into it. ───");
  p(
    `${pad("what was checked", 52)} ${rpad("differ", 7)} ${rpad("of those", 9)} ${rpad("cannot", 7)} ${rpad("of those", 9)}`,
  );
  p(`${pad("", 52)} ${rpad("", 7)} ${rpad("PROCEEDED", 9)} ${rpad("compare", 7)} ${rpad("PROCEEDED", 9)}`);
  for (const g of v.groups) {
    p(
      `${pad(spec.labels[g.key] ?? g.label, 52)} ${rpad(g.work.docs, 7)} ${rpad(g.work.docsProceeded, 9)} ` +
        `${rpad(g.unanswerable.docs, 7)} ${rpad(g.unanswerable.docsProceeded, 9)}`,
    );
  }
  p("counted in DOCUMENTS, not findings. A document differing on two axes appears on both rows and is counted ONCE below.");
  p(
    "PROCEEDED = the factory is building it. Your rule 还没proceed还没确认的就可以直接放空的 means an unconfirmed " +
      "order's blank is not a gap, so the backlog that matters is the PROCEEDED column.",
  );

  if (v.axes.length) {
    p("");
    p("   the same thing at the reconcile's own axis names, so this report and the reconcile log can be laid side by side:");
    for (const a of v.axes) {
      p(`      ${pad(a.axis, 34)} ${rpad(a.docs, 6)} document(s), ${rpad(a.docsProceeded, 6)} on a PROCEEDED order   [${a.kind}]`);
    }
  }

  if (v.unanswerableCauses.length) {
    p("");
    p("─── WHAT 'CANNOT BE COMPARED' MEANS, BY CAUSE — and whose it is ───");
    for (const c of v.unanswerableCauses) {
      p(`   ${rpad(c.docs, 5)} document(s), ${c.findings} line(s) (${c.findingsProceeded} proceeded)  ${UNREAD_LABEL[c.cause] ?? c.cause}`);
    }
    const mech = v.unanswerableCauses.find((c) => c.cause === MECHANICAL);
    const mechDocs = mech ? mech.docs : 0;
    p(
      `   => ${mechDocs} of these can be made comparable WITHOUT you (stamp the line key); the rest cannot — ` +
        "the account book's own text does not say what the build is, so your drawing is the only source.",
    );
  }

  if (v.declared.length) {
    p("");
    p("─── WHAT THIS VERDICT EXCLUDED, AND UNDER WHOSE RULING — nothing is excluded silently ───");
    for (const d of v.declared) {
      p(`   ${rpad(d.docs, 5)} document(s), ${d.findings} finding(s) (${d.findingsProceeded} on a proceeded order)`);
      p(`         ${DECLARED_LABEL[d.klass] ?? d.klass}`);
      p(`         axes: ${d.axes.join(", ")}`);
    }
  }
  const sofaDec = v.reconcileSummary?.declaredSofaDecomposition;
  if (sofaDec && (sofaDec.lineCount || sofaDec.unitPrice || sofaDec.itemCode)) {
    p(
      `   sofa decomposition: ${sofaDec.lineCount} line-count and ${sofaDec.unitPrice} unit-price finding(s), plus ` +
        `${sofaDec.itemCode} item-code finding(s), NOT counted — one book line is one ERP line per compartment, so ` +
        "those two are not comparable. The document TOTAL still has to match to the sen, and it is checked above.",
    );
  }
  const blanks = v.reconcileSummary?.declaredBlankBookRows;
  if (blanks && blanks.rows) {
    p(
      `   ${blanks.rows} AutoCount row(s) on ${blanks.docs} document(s) state nothing the ERP can hold — no item ` +
        "code, no quantity, no money. Not a missing line.",
    );
  }
  if (v.reconcileSummary?.noPrice) {
    p(`   ${v.reconcileSummary.noPrice} line(s) where the BOOK states no price. Houzs prices on arrival; copying the book would ERASE a real price.`);
  }
  if (v.reconcileSummary?.erpZeroMoney) {
    p(`   ${v.reconcileSummary.erpZeroMoney} document(s) carrying RM 0.00 on migrated paperwork — your decision 「GR 0 没关系」.`);
  }
  /* A foreign document is COMPARED IN ITS OWN CURRENCY, which is a fact about
     the comparison and not yet a verdict about the document. Whether the ERP's
     own currency column agrees is a separate question, answered on the CURRENCY
     axis above.

     THIS SENTENCE USED TO ANSWER IT HERE, and wrongly — it said "what is wrong
     is the ERP's own currency column", which is the same unread assertion that
     had the reconcile calling HC-PO-009335 'MYR' for nineteen hours after it was
     repaired to CNY (docs/bugs/0721). A count of documents compared in their own
     currency says nothing about whether their currency code is right. */
  if (v.reconcileSummary?.foreign) {
    p(
      `   ${v.reconcileSummary.foreign} document(s) are NOT in ${"MYR"}. Their totals are compared in the ` +
        "document's own currency, so the money can be right to the sen. Whether the ERP's currency column " +
        "ALSO agrees with the book is checked separately and counted on the CURRENCY axis above — never as " +
        "money, because reading a local-currency total as the document's is what made an exchange rate look " +
        "like a discount.",
    );
  }

  p("");
  p(
    "   a document is counted in ONE bucket only, and the order is work > cannot-compare > book-gap > identical: " +
      "a real difference is owed whatever an unreadable sofa on the same order turns out to be, and an unfinished " +
      "comparison outranks a declaration. So a class listed above can hold more documents than the bucket it feeds.",
  );

  if (v.documents.absent || v.documents.phantom) {
    p("");
    p("─── THE DOCUMENT ITSELF — counted as work, and named, because there is no comparison row to list it from ───");
    for (const d of v.documents.absentDocs.slice(0, show)) p(`   ABSENT   ${d} — in the outstanding population and NOT in the ERP. Somebody has to carry it over.`);
    if (v.documents.absentDocs.length > show) p(`   ... ${v.documents.absentDocs.length - show} more absent`);
    for (const d of v.documents.phantomDocs.slice(0, show)) p(`   PHANTOM  ${d} — the ERP claims an account-book number the book does not have.`);
    if (v.documents.phantomDocs.length > show) p(`   ... ${v.documents.phantomDocs.length - show} more phantom`);
  }

  for (const [kind, heading] of [
    ["work", "DIFFER ON THEIR CONTENT, AND IT IS WORK — every one, by document"],
    ["unanswerable", "CANNOT BE COMPARED — your drawing decides these"],
  ]) {
    const list = v.examples[kind];
    if (!list.length) continue;
    p("");
    p(`─── ${heading}: ${list.length} ───`);
    const sorted = list.slice().sort((a, b) => Number(b.proceeded) - Number(a.proceeded) || (a.doc_no < b.doc_no ? -1 : 1));
    for (const e of sorted.slice(0, show)) {
      p(`   ${e.doc_no} (${e.ac_doc_no ?? "?"})${e.proceeded ? "  [PROCEEDED]" : ""} — ${e.axes.join(", ")}`);
      /* ── A REFUSAL MUST SHOW THE VALUE IT IS REFUSING ABOUT ────────────────
         2026-09-09, the owner, about three orders reported as having no source
         at all for their build:
         「所以基本上model和sofa compartment基本上都有了啊？那为什么你说没有呢？」
         He was right. Two sources had been checked — the photograph and the
         book's Desc2 — and the third, THE VALUE THE ERP IS HOLDING, was never
         looked at. This list had the same blind spot: document number, axis
         name, stop. An order the ERP already holds a perfectly good build for
         reached him as a blank to fill from memory, which is 「把他已经答过的
         题目丢回给他」.

         The detail was already on the row and already carried through
         `tallyVerdict` into `examples`. Nothing printed it. Printing it turns
         "not verifiable" into a one-word confirmation.

         ONLY on the cannot-compare list, deliberately. A WORK row names a real
         difference on its axis and the reconcile log carries the two values
         side by side; a cannot-compare row names a REFUSAL, and the refusal
         alone is the thing nobody can act on. This prints, it does not
         reclassify: `bucketOf` is untouched and the row is still unanswerable. */
      if (kind === "unanswerable" && e.detail) {
        for (const d of String(e.detail).split(/\r?\n/)) if (d.trim()) p(`         ${d.trim()}`);
      }
    }
    if (sorted.length > show) p(`   ... ${sorted.length - show} more (raise SHOW to list them all)`);
  }

  const tallied = isTallied(v);
  p("");
  p("═════════════ THE ANSWER ═════════════");
  p(`${spec.headline} — ${num(v.documents.population)} documents, ${num(v.lines.acLinesPaired)} book lines paired.`);
  p(`  IDENTICAL to the account book on every axis:            ${rpad(v.buckets.identical, 6)}`);
  const docWork = v.documents.absent + v.documents.phantom;
  p(
    `  DIFFER, and it is work:                                 ${rpad(v.buckets.work, 6)}   ` +
      (v.buckets.work
        ? `(${v.buckets.work - docWork} on their content, ${docWork} the document itself — all named above)`
        : ""),
  );
  p(`  CANNOT BE COMPARED (the book's own text does not say):  ${rpad(v.buckets.unanswerable, 6)}   — your drawing decides these`);
  p(`  DIFFER, but the book itself is the gap:                 ${rpad(v.buckets["book-gap"], 6)}   — already accepted as 一模一样`);
  p("");
  p(
    tallied
      ? `TALLIED. All ${num(v.documents.population)} ${spec.plural} ${spec.tallied} ` +
        (v.buckets.unanswerable
          ? `${v.buckets.unanswerable} sofa build(s) could not be compared at all — the book's text does not state ` +
            "the pieces — and they are yours to adjudicate from the drawing, not work anyone owes."
          : "Nothing was left uncompared.")
      : `NOT TALLIED. ${v.buckets.work} of the ${spec.plural} still differ from the account book and somebody owes ` +
        "each one. " +
        (v.buckets.unanswerable
          ? `A further ${v.buckets.unanswerable} could not be compared at all and are yours to adjudicate from the drawing.`
          : ""),
  );
  return out;
}
