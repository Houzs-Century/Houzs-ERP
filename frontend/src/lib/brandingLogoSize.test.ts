import { describe, expect, it } from "vitest";
import { LETTERHEAD_MAX_PX, letterheadScale } from "./branding";


describe("letterhead logo sizing", () => {
  it("leaves a sensibly sized logo completely alone", () => {
    expect(letterheadScale(480, 192)).toBe(1);
    expect(letterheadScale(300, 120)).toBe(1);
    expect(letterheadScale(0, 0)).toBe(1);
  });

  it("shrinks the real 2990 upload to something a letterhead can use", () => {
    const scale = letterheadScale(3508, 1561);
    const w = Math.round(3508 * scale);
    const h = Math.round(1561 * scale);

    expect(w).toBeLessThanOrEqual(LETTERHEAD_MAX_PX.width);
    expect(h).toBeLessThanOrEqual(LETTERHEAD_MAX_PX.height);
    expect(w / h).toBeCloseTo(3508 / 1561, 2);

    const before = 3508 * 1561 * 4;
    const after = w * h * 4;
    expect(before / after).toBeGreaterThan(50);
  });

  it("fits by whichever edge is tighter, not always the width", () => {
    const scale = letterheadScale(600, 1200);
    expect(Math.round(1200 * scale)).toBeLessThanOrEqual(LETTERHEAD_MAX_PX.height);
    expect(Math.round(600 * scale)).toBeLessThanOrEqual(LETTERHEAD_MAX_PX.width);
    expect(scale).toBe(LETTERHEAD_MAX_PX.height / 1200);
  });
});
