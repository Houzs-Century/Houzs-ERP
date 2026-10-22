import { describe, expect, test } from "vitest";
import { isFloorplanTitle } from "../src/services/floorplanSize";

/* Which checklist items can supply the Size (sqm).
 *
 * Owner 2026-09-30: "auto trigger and key in size when there is a size at
 * unfilled floorplan, 3D or Display". Before this, only Display Floor Plan and
 * Blank Floorplan were read, so a measurement printed on the 3D was ignored.
 *
 * This pins the TRIGGER half (which upload starts a read). The candidate query
 * inside detectFloorplanSize uses the same three titles; they are kept next to
 * each other in the source for that reason. */

describe("floorplan size — which uploads trigger a read", () => {
  test("the three size-bearing tasks do", () => {
    for (const title of [
      "Display Floor Plan",
      "Blank Floorplan",
      "3D Design",
      // Operators append their own suffixes; prefix match must survive them.
      "3D Design — final",
      "Display Floor Plan (revised)",
    ]) {
      expect(isFloorplanTitle(title), `${title} must trigger a size read`).toBe(true);
    }
  });

  test("other checklist tasks do not", () => {
    for (const title of [
      "Filled Floorplan", // the post-event one: no booth dimensions on it
      "2D Design",
      "Setup Image",
      "Stock Out Transfer Record",
      "Agreement / Quotation",
      "",
      null,
    ]) {
      expect(isFloorplanTitle(title), `${title} must not trigger a size read`).toBe(false);
    }
  });
});
