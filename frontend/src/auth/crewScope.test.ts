import { describe, expect, test } from "vitest";
import { CREW_SCOPED_POSITIONS, isCrewScopedUser } from "./crewScope";

describe("isCrewScopedUser — the crew positions, matched exactly", () => {
  test("the positions are exactly the ones the server force-scopes", () => {
    expect([...CREW_SCOPED_POSITIONS].sort()).toEqual([
      "helper",
      "storekeeper",
    ]);
  });

  test("each of them is crew-scoped, in any casing, with surrounding space", () => {
    for (const p of CREW_SCOPED_POSITIONS) {
      expect(isCrewScopedUser({ position_name: p, permissions: [] }), p).toBe(true);
      expect(isCrewScopedUser({ position_name: p.toUpperCase(), permissions: [] }), p).toBe(true);
      expect(isCrewScopedUser({ position_name: `  ${p}  `, permissions: [] }), p).toBe(true);
    }
  });

  test("a DRIVER is not — the owner kept them see-all on the projects list", () => {
    expect(isCrewScopedUser({ position_name: "Driver", permissions: [] })).toBe(false);
  });

  test("STOREKEEPER SUPERVISOR is not — the defect reviewer sees all events (owner 2026-09-15)", () => {
    expect(isCrewScopedUser({ position_name: "Storekeeper Supervisor", permissions: [] })).toBe(false);
  });
});

describe("isCrewScopedUser — a SUBSTRING must never claim a position", () => {
  test.each([
    "Warehouse Helper",
    "Helper Supervisor",
    "Assistant Storekeeper",
    "Senior Storekeeper Supervisor",
    "Helpers",
    "helperx",
    "Storekeeper Assistant",
  ])("%s is NOT crew-scoped", (position) => {
    expect(isCrewScopedUser({ position_name: position, permissions: [] })).toBe(false);
  });
});

describe("isCrewScopedUser — the permission escape", () => {
  test("a wildcard holder is never caged, whatever position they hold", () => {
    expect(isCrewScopedUser({ position_name: "Storekeeper", permissions: ["*"] })).toBe(false);
    expect(isCrewScopedUser({ position_name: "Helper", permissions: ["*"] })).toBe(false);
  });

  test("projects.write is also an escape", () => {
    expect(isCrewScopedUser({ position_name: "Helper", permissions: ["projects.write"] })).toBe(false);
  });

  test("but an unrelated grant is not — a tick-only helper stays scoped", () => {
    expect(
      isCrewScopedUser({ position_name: "Helper", permissions: ["projects.checklist.tick"] }),
    ).toBe(true);
  });
});

describe("isCrewScopedUser — nothing to go on", () => {
  test("a null or absent user is not crew-scoped", () => {
    expect(isCrewScopedUser(null)).toBe(false);
    expect(isCrewScopedUser(undefined)).toBe(false);
  });

  test("an empty, null or absent position is not crew-scoped", () => {
    expect(isCrewScopedUser({ position_name: "", permissions: [] })).toBe(false);
    expect(isCrewScopedUser({ position_name: null, permissions: [] })).toBe(false);
    expect(isCrewScopedUser({ permissions: [] })).toBe(false);
  });

  test("absent permissions are treated as none granted, not as an escape", () => {
    expect(isCrewScopedUser({ position_name: "Helper" })).toBe(true);
    expect(isCrewScopedUser({ position_name: "Helper", permissions: null })).toBe(true);
  });
});
