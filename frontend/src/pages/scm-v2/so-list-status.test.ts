import { describe, expect, test } from "vitest";
import { SO_STATUS_TABS, statusFor } from "./so-list-status";

/* Every Sales Order status the LIST can be handed. Not the tab list — a tab is
   a filter, and SHIPPED has no tab of its own since it folds into Delivered
   (so-tab-statuses.ts, 2026-08-22) while a row can still carry it, because
   Postgres cannot drop an enum label. */
const SO_STATUSES = [
  "DRAFT", "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED",
  "DELIVERED", "INVOICED", "CLOSED", "ON_HOLD", "CANCELLED",
];

describe("statusFor", () => {
  /* THE BUG THIS EXISTS FOR. `statusFor` falls through to `{ label: s }` — the
     RAW STORED VALUE — so a status with no row in STATUS_TONE is not merely
     uncoloured, it is UNTRANSLATED. The owner's production screenshot showed 18
     orders in a pill reading `READY_TO_SHIP`, underscore and all, beside others
     reading a proper "Confirmed".

     RED on the unfixed tree for IN_PRODUCTION, READY_TO_SHIP and SHIPPED. */
  test.each(SO_STATUSES)("%s renders a human label, never the raw enum key", (status) => {
    const { label } = statusFor(status);
    expect(label).not.toBe(status);
    expect(label).not.toMatch(/_/);
    expect(label).not.toBe(status.toLowerCase());
  });

  test("the label is Title Case, matching status-pill.ts", () => {
    expect(statusFor("READY_TO_SHIP").label).toBe("Ready to Ship");
    expect(statusFor("IN_PRODUCTION").label).toBe("In Production");
    expect(statusFor("SHIPPED").label).toBe("Shipped");
    expect(statusFor("ON_HOLD").label).toBe("On Hold");
    expect(statusFor("CLOSED").label).toBe("Closed");
  });

  /* Every TAB must also resolve, or the tab strip and the pill disagree about
     the same order — which is the drift this map keeps producing. */
  test("every status tab's value resolves to a label", () => {
    for (const { value } of SO_STATUS_TABS) {
      if (value === "all") continue;
      const { label } = statusFor(value.toUpperCase());
      expect(label, `tab ${value} has no label`).not.toMatch(/_/);
    }
  });

  test("case does not matter — the column is read straight off the row", () => {
    expect(statusFor("ready_to_ship").label).toBe("Ready to Ship");
    expect(statusFor("Ready_To_Ship").label).toBe("Ready to Ship");
  });

  /* An UNKNOWN status still has to render something rather than crash, and the
     raw value is the honest fallback there — it says "this system has never
     heard of this", which a blank or a guess would hide. */
  test("an unknown status falls back to the raw value, deliberately", () => {
    expect(statusFor("WAT").label).toBe("WAT");
    expect(statusFor(null).label).toBe("—");
    expect(statusFor("").label).toBe("—");
  });
});
