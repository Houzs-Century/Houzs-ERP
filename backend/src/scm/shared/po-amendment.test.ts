// Pure state-machine coverage for the PO amendment workflow — sibling of
// so-amendment.test.ts. The simplified lifecycle (REQUESTED -> APPROVED, with
// REJECTED as the terminal close for both reject and withdraw) is the ONLY thing
// standing between a Purchase Order and an out-of-order transition, so a silent
// edit to FLOW must be caught here.

import { describe, it, expect } from "vitest";
import {
  nextStatus,
  canTransition,
  actionTargetStatus,
  poReceivedFloorViolation,
  type PoAmendStatus,
} from "./po-amendment";

describe("po-amendment state machine", () => {
  it("allows approve / reject / withdraw only from REQUESTED", () => {
    expect(canTransition("REQUESTED", "approve")).toBe(true);
    expect(canTransition("REQUESTED", "reject")).toBe(true);
    expect(canTransition("REQUESTED", "withdraw")).toBe(true);
  });

  it("blocks every action once the amendment is closed", () => {
    for (const s of ["APPROVED", "REJECTED"] as PoAmendStatus[]) {
      expect(canTransition(s, "approve")).toBe(false);
      expect(canTransition(s, "reject")).toBe(false);
      expect(canTransition(s, "withdraw")).toBe(false);
    }
  });

  it("approve lands on APPROVED", () => {
    expect(nextStatus("REQUESTED", "approve")).toBe("APPROVED");
    expect(actionTargetStatus("approve")).toBe("APPROVED");
  });

  it("reject and withdraw both land on the SAME terminal REJECTED (frees the PO)", () => {
    expect(nextStatus("REQUESTED", "reject")).toBe("REJECTED");
    expect(nextStatus("REQUESTED", "withdraw")).toBe("REJECTED");
    expect(nextStatus("REQUESTED", "withdraw")).toBe(nextStatus("REQUESTED", "reject"));
  });

  it("nextStatus is null for a disallowed transition", () => {
    expect(nextStatus("APPROVED", "approve")).toBeNull();
    expect(nextStatus("REJECTED", "withdraw")).toBeNull();
  });

  it("flags a revised line dropping below received qty", () => {
    expect(poReceivedFloorViolation({ newQty: 1 }, { receivedQty: 3 })).toBe(true);
    expect(poReceivedFloorViolation({ newQty: 5 }, { receivedQty: 3 })).toBe(false);
    expect(poReceivedFloorViolation({ newQty: null }, { receivedQty: 3 })).toBe(false);
  });
});
