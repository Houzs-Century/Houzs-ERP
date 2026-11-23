// A confirmer pinned in hr-confirmer-scope sees / confirms ONLY their own
// employees; everyone else is unrestricted. This pins the current pin (so it is
// not silently dropped) and the "unlisted = null = company-wide" contract the
// OT / attendance / working-hours queries rely on.
import { describe, expect, test } from "vitest";
import { scopedEmployeeIds } from "../src/routes/lib/hr-confirmer-scope";

describe("scopedEmployeeIds", () => {
  test("a pinned confirmer is restricted to exactly their employees", () => {
    const s = scopedEmployeeIds(82);
    expect(s).not.toBeNull();
    expect([...(s ?? [])].sort((a, b) => a - b)).toEqual([6]);
  });

  test("an unlisted user is unrestricted — null means the query stays company-wide", () => {
    expect(scopedEmployeeIds(5)).toBeNull();
    expect(scopedEmployeeIds(999999)).toBeNull();
  });
});
