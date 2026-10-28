import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSR_LIST_FILTER_KEY,
  readAssrListFilter,
  writeAssrListFilter,
} from "./assrListFilter";

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("assrListFilter", () => {
  it("round-trips search + stage so a detail Back can restore them", () => {
    writeAssrListFilter({ search: "AKEMI", stage: "IN_PROGRESS" });
    expect(readAssrListFilter()).toEqual({ search: "AKEMI", stage: "IN_PROGRESS" });
  });

  it("defaults to empty when nothing is stored", () => {
    expect(readAssrListFilter()).toEqual({ search: "", stage: "ALL" });
  });

  it("clears storage once both are empty/ALL — a fresh session starts clean", () => {
    writeAssrListFilter({ search: "AKEMI", stage: "ALL" });
    expect(sessionStorage.getItem(ASSR_LIST_FILTER_KEY)).not.toBeNull();
    writeAssrListFilter({ search: "", stage: "ALL" });
    expect(sessionStorage.getItem(ASSR_LIST_FILTER_KEY)).toBeNull();
    expect(readAssrListFilter()).toEqual({ search: "", stage: "ALL" });
  });

  it("remembers a stage-only filter (no search text)", () => {
    writeAssrListFilter({ search: "", stage: "OVERDUE" });
    expect(readAssrListFilter()).toEqual({ search: "", stage: "OVERDUE" });
  });

  it("rejects a corrupt blob and over-long / wrong-typed fields", () => {
    sessionStorage.setItem(ASSR_LIST_FILTER_KEY, "{not json");
    expect(readAssrListFilter()).toEqual({ search: "", stage: "ALL" });

    sessionStorage.setItem(
      ASSR_LIST_FILTER_KEY,
      JSON.stringify({ search: "x".repeat(500), stage: 42 }),
    );
    expect(readAssrListFilter()).toEqual({ search: "", stage: "ALL" });
  });
});
