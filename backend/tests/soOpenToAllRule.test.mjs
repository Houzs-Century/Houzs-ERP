/* The rule that decides `open_to_all`. Pinned here rather than only at the
   reconciler, because the reconciler needs a database and this is the part that
   decides who can EDIT 2,882 imported sales orders. */
import { describe, it, expect } from "vitest";
import { shouldBeOpenToAll, planOpenToAll } from "../scripts/lib/so-open-to-all-rule.mjs";
import { SO_TERMINAL_STATES } from "../scripts/lib/so-terminal-states.mjs";

describe("shouldBeOpenToAll", () => {
  it("opens an imported order that is still outstanding", () => {
    for (const status of ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"]) {
      expect(shouldBeOpenToAll({ isMigrated: true, status })).toBe(true);
    }
  });

  it("withdraws every terminal status, including the ones no imported order carries today", () => {
    for (const status of SO_TERMINAL_STATES) {
      expect(shouldBeOpenToAll({ isMigrated: true, status })).toBe(false);
    }
    // The three the owner's 2026-09-23 ruling actually closes on production.
    expect(SO_TERMINAL_STATES).toEqual(expect.arrayContaining(["DELIVERED", "CLOSED", "CANCELLED"]));
  });

  it("never opens a native ERP order, whatever its status", () => {
    expect(shouldBeOpenToAll({ isMigrated: false, status: "CONFIRMED" })).toBe(false);
    expect(shouldBeOpenToAll({ isMigrated: false, status: "DELIVERED" })).toBe(false);
  });

  /* The permissive answer would hand write access to everyone, so the
     unclassifiable row closes. */
  it("closes a row whose status is missing or blank", () => {
    expect(shouldBeOpenToAll({ isMigrated: true, status: null })).toBe(false);
    expect(shouldBeOpenToAll({ isMigrated: true, status: "   " })).toBe(false);
    expect(shouldBeOpenToAll({ isMigrated: true, status: undefined })).toBe(false);
  });

  it("reads the status case- and whitespace-insensitively", () => {
    expect(shouldBeOpenToAll({ isMigrated: true, status: " delivered " })).toBe(false);
    expect(shouldBeOpenToAll({ isMigrated: true, status: "confirmed" })).toBe(true);
  });
});

describe("planOpenToAll", () => {
  const rows = [
    { docNo: "HC-SO-003645", isMigrated: true, status: "IN_PRODUCTION", openToAll: true },  // stays
    { docNo: "HC-SO-000013", isMigrated: true, status: "DELIVERED", openToAll: true },       // close
    { docNo: "HC-SO-000014", isMigrated: true, status: "CANCELLED", openToAll: true },       // close
    { docNo: "HC-SO-000015", isMigrated: true, status: "CONFIRMED", openToAll: false },      // open
    { docNo: "HC-SO-2609-001", isMigrated: false, status: "CONFIRMED", openToAll: false },   // untouched
    { docNo: "2990-SO-2609-1", isMigrated: false, status: "CONFIRMED", openToAll: true },    // close (never ours)
  ];

  it("splits the work into open / close and leaves agreeing rows alone", () => {
    const { toOpen, toClose, wantOpen } = planOpenToAll(rows);
    expect(toOpen).toEqual(["HC-SO-000015"]);
    expect(toClose).toEqual(["HC-SO-000013", "HC-SO-000014", "2990-SO-2609-1"]);
    expect(wantOpen).toEqual(["HC-SO-003645", "HC-SO-000015"]);
  });

  it("is idempotent — a tree already reconciled plans no work", () => {
    const settled = rows.map((r) => ({
      ...r,
      openToAll: shouldBeOpenToAll({ isMigrated: r.isMigrated, status: r.status }),
    }));
    const { toOpen, toClose } = planOpenToAll(settled);
    expect(toOpen).toEqual([]);
    expect(toClose).toEqual([]);
  });
});
