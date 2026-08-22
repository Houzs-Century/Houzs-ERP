import { describe, expect, test } from "vitest";
import { SO_STATUSES, SO_STATUS_RANK, soStatusTransitionError } from "./so-lifecycle-guards";

/* CLOSE = STOP CHASING THE REMAINDER. The customer took 7 of the 10 he ordered,
   or the supplier cannot supply the rest; the three that never shipped stop
   being chased and the document STAYS, because the seven were really sold.
   It is not Cancel — Cancel voids the whole document as if it never happened.

   These tests pin the half that is easy to get wrong: a status that is enterable
   from anywhere must not become a way OUT of itself, which is the hole ON_HOLD
   already dug in this file. */
describe("CLOSED — stop chasing the remainder", () => {
  const LIVE = [
    "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP",
    "SHIPPED", "DELIVERED", "INVOICED", "ON_HOLD",
  ];

  test("the route accepts CLOSED as a target again", () => {
    expect(SO_STATUSES.has("CLOSED")).toBe(true);
  });

  /* UNRANKED ON PURPOSE. A rank would say CLOSED comes after INVOICED, and it
     does not: an order is closed from wherever it had got to, and most of them
     never reach INVOICED at all. Same treatment CANCELLED and ON_HOLD get. */
  test("CLOSED is not on the ranked forward spine", () => {
    expect(SO_STATUS_RANK.CLOSED).toBeUndefined();
  });

  test.each(LIVE)("an order can be closed from %s", (from) => {
    expect(soStatusTransitionError(from, "CLOSED")).toBeNull();
  });

  /* THE HOLE THIS FILE ALREADY PAID FOR, one status over. ON_HOLD was unranked
     and written as an unconditional `return null` on BOTH edges, which made it a
     laundry: DELIVERED>ON_HOLD>DRAFT walked an order to the one status that
     unlocks the cascading DELETE. An unranked CLOSED written the same way would
     be the same laundry with a different name. */
  test.each(["DRAFT", ...LIVE])("a closed order cannot be walked back into %s", (to) => {
    const err = soStatusTransitionError("CLOSED", to);
    expect(err, `CLOSED>${to} must be refused`).not.toBeNull();
    expect(err!.error).toBe("illegal_status_transition");
    expect(err!.code).toBe(409);
  });

  /* Cancel stays reachable. Closing says the delivered part stands; if it turns
     out nothing stands, the cancel guards — not this table — own that call. */
  test("a closed order can still be cancelled", () => {
    expect(soStatusTransitionError("CLOSED", "CANCELLED")).toBeNull();
  });

  test("closing an already-closed order is an idempotent no-op", () => {
    expect(soStatusTransitionError("CLOSED", "CLOSED")).toBeNull();
  });
});
