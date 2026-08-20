// ----------------------------------------------------------------------------
// The frontend half of the crew-scope predicate, tested on its own terms.
//
// The CROSS-TREE agreement — this predicate against
// backend/src/services/projectGates.ts's isCrewScopedUser, over one shared
// corpus — is pinned in backend/tests/duplicatedDecisionPins.test.ts, because
// only the backend test runner can import both trees. This file pins what the
// frontend copy DOES, so that a change here fails twice: once for disagreeing
// with the server, and once for changing the rule.
//
// Every case below distinguishes this implementation from the one it replaced
// (`/\bhelper\b/i.test(pos) || /storekeeper/i.test(pos)`, with no permission
// escape). If any of them starts passing under a substring test again, the
// drift has come back.
// ----------------------------------------------------------------------------
import { describe, expect, test } from "vitest";
import { CREW_SCOPED_POSITIONS, isCrewScopedUser } from "./crewScope";

describe("isCrewScopedUser — the three crew positions, matched exactly", () => {
  test("the positions are exactly the ones the server force-scopes", () => {
    expect([...CREW_SCOPED_POSITIONS].sort()).toEqual([
      "helper",
      "storekeeper",
      "storekeeper supervisor",
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
});

describe("isCrewScopedUser — a SUBSTRING must never claim a position", () => {
  /* Position names are owner-editable free text. The predicate this replaced
     used `/storekeeper/i` and `/\bhelper\b/i`, so every name below caged the UI
     while the server returned everything. */
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
    // The failure this guards: `user.permissions` is optional on the carrier,
    // and reading it as "unknown, so allow" would un-cage every helper.
    expect(isCrewScopedUser({ position_name: "Helper" })).toBe(true);
    expect(isCrewScopedUser({ position_name: "Helper", permissions: null })).toBe(true);
  });
});
