/* The SPECIFICATION for the one artifact that answers 「所以SO 都tally了吗?」.
 *
 * TWO PROPERTIES carry the file, and every case below is a way of trying to
 * break one of them:
 *
 *   1. "CANNOT BE COMPARED" IS NEVER ABSORBED. A document the checker refused
 *      to answer about is neither agreeing nor differing, and it must land in
 *      its own column whichever neighbour would be more convenient. Folding it
 *      into DIFFER invents a backlog nobody owes; folding it into IDENTICAL
 *      calls 110 documents checked when nothing checked them. Both happened on
 *      2026-09-08, about the same corpus, on the same day.
 *
 *   2. TALLIED MEANS ZERO WORK, and the word is decided in exactly one place.
 *      Not "few", not "only the declared ones are left", not "round down
 *      because the rest are the owner's". A summary writer does not get a vote.
 */
import { describe, expect, it } from "vitest";

import { LOCKING_AXES } from "../scripts/lib/so-verdict-derive.mjs";
import { AXIS_GROUPS, bucketOf, isTallied, renderVerdict, tallyVerdict } from "../scripts/lib/so-tally-verdict.mjs";

const row = (over = {}) => ({
  doc_no: "HC-SO-000001",
  ac_doc_no: "SO-000001",
  clean: true,
  axes: [],
  axes_proceeded: [],
  notes: {},
  ...over,
});

const payload = (rows, over = {}) => ({
  version: 1,
  type: "SO",
  company_id: 1,
  measured_at: "2026-09-08T12:00:00.000Z",
  run_id: "r",
  source: "local",
  summary: {
    docCount: rows.length,
    cleanCount: rows.filter((r) => (r.axes || []).length === 0).length,
    differCount: rows.filter((r) => (r.axes || []).length > 0).length,
    perAxis: [],
  },
  population: {},
  presence: {},
  rows,
  ...over,
});

describe("bucketOf — exactly one bucket, and cannot-compare is never absorbed", () => {
  it("no axis and no note is IDENTICAL", () => {
    expect(bucketOf(row())).toBe("identical");
  });

  it("a real difference is WORK", () => {
    expect(bucketOf(row({ axes: ["sofa compartments"] }))).toBe("work");
  });

  it("an unanswerable axis ALONE is its own bucket, not work and not identical", () => {
    expect(bucketOf(row({ axes: ["sofa build not verifiable"] }))).toBe("unanswerable");
  });

  /* THE 2026-09-08 CASE, both directions. The same document must not be able to
     read as a backlog item on one run and as checked on the next. */
  it("an unanswerable document is neither DIFFER nor IDENTICAL", () => {
    const b = bucketOf(row({ axes: ["sofa build not verifiable"] }));
    expect(b).not.toBe("work");
    expect(b).not.toBe("identical");
  });

  it("a real difference plus an unreadable sofa is WORK — the work is owed whatever the sofa turns out to be", () => {
    expect(bucketOf(row({ axes: ["sofa build not verifiable", "quantity"] }))).toBe("work");
  });

  it("only a book-blank is BOOK-GAP, not identical", () => {
    expect(bucketOf(row({ notes: { "book-blank": { "seat size": { n: 1, proceeded: 0, lines: [] } } } }))).toBe("book-gap");
  });

  it("an unanswerable document that is ALSO book-blank stays unanswerable", () => {
    const r = row({
      axes: ["sofa build not verifiable"],
      notes: { "book-blank": { "seat size": { n: 1, proceeded: 0, lines: [] } } },
    });
    expect(bucketOf(r)).toBe("unanswerable");
  });

  it("a declared class that is NOT book-blank leaves the document identical", () => {
    const r = row({ notes: { recorded: { specials: { n: 2, proceeded: 2, lines: [] } } } });
    expect(bucketOf(r)).toBe("identical");
  });
});

describe("tallyVerdict — the four buckets partition the whole population", () => {
  it("compared + absent + phantom is the population, and the buckets sum to it", () => {
    const v = tallyVerdict(
      payload(
        [
          row({ doc_no: "A" }),
          row({ doc_no: "B", axes: ["quantity"], axes_proceeded: ["quantity"] }),
          row({ doc_no: "C", axes: ["sofa build not verifiable"] }),
          row({ doc_no: "D", notes: { "book-blank": { specials: { n: 1, proceeded: 0, lines: [] } } } }),
        ],
        { presence: { absent: ["SO-9"], phantom: ["SO-8 (ERP HC-SO-8)"], decided: ["SO-7"] } },
      ),
    );
    expect(v.documents.compared).toBe(4);
    expect(v.documents.population).toBe(6);
    const sum = v.buckets.identical + v.buckets.work + v.buckets.unanswerable + v.buckets["book-gap"];
    expect(sum).toBe(v.documents.population);
    /* absent and phantom are WORK: an absent document is a real gap and a
       phantom is a document we hold that the book does not have. */
    expect(v.buckets.work).toBe(3);
    expect(v.buckets.unanswerable).toBe(1);
    expect(v.buckets["book-gap"]).toBe(1);
    expect(v.buckets.identical).toBe(1);
    /* a decided absence is named, and is NOT a gap */
    expect(v.documents.decided).toBe(1);
  });

  it("every axis is counted in documents, and the PROCEEDED arm is counted apart", () => {
    const v = tallyVerdict(
      payload([
        row({ doc_no: "A", axes: ["sofa compartments"], axes_proceeded: ["sofa compartments"] }),
        row({ doc_no: "B", axes: ["sofa compartments"], axes_proceeded: [] }),
      ]),
    );
    const g = v.groups.find((x) => x.key === "sofa-compartments");
    expect(g.work.docs).toBe(2);
    expect(g.work.docsProceeded).toBe(1);
    expect(g.unanswerable.docs).toBe(0);
  });

  it("a document differing on two axes is counted on both axis rows and ONCE in the buckets", () => {
    const v = tallyVerdict(payload([row({ doc_no: "A", axes: ["quantity", "item code"] })]));
    expect(v.axes.find((a) => a.axis === "quantity").docs).toBe(1);
    expect(v.axes.find((a) => a.axis === "item code").docs).toBe(1);
    expect(v.buckets.work).toBe(1);
  });

  it("the unanswerable CAUSES are carried, so 'stamp a key' and 'ask the owner' never become one number", () => {
    const v = tallyVerdict(
      payload([
        row({
          doc_no: "A",
          axes: ["sofa build not verifiable"],
          notes: { "unanswerable-cause": { keyedBookUnreadable: { n: 3, proceeded: 1, lines: [] } } },
        }),
        row({
          doc_no: "B",
          axes: ["sofa build not verifiable"],
          notes: { "unanswerable-cause": { keylessBookReadable: { n: 1, proceeded: 0, lines: [] } } },
        }),
      ]),
    );
    expect(v.unanswerableCauses).toHaveLength(2);
    expect(v.unanswerableCauses.find((c) => c.cause === "keyedBookUnreadable").findings).toBe(3);
    expect(v.unanswerableCauses.find((c) => c.cause === "keylessBookReadable").docs).toBe(1);
  });
});

describe("isTallied — the gate, stated once", () => {
  it("zero work is TALLIED", () => {
    expect(isTallied(tallyVerdict(payload([row()])))).toBe(true);
  });

  it("ONE differing document is not TALLIED, however small", () => {
    expect(isTallied(tallyVerdict(payload([row(), row({ doc_no: "B", axes: ["quantity"] })])))).toBe(false);
  });

  /* The permissive answer must be unreachable by a comparison that did not run
     — but an unanswerable document is NOT work, and the owner's drawing is what
     settles it. So it does not block TALLIED, and the verdict says so on its
     own line rather than letting the word imply everything was compared. */
  it("cannot-be-compared does NOT block TALLIED, and the sentence says so out loud", () => {
    const v = tallyVerdict(payload([row(), row({ doc_no: "B", axes: ["sofa build not verifiable"] })]));
    expect(isTallied(v)).toBe(true);
    const text = renderVerdict(v).join("\n");
    expect(text).toContain("TALLIED");
    expect(text).toContain("could not be compared");
  });

  it("an ABSENT document alone blocks TALLIED — a document nobody carried over is work", () => {
    const v = tallyVerdict(payload([row()], { presence: { absent: ["SO-9"] } }));
    expect(isTallied(v)).toBe(false);
  });

  it("a PHANTOM document alone blocks TALLIED", () => {
    const v = tallyVerdict(payload([row()], { presence: { phantom: ["SO-8 (ERP HC-SO-8)"] } }));
    expect(isTallied(v)).toBe(false);
  });

  it("book-gap alone does NOT block TALLIED — it is already accepted as 一模一样", () => {
    const v = tallyVerdict(payload([row({ notes: { "book-blank": { specials: { n: 1, proceeded: 0, lines: [] } } } })]));
    expect(isTallied(v)).toBe(true);
  });
});

describe("renderVerdict — the line a non-engineer reads", () => {
  it("prints all four numbers, and never prints TALLIED while anything is work", () => {
    const v = tallyVerdict(payload([row(), row({ doc_no: "B", axes: ["quantity"], axes_proceeded: ["quantity"] })]));
    const text = renderVerdict(v).join("\n");
    expect(text).toContain("IDENTICAL to the account book on every axis");
    expect(text).toContain("DIFFER, and it is work");
    expect(text).toContain("CANNOT BE COMPARED");
    expect(text).toContain("DIFFER, but the book itself is the gap");
    expect(text).toContain("NOT TALLIED");
    expect(text).not.toMatch(/(^|\n)TALLIED/);
  });

  it("names every declared class it excluded, so nothing is excluded silently", () => {
    const v = tallyVerdict(
      payload([row({ notes: { recorded: { specials: { n: 2, proceeded: 2, lines: [] } } } })]),
    );
    const text = renderVerdict(v).join("\n");
    expect(text).toContain("WHAT THIS VERDICT EXCLUDED");
    expect(text).toContain("2026-09-03 ruling 甲");
  });
});

/* ── A REFUSAL MUST SHOW THE VALUE IT IS REFUSING ABOUT ──────────────────────
 * 2026-09-09. Three sales orders were reported to the owner as having "no
 * source at all" for their sofa build, and he pushed back:
 *
 *     「所以基本上model和sofa compartment基本上都有了啊？那为什么你说没有呢？」
 *
 * He was right. Two sources had been checked — the photograph and the book's
 * Desc2 — and the third, THE VALUE OUR OWN SYSTEM IS HOLDING, was never
 * looked at. The report had the same blind spot by construction: the
 * `CANNOT BE COMPARED` list printed the document number and the axis name and
 * stopped, so an order the ERP already holds a perfectly good build for reached
 * him as a blank to fill from memory.
 *
 * A line that says only "not verifiable" hands him work. A line that says
 * "the book does not state a build; we hold 1A(LHF)+1NA+1A(RHF)" is a
 * one-word confirmation. The detail was ALREADY on the row and already carried
 * through `tallyVerdict` into `examples`; nothing printed it.
 *
 * This is 「把他已经答过的题目丢回给他」 — the class this repo has been paying for
 * all night — caught as a property instead of as a complaint.
 */
describe("the CANNOT-BE-COMPARED list prints what the ERP itself holds", () => {
  const unreadable = (over = {}) =>
    row({
      doc_no: "HC-SO-013495",
      ac_doc_no: "SO-013495",
      clean: false,
      axes: ["sofa build not verifiable"],
      axes_proceeded: ["sofa build not verifiable"],
      detail:
        'sofa build not verifiable: SO-013495 DtlKey 926840 (ERP HC-SO-013495 8030-1A(LHF)): ' +
        'we hold "1A(LHF)+1NA+1A(RHF)" — the book\'s Desc2 does not state the pieces',
      ...over,
    });

  it("prints the held build beside the refusal, not just the document and the axis", () => {
    const v = tallyVerdict(payload([unreadable()]));
    const text = renderVerdict(v).join("\n");

    /* the refusal is still there and still its own bucket */
    expect(v.buckets.unanswerable).toBe(1);
    expect(text).toContain("CANNOT BE COMPARED — your drawing decides these");
    expect(text).toContain("HC-SO-013495");

    /* and the value behind it is on the page. THIS is the new property: the
       owner can answer 「对」 without opening anything. */
    expect(text).toContain("1A(LHF)+1NA+1A(RHF)");
  });

  it("still says so plainly when the ERP holds nothing either", () => {
    const v = tallyVerdict(
      payload([
        unreadable({
          doc_no: "HC-SO-013503",
          ac_doc_no: "SO-013503",
          detail:
            'sofa build not verifiable: SO-013503 DtlKey 926872 (ERP HC-SO-013503 8030-1S): ' +
            'we hold "(nothing)" — the book\'s Desc2 does not state the pieces',
        }),
      ]),
    );
    const text = renderVerdict(v).join("\n");
    expect(text).toContain("HC-SO-013503");
    expect(text).toContain("(nothing)");
  });

  /* A refusal that prints a build must not START reading as a difference. The
     bucket is the thing the owner's backlog is counted from, and printing more
     of the row may not move it. */
  it("printing the build does not move the document out of CANNOT BE COMPARED", () => {
    const v = tallyVerdict(payload([unreadable()]));
    expect(v.buckets.work).toBe(0);
    expect(v.buckets.identical).toBe(0);
    expect(isTallied(v)).toBe(true);
    expect(renderVerdict(v).join("\n")).toMatch(/(^|\n)TALLIED/);
  });
});

describe("the axis map cannot go stale", () => {
  /* A locking axis with no group would be a difference the lock still shuts
     documents for and this report never prints. The module asserts it at
     import; this pins the property so a later lane sees a failing test rather
     than a silently shorter table. */
  it("every locking axis belongs to exactly one owner-facing group", () => {
    const seen = new Map();
    for (const g of AXIS_GROUPS) for (const a of g.axes) seen.set(a, (seen.get(a) ?? 0) + 1);
    for (const a of LOCKING_AXES) {
      expect(seen.get(a), `locking axis "${a}" is in no AXIS_GROUP`).toBe(1);
    }
  });

  it("the two axes the owner named by hand are each their own row", () => {
    expect(AXIS_GROUPS.find((g) => g.key === "item-code").label).toBe("the SKU / item code");
    expect(AXIS_GROUPS.find((g) => g.key === "sofa-compartments").axes).toContain("sofa compartments");
    expect(AXIS_GROUPS.find((g) => g.key === "sofa-compartments").axes).toContain("sofa build not verifiable");
  });
});

/* ── THE CAUSE TABLE MUST DESCRIBE THE COLUMN IT IS TITLED AFTER ─────────────
 * Run 34257873206, on `main`, printed under the heading "WHAT 'CANNOT BE
 * COMPARED' MEANS, BY CAUSE" a table whose document counts were NOT the
 * cannot-compare column's:
 *
 *     GR   cause table 4 + 2 = 6 documents   ·   CANNOT BE COMPARED = 3
 *     DO   cause table 3 + 2 + 2 = 7         ·   CANNOT BE COMPARED = 5
 *     PI   cause table 2 + 3 = 5             ·   CANNOT BE COMPARED = 2
 *     PO   cause table 13                    ·   CANNOT BE COMPARED = 13, and
 *          HC-PO-000254 is in the cause table while sitting in DIFFER, while
 *          HC-PO-009828 sits in the cannot-compare column named by NO cause.
 *
 * Two independent defects, and this is the repo's named class — ONE COLUMN
 * CARRYING SEVERAL POPULATIONS:
 *
 *   1. the causes were accumulated from EVERY row, so a document already
 *      counted as WORK contributed a cause to the table explaining a column it
 *      is not in. "=> N can be made comparable WITHOUT you" was therefore a
 *      promise about documents that were never in the column.
 *   2. `sofa build not verifiable` is not the only unanswerable axis.
 *      `transfer chain not verifiable` emits no cause note at all, so a
 *      document unanswerable ONLY for that reason was named by nothing.
 *
 * The fix is not a bigger list. It is the INVARIANT: every document in the
 * cannot-compare column carries at least one named cause, and the ones that are
 * not in the column are reported separately rather than mixed in.
 */
describe("the cause table explains the CANNOT BE COMPARED column and nothing else", () => {
  it("a WORK document's unread sofa is NOT counted into the cannot-compare causes", () => {
    const v = tallyVerdict(
      payload([
        row({
          /* HC-DO-011510's shape: a real specials difference AND an unreadable
             sofa on the same document. Precedence makes it WORK. */
          doc_no: "W",
          axes: ["specials", "sofa build not verifiable"],
          axes_proceeded: ["specials", "sofa build not verifiable"],
          notes: { "unanswerable-cause": { keyedBookUnreadable: { n: 1, proceeded: 1, lines: [] } } },
        }),
        row({
          doc_no: "U",
          axes: ["sofa build not verifiable"],
          axes_proceeded: ["sofa build not verifiable"],
          notes: { "unanswerable-cause": { keyedBookUnreadable: { n: 1, proceeded: 1, lines: [] } } },
        }),
      ]),
    );
    expect(v.buckets.work).toBe(1);
    expect(v.buckets.unanswerable).toBe(1);
    const owner = v.unanswerableCauses.find((c) => c.cause === "keyedBookUnreadable");
    expect(owner.docs).toBe(1);
    /* the WORK one is not lost — it is stated on its own line */
    expect(v.unreadOnWorkDocs).toBe(1);
  });

  it("the causes cover EVERY document in the column — a chain-only refusal is named too", () => {
    const v = tallyVerdict(
      payload([
        row({
          /* HC-PO-009828: unanswerable, and its only axis emits no sofa note. */
          doc_no: "C",
          axes: ["transfer chain not verifiable"],
          axes_proceeded: ["transfer chain not verifiable"],
        }),
      ]),
    );
    expect(v.buckets.unanswerable).toBe(1);
    expect(v.uncausedUnanswerable).toBe(0);
    expect(v.unanswerableCauses.map((c) => c.cause)).toContain("chainUnverifiable");
  });

  it("the cause table's document coverage equals the column, on a mixed corpus", () => {
    const v = tallyVerdict(
      payload([
        row({ doc_no: "A", axes: ["sofa build not verifiable"], notes: { "unanswerable-cause": { keylessBookReadable: { n: 1, proceeded: 0, lines: [] } } } }),
        row({ doc_no: "B", axes: ["transfer chain not verifiable"] }),
        row({ doc_no: "C", axes: ["sofa build not verifiable", "transfer chain not verifiable"], notes: { "unanswerable-cause": { keyedBookUnreadable: { n: 1, proceeded: 0, lines: [] } } } }),
        row({ doc_no: "D", axes: ["quantity"] }),
        row({ doc_no: "E" }),
      ]),
    );
    expect(v.buckets.unanswerable).toBe(3);
    expect(v.uncausedUnanswerable).toBe(0);
    /* a document may carry TWO causes, so the causes need not SUM to the column
       — what must hold is that none of the column is uncaused, and that no
       cause counts a document outside the column. */
    for (const c of v.unanswerableCauses) expect(c.docs).toBeLessThanOrEqual(v.buckets.unanswerable);
    expect(v.unanswerableCauses.find((c) => c.cause === "chainUnverifiable").docs).toBe(2);
  });

  it("the mechanical arm is the one a key closes, and it is counted from the column only", () => {
    const v = tallyVerdict(
      payload([
        row({ doc_no: "M", axes: ["sofa build not verifiable"], notes: { "unanswerable-cause": { keylessBookReadable: { n: 2, proceeded: 2, lines: [] } } } }),
        row({ doc_no: "W", axes: ["quantity", "sofa build not verifiable"], notes: { "unanswerable-cause": { keylessBookReadable: { n: 9, proceeded: 9, lines: [] } } } }),
      ]),
    );
    expect(v.mechanicalDocs).toBe(1);
    expect(v.unreadOnWorkDocs).toBe(1);
  });
});
