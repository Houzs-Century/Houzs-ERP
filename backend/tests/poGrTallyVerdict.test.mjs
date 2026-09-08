/* The SPECIFICATION for extending the tally verdict to PURCHASE ORDERS and
 * GOODS RECEIPTS. 2026-09-08, the owner: 「然后把PO GR也tally掉」.
 *
 * THREE PROPERTIES carry this file, and every case below is a way of trying to
 * break one of them:
 *
 *   1. THE GATE DID NOT MOVE. Adding two document types must not change what
 *      TALLIED means. `isTallied` stays zero-work, stays type-independent, and
 *      no per-type label gets a vote in it.
 *
 *   2. THE SUMMARY'S "NOT A GAP" IS NOT THIS REPORT'S "NOT A DIFFERENCE".
 *      The reconcile's SUMMARY table deliberately keeps `non-MYR` out of its
 *      gap total, and on 2026-09-08 that made the purchase orders read as
 *      "PO 0". A foreign document still LOCKS on the `currency` axis, and this
 *      report has to say so — the money can be right to the sen while the ERP
 *      holds the wrong currency. Reading the local-currency total as the
 *      document's once wrote RM 13,068.55 of imaginary discount onto a CNY
 *      order (docs/bugs/0665).
 *
 *   3. A GOODS RECEIPT IS COMPARED AT PAIR GRAIN, AND THE REPORT SAYS SO.
 *      One "document" is a (receipt × purchase order) pair. A reader who takes
 *      the population as "receipts" reads a right number as the wrong fact, so
 *      the grain note is asserted to be present rather than left to a comment.
 */
import { describe, expect, it } from "vitest";

import {
  DOC_TYPES,
  bucketOf,
  docTypeSpec,
  isTallied,
  renderVerdict,
  tallyVerdict,
} from "../scripts/lib/so-tally-verdict.mjs";
import { crossCheck } from "../scripts/lib/tally-crosscheck.mjs";
import { buildVerdictRows, makeVerdictRecorder } from "../scripts/lib/so-verdict-derive.mjs";

const row = (over = {}) => ({
  doc_no: "HC-PO-000001",
  ac_doc_no: "PO-000001",
  clean: true,
  axes: [],
  axes_proceeded: [],
  notes: {},
  ...over,
});

const payload = (rows, over = {}) => ({
  version: 1,
  type: "PO",
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

const render = (rows, type, over = {}) => renderVerdict(tallyVerdict(payload(rows, over)), { type }).join("\n");

describe("docTypeSpec — a type this report has no words for must REFUSE, not default", () => {
  it("knows the three types the owner asked about", () => {
    expect(Object.keys(DOC_TYPES).sort()).toEqual(["GR", "PO", "SO"]);
  });

  /* A typo rendering as SALES ORDERS would put a purchase-order number under a
     sales-order heading — a true number and a false sentence. */
  it("refuses an unknown type rather than silently rendering as SO", () => {
    expect(() => docTypeSpec("QQ")).toThrow(/no DOC_TYPES spec/);
  });

  it("defaults to SO so the sales-order lane's caller is unchanged", () => {
    expect(docTypeSpec(undefined).key).toBe("SO");
  });
});

describe("THE GATE DID NOT MOVE — TALLIED is still zero work, for every type", () => {
  for (const type of ["SO", "PO", "GR"]) {
    it(`${type}: one differing document is NOT TALLIED`, () => {
      const v = tallyVerdict(payload([row(), row({ doc_no: "x", axes: ["quantity"] })]));
      expect(isTallied(v)).toBe(false);
      expect(render([row(), row({ doc_no: "x", axes: ["quantity"] })], type)).toContain("NOT TALLIED");
    });

    it(`${type}: zero work is TALLIED even when something cannot be compared`, () => {
      const rows = [row(), row({ doc_no: "x", axes: ["sofa build not verifiable"] })];
      expect(isTallied(tallyVerdict(payload(rows)))).toBe(true);
      expect(render(rows, type)).toContain("TALLIED.");
    });
  }

  /* The label table must not be able to reach the gate. */
  it("a per-type label cannot make a differing document tally", () => {
    const v = tallyVerdict(payload([row({ axes: ["currency"] })]));
    expect(isTallied(v)).toBe(false);
    for (const type of ["SO", "PO", "GR"]) expect(render([row({ axes: ["currency"] })], type)).toContain("NOT TALLIED");
  });
});

describe("THE CURRENCY TRAP — 'not a money gap' is not 'not a difference'", () => {
  /* PO-009335 is in CNY at rate 0.61938 and the ERP holds MYR. The reconcile's
     SUMMARY counts it under `non-MYR` and NOT in its gap total, which is how
     the purchase orders came to read as "PO 0". It still locks. */
  it("a currency finding is WORK, never absorbed into identical", () => {
    expect(bucketOf(row({ axes: ["currency"] }))).toBe("work");
  });

  it("a document whose ONLY finding is currency is counted in work, not book-gap", () => {
    const v = tallyVerdict(payload([row({ axes: ["currency"] })]));
    expect(v.buckets.work).toBe(1);
    expect(v.buckets.identical).toBe(0);
    expect(v.buckets["book-gap"]).toBe(0);
  });

  it("the PO report NAMES the currency on the price axis, so it cannot be read as money only", () => {
    expect(render([row()], "PO")).toMatch(/unit price, the document total, and the CURRENCY/);
  });

  /* The reconcile's own non-MYR count has to be visible, with the reason, or a
     reader reconciling this report against the SUMMARY table finds a number in
     one and not the other and trusts neither. */
  it("the non-MYR population is printed with WHY it is not money", () => {
    const out = render([row()], "PO", { population: { foreign: 1 } });
    expect(out).toMatch(/1 document\(s\) are NOT in MYR/);
    expect(out).toMatch(/counted on the CURRENCY axis above, never as money/);
  });

  it("a corpus with no foreign document prints no such line", () => {
    expect(render([row()], "PO", { population: { foreign: 0 } })).not.toMatch(/NOT in MYR/);
  });
});

describe("GOODS RECEIPTS — pair grain, and the two labels that would otherwise lie", () => {
  it("the GR report states the grain; the SO report has no such note", () => {
    expect(render([row()], "GR")).toMatch(/GRAIN: one "document" below is a \(AutoCount receipt × purchase order\) PAIR/);
    expect(render([row()], "SO")).not.toMatch(/GRAIN:/);
  });

  /* `qty` on a goods receipt is qty_accepted — what ARRIVED, not what was
     ordered. The owner reads those as different questions. */
  it("GR asks about the quantity RECEIVED, not 'quantity'", () => {
    const out = render([row()], "GR");
    expect(out).toMatch(/quantity RECEIVED/);
  });

  /* grn_items.unit_price_sen is copied from the purchase-order line by design,
     never from GRDTL.UnitPrice. Printing "unit price" as a checked axis would
     report our own derivation back as agreement. */
  it("GR does not claim to have checked a unit price", () => {
    const out = render([row()], "GR");
    expect(out).toMatch(/the money the book states \(document total\)/);
    expect(out).not.toMatch(/^unit price and the document total/m);
  });

  it("each type prints its own heading and its own noun", () => {
    expect(render([row()], "GR")).toContain("GOODS RECEIPTS vs THE ACCOUNT BOOK");
    expect(render([row()], "PO")).toContain("PURCHASE ORDERS vs THE ACCOUNT BOOK");
    expect(render([row()], "SO")).toContain("SALES ORDERS vs THE ACCOUNT BOOK");
  });

  it("the owner's 「GR 0 没关系」 population is named, not silently dropped", () => {
    expect(render([row()], "GR", { population: { erpZeroMoney: 100 } })).toMatch(/100 document\(s\) carrying RM 0\.00/);
  });
});

describe("THE SALES-ORDER REPORT DID NOT MOVE", () => {
  /* The control the whole lane is judged on. `renderVerdict(v)` with no type is
     what check-so-tally.mjs calls, and it must be the same text as the explicit
     SO spec — otherwise this lane changed the sales-order answer. */
  it("the default render is byte-identical to the explicit SO render", () => {
    const rows = [row(), row({ doc_no: "y", axes: ["quantity"] }), row({ doc_no: "z", axes: ["sofa build not verifiable"] })];
    const v = tallyVerdict(payload(rows));
    expect(renderVerdict(v, { show: 5 }).join("\n")).toBe(renderVerdict(v, { show: 5, type: "SO" }).join("\n"));
  });

  it("the SO scope sentence still states the DO rule", () => {
    expect(render([row()], "SO")).toMatch(/the owner's DO rule — a fully delivered order is correctly absent/);
  });
});

describe("crossCheck — the report and the reconcile must state one run, or nothing prints", () => {
  const okLog = [
    "PO TALLY VERDICT — 2 documents compared against the book: 1 match it exactly; 1 still differ.",
    "type  book  scope    erp  absent  phantom   both",
    "PO    9416    484    574       0        0      2      0",
  ].join("\n");

  const built = () => {
    const rows = [row(), row({ doc_no: "y", axes: ["quantity"] })];
    const pl = payload(rows, { population: { acDocs: 9416, scope: 484, erpLinked: 574 } });
    return { pl, v: tallyVerdict(pl) };
  };

  it("agrees when both sides state the same run", () => {
    const { pl, v } = built();
    expect(crossCheck({ type: "PO", v, payload: pl, log: okLog }).problems).toEqual([]);
  });

  it("REFUSES when the printed verdict line disagrees with the rows", () => {
    const { pl, v } = built();
    const bad = okLog.replace("1 still differ", "7 still differ");
    const { problems } = crossCheck({ type: "PO", v, payload: pl, log: bad });
    expect(problems.join(" ")).toMatch(/printed PO TALLY VERDICT says 7 differ/);
  });

  it("REFUSES when the reconcile printed no line for this type at all", () => {
    const { pl, v } = built();
    const { problems } = crossCheck({ type: "GR", v, payload: pl, log: okLog });
    expect(problems.join(" ")).toMatch(/no "GR TALLY VERDICT" line/);
  });

  it("REFUSES when the SUMMARY row disagrees about the population", () => {
    const { pl, v } = built();
    const bad = okLog.replace("PO    9416", "PO    9999");
    expect(crossCheck({ type: "PO", v, payload: pl, log: bad }).problems.join(" ")).toMatch(/printed PO SUMMARY book = 9999/);
  });

  /* The arithmetic bridge. `clean` and `identical + book-gap` are the same set
     counted two ways; if they ever stop being, one of the two instruments has
     changed its mind about a document and NEITHER may be reported. */
  it("REFUSES when the file's own clean count does not equal identical + book-gap", () => {
    const { pl, v } = built();
    pl.summary.cleanCount = 2;
    expect(crossCheck({ type: "PO", v, payload: pl, log: okLog }).problems.join(" ")).toMatch(/counted 2 clean/);
  });

  it("REFUSES when an axis the reconcile reports is missing from this report", () => {
    const { pl, v } = built();
    pl.summary.perAxis = [["item code", 4]];
    expect(crossCheck({ type: "PO", v, payload: pl, log: okLog }).problems.join(" ")).toMatch(/no such axis/);
  });
});

describe("THE OWNER'S RULING MUST REACH THE PER-DOCUMENT VERDICT, not only the SUMMARY", () => {
  /* 「GR 0 没关系」, 2026-09-08. `document total` is recorded honestly inside the
     document loop, because the PROOF that a receipt is migrated paperwork is a
     separate read classified only after the whole type has been walked. If the
     ruling never reaches the recorder, the goods receipts read as 109 documents
     of work when 100 of them are the owner's own decision — `docs/bugs/0715`
     with the arrow pointing the other way. */
  const rec = () => makeVerdictRecorder();

  it("a reclassified document stops being work and becomes book-gap-free clean", () => {
    const r = rec();
    r.seen("GR", "GR-1|PO-1", "HC-GR-1");
    r.record("GR", "GR-1|PO-1", "HC-GR-1", "document total", "AutoCount RM 1646.00 vs ERP RM 0.00");
    let rows = buildVerdictRows({ recorder: r, type: "GR", companyId: 1, measuredAt: "t", runId: "r" });
    expect(rows[0].clean).toBe(false);
    expect(bucketOf(rows[0])).toBe("work");

    r.reclassify("GR", "GR-1|PO-1", "document total", "erp-zero-money", "proved migrated paperwork");
    rows = buildVerdictRows({ recorder: r, type: "GR", companyId: 1, measuredAt: "t", runId: "r" });
    expect(rows[0].clean).toBe(true);
    expect(rows[0].axes).toEqual([]);
    expect(bucketOf(rows[0])).toBe("identical");
  });

  it("the ruling is NAMED in the verdict, not silently dropped", () => {
    const r = rec();
    r.seen("GR", "GR-1|PO-1", "HC-GR-1");
    r.record("GR", "GR-1|PO-1", "HC-GR-1", "document total", "x");
    r.reclassify("GR", "GR-1|PO-1", "document total", "erp-zero-money", "proved");
    const rows = buildVerdictRows({ recorder: r, type: "GR", companyId: 1, measuredAt: "t", runId: "r" });
    expect(Object.keys(rows[0].notes)).toContain("erp-zero-money");
    const out = renderVerdict(tallyVerdict(payload(rows)), { type: "GR" }).join("\n");
    expect(out).toMatch(/「GR 0 没关系」/);
  });

  /* THE FENCES. This is the only method that can make a recorded document
     clean, so it is the only one that could wrongly OPEN one. */
  /* The `d.axes.has(axis)` fence, tested for what it ACTUALLY does. An earlier
     version of this case asserted the axes array was untouched — which is true
     whether the fence is there or not, because deleting an absent key is a
     no-op. A test that passes both ways proves nothing (CLAUDE.md: "a checker
     that cannot match reports a clean run"), and removing the fence was watched
     NOT to fail it before this was rewritten.

     What the fence really prevents is an INFLATED declaration: the owner is
     told "N documents were excluded under your ruling", and N must be the
     number that actually carried the finding. A reclassify for an axis that was
     never recorded must add nothing at all. */
  it("does not inflate the declared count with an axis that never had a finding", () => {
    const r = rec();
    r.seen("GR", "GR-2|PO-2", "HC-GR-2");
    r.record("GR", "GR-2|PO-2", "HC-GR-2", "quantity", "real difference");
    r.reclassify("GR", "GR-2|PO-2", "document total", "erp-zero-money", "never recorded on this doc");
    const rows = buildVerdictRows({ recorder: r, type: "GR", companyId: 1, measuredAt: "t", runId: "r" });
    expect(rows[0].axes).toEqual(["quantity"]);
    expect(rows[0].clean).toBe(false);
    /* THE ASSERTION THAT MOVES WHEN THE FENCE GOES. */
    expect(rows[0].notes["erp-zero-money"]).toBeUndefined();
    const v = tallyVerdict(payload(rows));
    expect(v.declared.find((d) => d.klass === "erp-zero-money")).toBeUndefined();
  });

  it("refuses a class nobody declared — no dropping a finding into a channel nobody enumerates", () => {
    const r = rec();
    r.seen("GR", "GR-3|PO-3", "HC-GR-3");
    r.record("GR", "GR-3|PO-3", "HC-GR-3", "document total", "x");
    r.reclassify("GR", "GR-3|PO-3", "document total", "made-up-amnesty", "x");
    const rows = buildVerdictRows({ recorder: r, type: "GR", companyId: 1, measuredAt: "t", runId: "r" });
    expect(rows[0].axes).toEqual(["document total"]);
    expect(rows[0].clean).toBe(false);
  });

  it("leaves the OTHER axes on the same document locking", () => {
    const r = rec();
    r.seen("GR", "GR-4|PO-4", "HC-GR-4");
    r.record("GR", "GR-4|PO-4", "HC-GR-4", "document total", "x");
    r.record("GR", "GR-4|PO-4", "HC-GR-4", "quantity", "y");
    r.reclassify("GR", "GR-4|PO-4", "document total", "erp-zero-money", "proved");
    const rows = buildVerdictRows({ recorder: r, type: "GR", companyId: 1, measuredAt: "t", runId: "r" });
    expect(rows[0].axes).toEqual(["quantity"]);
    expect(bucketOf(rows[0])).toBe("work");
  });
});
