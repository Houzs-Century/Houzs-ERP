import { describe, expect, test } from "vitest";
import { SO_STATUSES, SO_STATUS_RANK, soStatusTransitionError } from "./so-lifecycle-guards";

describe("CLOSED — stop chasing the remainder", () => {
  const LIVE = [
    "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP",
    "SHIPPED", "DELIVERED", "INVOICED", "ON_HOLD",
  ];

  test("the route accepts CLOSED as a target again", () => {
    expect(SO_STATUSES.has("CLOSED")).toBe(true);
  });

  test("CLOSED is not on the ranked forward spine", () => {
    expect(SO_STATUS_RANK.CLOSED).toBeUndefined();
  });

  test.each(LIVE)("an order can be closed from %s", (from) => {
    expect(soStatusTransitionError(from, "CLOSED")).toBeNull();
  });

  test.each(["DRAFT", "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "INVOICED"])(
    "a closed order cannot be walked back into %s",
    (to) => {
      const err = soStatusTransitionError("CLOSED", to);
      expect(err, `CLOSED>${to} must be refused`).not.toBeNull();
      expect(err!.error).toBe("illegal_status_transition");
      expect(err!.code).toBe(409);
    },
  );

  test("CLOSED > ON_HOLD is refused as 'the hold is not a status'", () => {
    const err = soStatusTransitionError("CLOSED", "ON_HOLD");
    expect(err).not.toBeNull();
    expect(err!.error).toBe("hold_is_not_a_status");
    expect(err!.code).toBe(409);
  });

  /* THE HOLD IS ORTHOGONAL AND NO GATE WAS ADDED EITHER WAY. `PATCH
     /:docNo/hold` never writes `status` (document-hold-route.ts says so in its
     header and deliberately does not gate on status), and this function only
     ever sees the status string — so a held order can be closed and a closed
     order can be marked held. Both are recorded in
     docs/modules/document-status-vocabulary.md rather than blocked. */
  test("a legacy held row can still be closed", () => {
    expect(soStatusTransitionError("ON_HOLD", "CLOSED")).toBeNull();
  });

  test("a closed order can still be cancelled", () => {
    expect(soStatusTransitionError("CLOSED", "CANCELLED")).toBeNull();
  });

  test("closing an already-closed order is an idempotent no-op", () => {
    expect(soStatusTransitionError("CLOSED", "CLOSED")).toBeNull();
  });
});
