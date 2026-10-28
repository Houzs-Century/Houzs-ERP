import { describe, expect, test } from "vitest";
import { canWriteScmConfig } from "../src/scm/lib/houzs-perms";

/* The dual-rule fix (owner 2026-07-18, "ONE RULE — position-driven"). The 29
   SCM master-data write routes gate on canWriteScmConfig, which is satisfied by
   EITHER the flat `scm.config.write` role perm OR the caller's POSITION policy
   canWriteConfig flag — never position-only, so any role holding the flat perm
   keeps passing. These pin the four cases the owner cares about: Purchasing
   passes by position, Storekeeper is still denied, a flat-perm role still passes,
   `*` passes, and a caller with no stashed user fails closed. */

/** Minimal HouzsUserSource — only `get('houzsUser')` is read. */
function ctx(hu: unknown) {
  return { get: (key: string) => (key === "houzsUser" ? hu : undefined) } as never;
}

describe("canWriteScmConfig — flat OR position, never position-only", () => {
  test("Procurement/Purchasing passes by POSITION with no flat perm", () => {
    expect(
      canWriteScmConfig(
        ctx({
          position_name: "Procurement/Purchasing",
          department_name: "Operation Department",
          permissions_set: new Set<string>(), // no flat perm at all
        }),
      ),
    ).toBe(true);
  });

  test("Operation Manager / Executive / Logistic Admin pass by POSITION", () => {
    for (const position_name of ["Operation Manager", "Operation Executive", "Logistic Admin"]) {
      expect(
        canWriteScmConfig(ctx({ position_name, department_name: "Operation Department", permissions_set: new Set<string>() })),
        position_name,
      ).toBe(true);
    }
  });

  test("Storekeeper is STILL denied (view-only) with no flat perm", () => {
    expect(
      canWriteScmConfig(
        ctx({ position_name: "Storekeeper", department_name: "Operation Department", permissions_set: new Set<string>() }),
      ),
    ).toBe(false);
  });

  test("HR Manager / Sales are denied by position", () => {
    for (const [position_name, department_name] of [
      ["HR Manager", "Management"],
      ["Sales Executive", "Sales Department"],
      ["Finance Manager", "Management"],
    ] as const) {
      expect(canWriteScmConfig(ctx({ position_name, department_name, permissions_set: new Set<string>() })), position_name).toBe(false);
    }
  });

  test("a role holding the FLAT perm passes even in a denied position (flat OR)", () => {
    // Storekeeper position, but the role carries scm.config.write → still passes.
    expect(
      canWriteScmConfig(
        ctx({
          position_name: "Storekeeper",
          department_name: "Operation Department",
          permissions_set: new Set(["scm.config.write"]),
        }),
      ),
    ).toBe(true);
  });

  test("the `*` wildcard passes (Owner / IT)", () => {
    expect(
      canWriteScmConfig(ctx({ position_name: "Sales Person", department_name: "Sales Department", permissions_set: new Set(["*"]) })),
    ).toBe(true);
  });

  test("fails CLOSED when no houzsUser is stashed", () => {
    expect(canWriteScmConfig(ctx(undefined))).toBe(false);
  });
});
