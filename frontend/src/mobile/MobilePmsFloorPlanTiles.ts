// Which "Floor plans & layout" tiles a mobile cohort sees — ONE rule, so the
// card's filter and its test cannot drift apart.
//
// Owner 2026-09-15 (crew = driver/helper/storekeeper): "untuk part ni nk ada
// display floorplan and stock out saja, lain remove" — the crew card keeps the
// Display tile; 3D Design, 2D Design, Unfilled and Filled all go. This
// supersedes the 2026-07-21 rule that hid only the Filled tile from crew.
// Owner 2026-07-23 (ops/office cohort + purchaser view): the Unfilled/Filled
// plan tiles are for sales/SD/mgt/BD only; Display + 3D/2D stay.
// The stock-transfer records under the grid are not tiles and are untouched.

export type FloorPlanTileKey = "Display" | "3D Design" | "2D Design" | "Unfilled" | "Filled";

export interface FloorPlanTileGate {
  /** driver / helper / storekeeper */
  crewPlanView?: boolean;
  /** ops/office cohort + purchaser view */
  hidePlanTiles?: boolean;
}

export const floorPlanTileVisible = (key: FloorPlanTileKey, gate: FloorPlanTileGate): boolean => {
  if (gate.crewPlanView) return key === "Display";
  if (gate.hidePlanTiles) return key !== "Unfilled" && key !== "Filled";
  return true;
};
