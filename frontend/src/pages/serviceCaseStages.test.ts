import { describe, expect, test } from "vitest";
import { NEXT_STAGE, STAGE_FUNNEL_DESC } from "./serviceCaseStages";

describe("service case stage flow", () => {
  test("the advance chain walks the whole pipeline and terminates at completed", () => {
    const seen: string[] = [];
    let stage = "pending_review";
    const nextOf = (s: string): (typeof NEXT_STAGE)[string] | undefined => NEXT_STAGE[s];
    for (let next = nextOf(stage); next; next = nextOf(stage)) {
      expect(seen).not.toContain(stage);
      seen.push(stage);
      stage = next.stage;
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
