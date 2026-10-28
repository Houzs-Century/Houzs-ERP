/* The per-cohort tile rule for the mobile "Floor plans & layout" card.
 *
 * Owner 2026-09-15, on a helper's phone showing Display / 3D Design / 2D Design
 * / Unfilled plan: "untuk part ni nk ada display floorplan and stock out saja,
 * lain remove from helper storekeeper and driver mobilepms". So crew see ONE
 * tile. The other two cohorts' rules are pinned alongside so the crew change
 * cannot quietly widen or narrow them.
 */
import { describe, expect, test } from "vitest";

import { floorPlanTileVisible, type FloorPlanTileGate, type FloorPlanTileKey } from "./MobilePmsFloorPlanTiles";

const ALL: FloorPlanTileKey[] = ["Display", "3D Design", "2D Design", "Unfilled", "Filled"];
const visible = (gate: FloorPlanTileGate): FloorPlanTileKey[] => ALL.filter((k) => floorPlanTileVisible(k, gate));

describe("floorPlanTileVisible", () => {
  test("crew (driver / helper / storekeeper) see ONLY the Display tile — owner 2026-09-15", () => {
    expect(visible({ crewPlanView: true })).toEqual(["Display"]);
  });

  test("the crew rule holds even when the ops gate is also raised", () => {
    expect(visible({ crewPlanView: true, hidePlanTiles: true })).toEqual(["Display"]);
  });

  test("ops/office + purchaser lose only the Unfilled / Filled plan tiles — owner 2026-07-23", () => {
    expect(visible({ hidePlanTiles: true })).toEqual(["Display", "3D Design", "2D Design"]);
  });

  test("sales / management / BD see all five", () => {
    expect(visible({})).toEqual(ALL);
  });
});
