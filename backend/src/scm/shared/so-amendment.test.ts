// Port of 2990 packages/shared/src/so-amendment.test.ts, alongside the port of
// so-amendment.ts itself. The two implementations are byte-identical apart from
// so-amendment.ts's header comment, so this suite ports 1:1 — no adaptation.
//
// Why it is worth porting rather than assuming: this state machine is the ONLY
// thing standing between a locked SO and an out-of-order transition, and it was
// the one axis where 2990 was genuinely ahead of us (it had this test; we had
// none). Houzs has since diverged UPWARDS from 2990 on amendments — mig 0119's
// header_changes / old_header_snapshot, company scoping, the mirror write guard
// — but every one of those sits in the ROUTE layer. The transitions below are
// the shared floor, and a silent edit to FLOW would otherwise be caught by
// nothing.

import { describe, it, expect } from "vitest";
import { nextStatus, canTransition, receivedFloorViolation, type AmendStatus } from "./so-amendment";

describe("so-amendment state machine", () => {
  it("allows the happy path in order", () => {
    expect(canTransition("REQUESTED", "supplier-confirm")).toBe(true);
    expect(canTransition("SUPPLIER_PENDING", "approve-so")).toBe(true);
    expect(canTransition("SO_APPROVED", "approve-po")).toBe(true);
    expect(canTransition("PO_APPROVED", "send")).toBe(true);
  });
  it("blocks out-of-order transitions", () => {
    expect(canTransition("REQUESTED", "approve-po")).toBe(false);
    expect(canTransition("SENT", "reject")).toBe(false);
  });
  it("allows reject from any pre-approved gate", () => {
    for (const s of ["REQUESTED", "SUPPLIER_PENDING", "SO_APPROVED", "PO_APPROVED"] as AmendStatus[])
      expect(canTransition(s, "reject")).toBe(true);
  });
  it("nextStatus maps each action", () => {
    expect(nextStatus("REQUESTED", "supplier-confirm")).toBe("SUPPLIER_PENDING");
    expect(nextStatus("SUPPLIER_PENDING", "approve-so")).toBe("SO_APPROVED");
  });
  it("flags a line dropping below received qty", () => {
    expect(receivedFloorViolation({ newQty: 1 }, { receivedQty: 3 })).toBe(true);
    expect(receivedFloorViolation({ newQty: 5 }, { receivedQty: 3 })).toBe(false);
    expect(receivedFloorViolation({ newQty: null }, { receivedQty: 3 })).toBe(false);
  });
});

/* Owner 2026-07-19 — withdraw. The REQUESTER pulling their own request back, as
   distinct from an approver refusing it. Before this the person who raised a
   mistaken amendment could neither correct it nor close it (reject is gated to
   scm.amendment.approve_po, which a salesperson does not hold), so their only
   move was to raise ANOTHER one — and one Sales Order ended up carrying two or
   three competing amendment documents with nothing to say which was
   authoritative.

   The design decision these pin: withdraw is NOT a new status. It lands on the
   same terminal REJECTED, because that is what releases uq_so_amendment_open so
   a corrected request can be raised immediately. Anything that gave it a status
   of its own would silently keep the order wedged. */
describe("withdraw", () => {
  it("closes a still-REQUESTED amendment", () => {
    expect(canTransition("REQUESTED", "withdraw")).toBe(true);
    expect(nextStatus("REQUESTED", "withdraw")).toBe("REJECTED");
  });

  it("lands on the SAME terminal state as reject, so the order is freed", () => {
    expect(nextStatus("REQUESTED", "withdraw")).toBe(nextStatus("REQUESTED", "reject"));
  });

  it("is refused once anyone has acted on the amendment", () => {
    // Retracting after a supplier has been told, or after either gate approved,
    // would erase work somebody else did. From there the route is reject.
    for (const s of ["SUPPLIER_PENDING", "SO_APPROVED", "PO_APPROVED"] as AmendStatus[]) {
      expect(canTransition(s, "withdraw")).toBe(false);
      expect(nextStatus(s, "withdraw")).toBeNull();
    }
  });

  it("cannot reopen a closed amendment", () => {
    expect(canTransition("REJECTED", "withdraw")).toBe(false);
    expect(canTransition("SENT", "withdraw")).toBe(false);
  });

  it("leaves every pre-existing transition untouched", () => {
    expect(canTransition("REQUESTED", "supplier-confirm")).toBe(true);
    expect(canTransition("SUPPLIER_PENDING", "approve-so")).toBe(true);
    expect(canTransition("SO_APPROVED", "approve-po")).toBe(true);
    expect(canTransition("PO_APPROVED", "send")).toBe(true);
    expect(canTransition("REQUESTED", "reject")).toBe(true);
  });
});
