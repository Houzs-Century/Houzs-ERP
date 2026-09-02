/* ONE ROW, ONE ANSWER TO "HAS THIS ORDER GONE OUT?".
 *
 * The Sales Order list rendered `statusFor(row.status)` — the STORED column —
 * while the Delivered column beside it rendered `shipped_qty / deliverable_qty`,
 * derived LIVE from delivery-order coverage on the SAME response. The owner was
 * looking at a Status cell reading In Production next to a Delivered cell
 * reading 5 / 5.
 *
 * The stored column is a cache with exactly one writer (syncSoDeliveredFromDo)
 * and that writer only fires from inside a delivery-order ROUTE, so an import
 * script or a backfill leaves it stale for ever — nothing recomputes it on read,
 * on a schedule, or in the database. Which is why the disagreement has to be
 * SHOWN rather than resolved: the stored value still decides which TAB counts
 * the row, so silently rendering the derived answer would file a row under a tab
 * its own pill contradicts, with nothing on screen saying why.
 *
 * `soRowStatus` is wired to the REAL `soStatusDisplay` here, not to a stand-in.
 * A test that passes its own derive function proves the plumbing and nothing
 * about the answer.
 *
 * Traced in docs/bugs/0619.
 */
import { describe, expect, it } from "vitest";
import { soRowStatus } from "./so-list-status";
import { soStatusDisplay } from "../../vendor/scm/lib/so-status";
import { shippedProgressOf } from "../../vendor/scm/lib/shipped-progress";

const row = (o: Partial<Parameters<typeof soRowStatus>[0]> = {}) =>
  soRowStatus({ status: "IN_PRODUCTION", ...o }, soStatusDisplay);

describe("soRowStatus", () => {
  it("shows the derived answer when the goods have gone out", () => {
    const r = row({ delivery_state: "full", lifecycle_state: "delivered" });
    expect(r.label).toBe("Delivered");
  });

  it("and SAYS the stored status disagrees, because that is the tab it sits under", () => {
    const r = row({ delivery_state: "full", lifecycle_state: "delivered" });
    expect(r.storedLabel).toBe("In Production");
  });

  it("a partial delivery reads Partially Delivered, not Delivered", () => {
    const r = row({ delivery_state: "partial", lifecycle_state: "delivered" });
    expect(r.label).toBe("Partially Delivered");
    expect(r.storedLabel).toBe("In Production");
  });

  it("no marker when the two agree — the marker must mean something", () => {
    const r = soRowStatus(
      { status: "DELIVERED", delivery_state: "full", lifecycle_state: "delivered" },
      soStatusDisplay,
    );
    expect(r.label).toBe("Delivered");
    expect(r.storedLabel).toBeNull();
  });

  /* MISSING IS NOT "NOTHING SHIPPED". An older cached bundle carries neither
     field, and reading that as delivery_state 'none' would assert a fact about
     the goods that nobody established — the same refusal shipped-progress.ts
     makes with its own `unknown`. */
  it("a payload with neither field falls back to the stored status, with no marker", () => {
    const r = row();
    expect(r.label).toBe("In Production");
    expect(r.storedLabel).toBeNull();
  });

  it("a terminal status is left alone — nothing is derived over Cancelled", () => {
    const r = soRowStatus(
      { status: "CANCELLED", delivery_state: "full", lifecycle_state: "delivered" },
      soStatusDisplay,
    );
    expect(r.label).toBe("Cancelled");
    expect(r.storedLabel).toBeNull();
  });

  it("an On Hold order keeps its stored answer — the hold is the thing to show", () => {
    const r = soRowStatus({ status: "ON_HOLD", delivery_state: "full" }, soStatusDisplay);
    expect(r.storedLabel).toBeNull();
  });

  it("carries a usable tone, never an empty pill", () => {
    for (const s of ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "DELIVERED", "INVOICED", "CLOSED"]) {
      const r = soRowStatus({ status: s }, soStatusDisplay);
      expect(r.label, `${s} rendered an empty label`).toBeTruthy();
      expect(["success", "warning", "error", "neutral"]).toContain(r.tone);
    }
  });

  /* THE REGRESSION THIS FILE EXISTS FOR, stated as the two cells rather than as
     an implementation. If the pill ever goes back to reading the stored column,
     this is the assertion that fails. */
  it("the pill and the Delivered column cannot disagree about a fully shipped order", () => {
    /* ONE ROW, BOTH CELLS, BOTH REAL FUNCTIONS. The Delivered column runs
       shippedProgressOf over shipped_qty / deliverable_qty (#2864); the pill
       runs soRowStatus over the derived state on the same response. This is the
       assertion that fails if either ever goes back to reading the stored
       column on its own. */
    const soRow = {
      status: "IN_PRODUCTION",
      delivery_state: "full" as const,
      lifecycle_state: "delivered" as const,
      shipped_qty: 5,
      deliverable_qty: 5,
    };
    expect(shippedProgressOf(soRow).state).toBe("full");
    expect(soRowStatus(soRow, soStatusDisplay).label).toBe("Delivered");
  });

  it("...and both read a partial shipment as partial", () => {
    const soRow = {
      status: "IN_PRODUCTION",
      delivery_state: "partial" as const,
      lifecycle_state: "delivered" as const,
      shipped_qty: 2,
      deliverable_qty: 5,
    };
    expect(shippedProgressOf(soRow).state).toBe("partial");
    expect(soRowStatus(soRow, soStatusDisplay).label).toBe("Partially Delivered");
  });
});
