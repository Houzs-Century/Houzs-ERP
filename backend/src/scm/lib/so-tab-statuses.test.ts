import { describe, expect, test } from "vitest";
import { SO_TAB_STATUSES, soStatusesForTab } from "./so-tab-statuses";

describe("SO_TAB_STATUSES", () => {
  /* THE RULING THIS FILE EXISTS FOR (owner, 2026-08-22):
     「Sales Order 的 Shipped 跟 Delivered 是合起来的」. */
  test("the Delivered tab covers SHIPPED as well as DELIVERED", () => {
    expect(soStatusesForTab("DELIVERED")).toEqual(["SHIPPED", "DELIVERED"]);
  });

  /* THE BUG THIS PREVENTS. Deleting SHIPPED from the vocabulary WITHOUT giving
     it a bucket sends a row carrying it into the list's `other` catch-all —
     reachable from no tab, and subtracted from the count the operator reads.
     That is the fault status-counts.ts was written after: 37 delivery orders
     invisible while the numbers looked settled. */
  test("SHIPPED is reachable from a tab and is in exactly one", () => {
    const owners = Object.entries(SO_TAB_STATUSES)
      .filter(([, members]) => members.includes("SHIPPED"))
      .map(([tab]) => tab);
    expect(owners).toEqual(["DELIVERED"]);
  });

  test("no status is claimed by two tabs", () => {
    const seen = new Map<string, string>();
    for (const [tab, members] of Object.entries(SO_TAB_STATUSES)) {
      for (const m of members) {
        expect(seen.has(m), `${m} is in both ${seen.get(m)} and ${tab}`).toBe(false);
        seen.set(m, tab);
      }
    }
  });

  test("there is no Shipped tab left to select", () => {
    expect(SO_TAB_STATUSES.SHIPPED).toBeUndefined();
  });

  /* The wire sends `status.toUpperCase()` (sales-order-queries.ts), so the keys
     must be the values that actually arrive. */
  test("every key is upper case, matching what the client sends", () => {
    for (const tab of Object.keys(SO_TAB_STATUSES)) expect(tab).toBe(tab.toUpperCase());
  });

  test("a single-status tab still answers through the buckets", () => {
    expect(soStatusesForTab("DRAFT")).toEqual(["DRAFT"]);
    expect(soStatusesForTab("ON_HOLD")).toEqual(["ON_HOLD"]);
  });

  /* An unknown tab must filter to SOMETHING real. Returning [] would widen the
     query to every row, which is the opposite of what a filter is for. */
  test("an unknown tab selects itself rather than widening to everything", () => {
    expect(soStatusesForTab("WAT")).toEqual(["WAT"]);
    expect(soStatusesForTab("WAT")).not.toHaveLength(0);
  });
});
