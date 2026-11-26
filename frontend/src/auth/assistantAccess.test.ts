import { describe, expect, test } from "vitest";
import { ASSISTANT_DENIED_POSITIONS, ASSISTANT_KNOWN_POSITIONS, canUseAssistant } from "./assistantAccess";


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
    expect(
      canUseAssistant({
        permissions: [],
        position_name: "Driver",
        capabilities: { "org.assistant.use": true },
      }),
    ).toBe(true);
    expect(
      canUseAssistant({
        permissions: [],
        position_name: "Operation Manager",
        capabilities: { "org.assistant.use": false },
      }),
    ).toBe(false);
    expect(
      canUseAssistant({ permissions: [], position_name: "HR Manager", capabilities: {} }),
    ).toBe(false);
  });

  test("no capability set → the name-list fallback still answers (stale-deploy shell)", () => {
    expect(canUseAssistant({ permissions: [], position_name: "Driver" })).toBe(false);
    expect(canUseAssistant({ permissions: [], position_name: "HR Manager" })).toBe(true);
  });
});
