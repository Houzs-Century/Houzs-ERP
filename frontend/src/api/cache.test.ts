import { describe, expect, test } from "vitest";
import { getCached, invalidateForMutation, setCached } from "./cache";

describe("a write clears what reads it back", () => {
  test("a changed bill reference clears the Books not complete report", () => {
    setCached("/api/projects/data-gaps", { stale: true });
    invalidateForMutation("/api/project-sales-bills/12/rename-ref");
    expect(getCached("/api/projects/data-gaps")).toBeUndefined();
  });
  test("a write elsewhere leaves it cached", () => {
    setCached("/api/projects/data-gaps", { stale: false });
    invalidateForMutation("/api/fleet/12");
    expect(getCached("/api/projects/data-gaps")).toEqual({ stale: false });
  });
});
