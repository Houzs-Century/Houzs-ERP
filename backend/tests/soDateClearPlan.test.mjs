import { describe, it, expect } from "vitest";

import {
  HEADER_CLEARS,
  LINE_CLEARS,
  HEADER_CHANGED_COLUMNS,
  stableDigest,
  planClear,
  verifyCleared,
} from "../scripts/lib/so-date-clear-plan.mjs";

/* A header shaped like the one production actually holds for HC-SO-013495,
   read on 2026-09-09 (probe run 34315803944). Only the columns the rules touch
   are spelled out; `filler` stands for the ninety-odd others that must come
   back untouched. */
const header = () => ({
  doc_no: "HC-SO-013495",
  company_id: 1,
  status: "CONFIRMED",
  version: 1,
  processing_date: "2026-09-07",
  customer_delivery_date: "2026-09-08",
  amended_delivery_date: null,
  deposit_sen: 0,
  filler: "untouched",
});

const lines = () => ([
  {
    id: "2299d74f-8f92-4d9c-a17a-288ba4dab227",
    doc_no: "HC-SO-013495",
    item_code: "9058-1S",
    line_delivery_date: "2026-10-10",
    line_delivery_date_overridden: false,
    qty: 1,
  },
  {
    id: "12afd19d-867f-4252-bd64-102c02bc590d",
    doc_no: "HC-SO-013495",
    item_code: "AMN-SOFA PILLOW",
    line_delivery_date: "2026-09-08",
    line_delivery_date_overridden: false,
    qty: 2,
  },
]);

/** The row this write is supposed to leave behind. */
const cleared = (over = {}) => ({ ...header(), processing_date: null, customer_delivery_date: null, version: 2, ...over });
const clearedLines = (over = []) => lines().map((l, i) => ({
  ...l, line_delivery_date: null, line_delivery_date_overridden: false, ...(over[i] || {}),
}));

describe("the columns this lane may touch", () => {
  it("clears exactly the two dates the owner named, and nothing else", () => {
    expect(Object.keys(HEADER_CLEARS).sort()).toEqual(["customer_delivery_date", "processing_date"]);
    expect(HEADER_CLEARS.processing_date).toBe(null);
    expect(HEADER_CLEARS.customer_delivery_date).toBe(null);
  });

  /* NAMING A DEAD COLUMN IS 42703 AND 42703 FAILS THE WHOLE STATEMENT, so a
     run that reports "0 defects" after touching one is reporting nothing at
     all. `internal_expected_dd` was renamed by migration 0286 and
     `proceeded_at` is a retired twin; neither may ever appear here. */
  it("never names the retired spellings of the processing date", () => {
    const named = [...Object.keys(HEADER_CLEARS), ...HEADER_CHANGED_COLUMNS].join(" ");
    expect(named).not.toContain("internal_expected_dd");
    expect(named).not.toContain("proceeded_at");
  });

  it("clears the line-level delivery mirror the way apply_so_header_cas does", () => {
    expect(LINE_CLEARS).toEqual({ line_delivery_date: null, line_delivery_date_overridden: false });
  });

  it("counts the concurrency token as an expected change, so a stale form cannot re-write the dates", () => {
    expect(HEADER_CHANGED_COLUMNS).toContain("version");
    expect(HEADER_CHANGED_COLUMNS).toContain("processing_date");
    expect(HEADER_CHANGED_COLUMNS).toContain("customer_delivery_date");
    expect(HEADER_CHANGED_COLUMNS).toHaveLength(3);
  });
});

describe("stableDigest", () => {
  it("is blind to the columns this write is allowed to change", () => {
    expect(stableDigest(header(), HEADER_CHANGED_COLUMNS))
      .toBe(stableDigest(cleared(), HEADER_CHANGED_COLUMNS));
  });

  it("still sees a column this write is NOT allowed to change", () => {
    expect(stableDigest(cleared({ status: "DRAFT" }), HEADER_CHANGED_COLUMNS))
      .not.toBe(stableDigest(header(), HEADER_CHANGED_COLUMNS));
  });

  /* A stored DATE reaches callers as '2026-09-07' over PostgREST and as a JS
     Date over postgres.js. `String(aDate).slice(0,10)` is 'Mon Sep 07', which
     sorts after every '2026-…' string — the shape that made the approve gate
     refuse a legal amendment (docs/bugs/0636). An unchanged column must not
     read as a change merely because the two reads used different clients. */
  it("reads a Date and its ISO day as the same value", () => {
    const asString = { ...header(), amended_delivery_date: "2026-09-08" };
    const asDate = { ...header(), amended_delivery_date: new Date("2026-09-08T00:00:00.000Z") };
    expect(stableDigest(asDate, HEADER_CHANGED_COLUMNS)).toBe(stableDigest(asString, HEADER_CHANGED_COLUMNS));
  });

  it("does not confuse null with the string 'null'", () => {
    expect(stableDigest({ a: null }, [])).not.toBe(stableDigest({ a: "null" }, []));
  });
});

describe("planClear", () => {
  it("plans the two header columns, the version bump and both line mirrors", () => {
    const p = planClear({ docNo: "HC-SO-013495", companyId: 1, header: header(), lines: lines() });
    expect(p.refusal).toBe(null);
    expect(p.headerSets).toEqual({ processing_date: null, customer_delivery_date: null, version: 2 });
    expect(p.lineIds).toHaveLength(2);
    expect(p.digest).toBe(stableDigest(header(), HEADER_CHANGED_COLUMNS));
  });

  it("refuses a document that is not the one it was pointed at", () => {
    const p = planClear({ docNo: "HC-SO-013495", companyId: 1, header: { ...header(), doc_no: "HC-SO-000001" }, lines: lines() });
    expect(p.refusal).toMatch(/doc_no/i);
  });

  it("refuses the wrong company rather than writing across the tenant line", () => {
    const p = planClear({ docNo: "HC-SO-013495", companyId: 1, header: { ...header(), company_id: 2 }, lines: lines() });
    expect(p.refusal).toMatch(/company/i);
  });

  it("refuses a missing header instead of planning a no-op", () => {
    expect(planClear({ docNo: "HC-SO-013495", companyId: 1, header: null, lines: [] }).refusal).toMatch(/not found/i);
  });

  /* Re-running must be INERT, not a second write that bumps the version again
     and invalidates a form somebody has legitimately open. */
  it("reports an order whose dates are already clear as nothing to do", () => {
    const p = planClear({
      docNo: "HC-SO-013495", companyId: 1,
      header: { ...header(), processing_date: null, customer_delivery_date: null },
      lines: clearedLines(),
    });
    expect(p.alreadyClear).toBe(true);
    expect(p.refusal).toBe(null);
  });
});

describe("verifyCleared — the shape, not a row count", () => {
  const ok = () => verifyCleared({
    before: header(), after: cleared(),
    beforeLines: lines(), afterLines: clearedLines(),
  });

  it("passes on exactly the intended shape", () => {
    expect(ok()).toEqual({ ok: true, problems: [] });
  });

  it("FAILS when the processing date survived", () => {
    const v = verifyCleared({
      before: header(), after: cleared({ processing_date: "2026-09-07" }),
      beforeLines: lines(), afterLines: clearedLines(),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/processing_date/);
  });

  it("FAILS when the delivery date survived", () => {
    const v = verifyCleared({
      before: header(), after: cleared({ customer_delivery_date: "2026-09-08" }),
      beforeLines: lines(), afterLines: clearedLines(),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/customer_delivery_date/);
  });

  /* THE ONE THIS WHOLE MODULE EXISTS FOR. The owner said clear the dates and
     nothing else; a status that moved underneath the write is the failure a
     row count of "1 row updated" would happily report as success. */
  it("FAILS when any other header column moved", () => {
    const v = verifyCleared({
      before: header(), after: cleared({ status: "DRAFT" }),
      beforeLines: lines(), afterLines: clearedLines(),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/status/);
  });

  it("FAILS when the deposit moved, because 多收钱也 ok means never re-derive it", () => {
    const v = verifyCleared({
      before: header(), after: cleared({ deposit_sen: 1 }),
      beforeLines: lines(), afterLines: clearedLines(),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/deposit_sen/);
  });

  it("FAILS when the version did not bump by exactly one", () => {
    expect(verifyCleared({
      before: header(), after: cleared({ version: 1 }),
      beforeLines: lines(), afterLines: clearedLines(),
    }).ok).toBe(false);
    expect(verifyCleared({
      before: header(), after: cleared({ version: 3 }),
      beforeLines: lines(), afterLines: clearedLines(),
    }).ok).toBe(false);
  });

  /* Leaving the mirror behind is a HALF clear: effectiveSoDelivery falls
     through to `line_delivery_date` as a last resort, override flag or not, so
     the order would still read as dated demand to MRP, the allocator and the
     delivery board — the very surfaces the clear is meant to remove it from. */
  it("FAILS when a line kept its delivery date", () => {
    const v = verifyCleared({
      before: header(), after: cleared(),
      beforeLines: lines(), afterLines: clearedLines([{ line_delivery_date: "2026-10-10" }]),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/line_delivery_date/);
  });

  it("FAILS when a line column that is none of this lane's business moved", () => {
    const v = verifyCleared({
      before: header(), after: cleared(),
      beforeLines: lines(), afterLines: clearedLines([{ qty: 99 }]),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/qty/);
  });

  it("FAILS when a line vanished, rather than reading the survivors as clean", () => {
    const v = verifyCleared({
      before: header(), after: cleared(),
      beforeLines: lines(), afterLines: [clearedLines()[0]],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/line/i);
  });

  it("FAILS when a line appeared", () => {
    const extra = { ...clearedLines()[0], id: "00000000-0000-4000-8000-000000000009" };
    const v = verifyCleared({
      before: header(), after: cleared(),
      beforeLines: lines(), afterLines: [...clearedLines(), extra],
    });
    expect(v.ok).toBe(false);
  });

  /* The fresh connection hands dates back as Date objects where the planning
     read gave strings. That must not read as ninety changed columns. */
  it("passes when the verifying read returned Dates and the planning read gave strings", () => {
    const v = verifyCleared({
      before: { ...header(), amended_delivery_date: "2026-09-08" },
      after: { ...cleared(), amended_delivery_date: new Date("2026-09-08T00:00:00.000Z") },
      beforeLines: lines(), afterLines: clearedLines(),
    });
    expect(v).toEqual({ ok: true, problems: [] });
  });

  it("FAILS when the after-row is missing entirely", () => {
    const v = verifyCleared({ before: header(), after: null, beforeLines: lines(), afterLines: [] });
    expect(v.ok).toBe(false);
  });
});
