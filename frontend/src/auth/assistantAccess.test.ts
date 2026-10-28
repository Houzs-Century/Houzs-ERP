import { describe, expect, test } from "vitest";
import { ASSISTANT_DENIED_POSITIONS, ASSISTANT_KNOWN_POSITIONS, canUseAssistant } from "./assistantAccess";

/* LOCKSTEP with backend/src/services/assistant-scope.ts and its test. The two
   files share no import under the vendored-clone architecture, so these fixtures
   ARE the contract. If the backend list changes and this does not, a Sales user
   sees a launcher that 403s — or worse, the FE hides a tab the backend serves. */

describe("assistant access (FE mirror)", () => {
  test("deny list is field crew + Sales, lowercased", () => {
    expect([...ASSISTANT_DENIED_POSITIONS].sort()).toEqual([
      "driver",
      "helper",
      "sales director",
      "sales executive",
      "sales manager",
      "sales person",
      "storekeeper",
      "storekeeper supervisor",
    ]);
  });

  test("denies field crew and Sales", () => {
    for (const p of [
      "Driver", "Helper", "Storekeeper", " storekeeper ", "Storekeeper Supervisor",
      "Sales Director", "Sales Manager", "Sales Executive", "Sales Person",
    ]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
  });

  test("FAIL CLOSED: a named position not on the KNOWN list is denied", () => {
    for (const p of ["Regional Head", "Marketing Manager", "Senior Sales Consultant"]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
  });

  test("recognised non-denied positions, and no-position, may open it", () => {
    for (const p of ["Operation Manager", "HR Manager", "Service Admin", null]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), String(p)).toBe(true);
    }
  });

  test("every denied position is also known — the lists cannot silently drift", () => {
    for (const p of ASSISTANT_DENIED_POSITIONS) {
      expect(ASSISTANT_KNOWN_POSITIONS.has(p), p).toBe(true);
    }
  });

  test("wildcard bypasses every gate", () => {
    expect(canUseAssistant({ permissions: ["*"], position_name: "Driver" })).toBe(true);
    expect(canUseAssistant({ permissions: ["*"], position_name: "Ghost Title" })).toBe(true);
  });

  test("the server capability WINS over the name lists when present", () => {
    // A denied name the server nonetheless allowed → allowed (server is the control).
    expect(
      canUseAssistant({
        permissions: [],
        position_name: "Driver",
        capabilities: { "org.assistant.use": true },
      }),
    ).toBe(true);
    // A recognised, non-denied name the server denied → denied.
    expect(
      canUseAssistant({
        permissions: [],
        position_name: "Operation Manager",
        capabilities: { "org.assistant.use": false },
      }),
    ).toBe(false);
    // Key absent from a present set fails closed, even for a name that would pass.
    expect(
      canUseAssistant({ permissions: [], position_name: "HR Manager", capabilities: {} }),
    ).toBe(false);
  });

  test("no capability set → the name-list fallback still answers (stale-deploy shell)", () => {
    expect(canUseAssistant({ permissions: [], position_name: "Driver" })).toBe(false);
    expect(canUseAssistant({ permissions: [], position_name: "HR Manager" })).toBe(true);
  });
});
