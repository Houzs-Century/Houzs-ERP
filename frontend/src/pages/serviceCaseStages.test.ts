import { describe, expect, test } from "vitest";
import { NEXT_STAGE, STAGE_FUNNEL_DESC } from "./serviceCaseStages";

// Pins the Nico-approved pipeline order (2026-08-11): Review → Solution →
// Verification → Supplier → Item Ready → Delivery → Completed. A future
// reorder must consciously rewrite this chain, not drift it.
describe("service case stage flow", () => {
  test("the advance chain walks the whole pipeline and terminates at completed", () => {
    const seen: string[] = [];
    let stage = "pending_review";
    while (NEXT_STAGE[stage]) {
      expect(seen).not.toContain(stage); // no cycles
      seen.push(stage);
      stage = NEXT_STAGE[stage].stage;
    }
    expect(stage).toBe("completed");
    expect(seen).toEqual([
      "pending_review",
      "pending_solution",
      "under_verification",
      "pending_supplier_pickup",
      "pending_item_ready",
      "pending_delivery_service",
    ]);
  });

  test("every stage in the chain carries funnel copy, and each advance has a label", () => {
    for (const [stage, next] of Object.entries(NEXT_STAGE)) {
      expect(STAGE_FUNNEL_DESC[stage], stage).toBeTruthy();
      expect(next.label).toBeTruthy();
    }
    expect(STAGE_FUNNEL_DESC.completed).toBeTruthy();
  });
});
