// The pure ingredients of the announcement audience gate
// (src/lib/announcementAudience.ts): division-target parsing and equality,
// the company-grant narrowing, the roster SQL fragment, and the pending state.
// The gate itself and the DB-backed roster are pinned by the route suites
// (announcementsDivisionTargeting / announcementsAckSummary).
import { describe, expect, test } from "vitest";
import {
  ACK_OVERDUE_HOURS,
  divisionEq,
  inTargetCompanies,
  isOverdue,
  liveSinceMs,
  pendingState,
  readDivisionTargets,
  rosterCompaniesSql,
} from "../src/lib/announcementAudience";

describe("readDivisionTargets", () => {
  test("parses JSON or arrays, trims, drops invalid entries, collapses case duplicates", () => {
    expect(readDivisionTargets(null)).toEqual([]);
    expect(readDivisionTargets("")).toEqual([]);
    expect(readDivisionTargets("not json")).toEqual([]);
    expect(readDivisionTargets('[{"deptId":3,"division":" Driver Team "}]')).toEqual([
      { deptId: 3, division: "Driver Team" },
    ]);
    expect(
      readDivisionTargets([
        { deptId: 3, division: "Driver Team" },
        { dept_id: "3", division: "driver team" },
        { deptId: 0, division: "x" },
        { deptId: 3, division: "" },
        { deptId: 3, division: "y".repeat(121) },
        "junk",
        null,
      ]),
    ).toEqual([{ deptId: 3, division: "Driver Team" }]);
  });
});

describe("divisionEq", () => {
  test("case-insensitive, trimmed, never true for empty", () => {
    expect(divisionEq("Driver Team", "  driver team ")).toBe(true);
    expect(divisionEq("Driver Team", "Drivers")).toBe(false);
    expect(divisionEq("", "")).toBe(false);
    expect(divisionEq(null, undefined)).toBe(false);
  });
});

describe("inTargetCompanies", () => {
  test("no targets or no grants = everyone; otherwise the grant must overlap", () => {
    const grants = new Map<number, Set<number>>([[1, new Set([10])]]);
    expect(inTargetCompanies(grants, 1, [])).toBe(true);
    expect(inTargetCompanies(grants, 2, [10])).toBe(true); // no grant row: fail-open
    expect(inTargetCompanies(grants, 1, [10, 11])).toBe(true);
    expect(inTargetCompanies(grants, 1, [11])).toBe(false);
  });
});

describe("rosterCompaniesSql", () => {
  test("empty = no clause; ids are re-validated integers inlined with the alias", () => {
    expect(rosterCompaniesSql([])).toBe("");
    expect(rosterCompaniesSql([0, -1, NaN])).toBe("");
    const sql = rosterCompaniesSql([1, 2], "u");
    expect(sql).toContain("uc.user_id = u.id");
    expect(sql).toContain("IN (1,2)");
  });
});

describe("pendingState", () => {
  const h = 3_600_000;
  test("reminded wins, then the overdue window, else pending", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    expect(pendingState({ remindedAt: "2026-09-06T01:00:00Z", createdAt: "2026-09-01T00:00:00Z" }, now)).toBe("reminded");
    expect(pendingState({ reminded_at: "garbage", created_at: new Date(now - (ACK_OVERDUE_HOURS + 1) * h).toISOString() }, now)).toBe("overdue");
    expect(pendingState({ createdAt: new Date(now - 2 * h).toISOString() }, now)).toBe("pending");
    expect(pendingState({}, now)).toBe("pending");
  });

  test("the overdue clock starts when the notice went live (a scheduled instant after created_at)", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    const written = new Date(now - 5 * 24 * h).toISOString();
    const live = new Date(now - 10 * h).toISOString();
    expect(liveSinceMs({ createdAt: written, scheduledAt: live })).toBe(Date.parse(live));
    expect(liveSinceMs({ createdAt: written })).toBe(Date.parse(written));
    expect(Number.isNaN(liveSinceMs({}))).toBe(true);
    expect(isOverdue({ createdAt: written, scheduledAt: live }, now)).toBe(false);
    expect(isOverdue({ createdAt: written }, now)).toBe(true);
    expect(pendingState({ createdAt: written, scheduledAt: live }, now)).toBe("pending");
  });
});
