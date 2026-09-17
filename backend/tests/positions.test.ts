import { describe, expect, test } from "vitest";
import {
  resolvePositionAccessFromRows,
  levelRank,
  isValidPositionLevel,
} from "../src/services/pageAccess";

// The position page-access engine (4-level + inherit model), exercised through
// its pure resolver. The rows used to come from the position_page_access table
// (dropped 2026-09-17); they now come from the code whitelists a Title's
// position_policy profile names, through this same function.

describe("position page-access (4-level + inherit)", () => {
  test("levelRank: partial is a rank-1 alias of view", () => {
    expect(levelRank("none")).toBe(0);
    expect(levelRank("view")).toBe(1);
    expect(levelRank("partial")).toBe(1);
    expect(levelRank("edit")).toBe(2);
    expect(levelRank("full")).toBe(3);
  });

  test("isValidPositionLevel rejects legacy 'partial' and junk", () => {
    expect(isValidPositionLevel("none")).toBe(true);
    expect(isValidPositionLevel("view")).toBe(true);
    expect(isValidPositionLevel("edit")).toBe(true);
    expect(isValidPositionLevel("full")).toBe(true);
    expect(isValidPositionLevel("partial")).toBe(false);
    expect(isValidPositionLevel("admin")).toBe(false);
  });

  test("children inherit parent; explicit child overrides; financials hidden", () => {
    const map = resolvePositionAccessFromRows([
      { page_key: "team", level: "view" },
      { page_key: "projects", level: "view" },
      { page_key: "projects.finances", level: "none" },
    ]);
    expect(map.team).toBe("view");
    expect(map.projects).toBe("view");
    expect(map["projects.list"]).toBe("view"); // inherited
    expect(map["projects.calendar"]).toBe("view"); // inherited
    expect(map["projects.finances"]).toBe("none"); // explicit override → hidden
    expect(map["service_cases.cases"]).toBe("none"); // no row → none
    expect(map.sales).toBe("none");
  });

  test("parent full cascades to all children", () => {
    const map = resolvePositionAccessFromRows([{ page_key: "projects", level: "full" }]);
    expect(map.projects).toBe("full");
    expect(map["projects.list"]).toBe("full");
    expect(map["projects.calendar"]).toBe("full");
    expect(map["projects.finances"]).toBe("full");
  });

  test("narrow grant: parent none + a single child view", () => {
    const map = resolvePositionAccessFromRows([{ page_key: "projects.calendar", level: "view" }]);
    expect(map.projects).toBe("none");
    expect(map["projects.calendar"]).toBe("view");
    expect(map["projects.list"]).toBe("none");
  });
});
