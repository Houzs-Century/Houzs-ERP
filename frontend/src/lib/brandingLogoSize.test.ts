import { describe, expect, it } from "vitest";
import { LETTERHEAD_MAX_PX, letterheadScale } from "./branding";

/* ────────────────────────────────────────────────────────────────────────────
   jsPDF embeds a logo bitmap RAW — uncompressed — into EVERY document it
   draws. The 2990 branding upload was 3508 x 1561: 16.4 MB of pixels plus
   5.5 MB of alpha, which is why one Delivery Order PDF weighed 21 MB and
   could not be emailed (measured on prod's 2990-DO-2608-006, 2026-08-03).

   The letterhead draws that logo inside 40mm x 16mm. These pin the arithmetic
   that decides how far to shrink it; the canvas re-encode itself cannot run
   in jsdom.
   ──────────────────────────────────────────────────────────────────────────── */

describe("letterhead logo sizing", () => {
  it("leaves a sensibly sized logo completely alone", () => {
    // scale 1 means the pixels are passed through with no re-encode at all.
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
    // Aspect ratio is what the letterhead scales by, so it must survive.
    expect(w / h).toBeCloseTo(3508 / 1561, 2);

    // The point of the exercise: raw bytes per document (RGB + alpha).
    const before = 3508 * 1561 * 4;
    const after = w * h * 4;
    expect(before / after).toBeGreaterThan(50);
  });

  it("fits by whichever edge is tighter, not always the width", () => {
    // A TALL logo: constrained by height, and the width must follow it down
    // rather than being clamped independently (which would distort it).
    const scale = letterheadScale(600, 1200);
    expect(Math.round(1200 * scale)).toBeLessThanOrEqual(LETTERHEAD_MAX_PX.height);
    expect(Math.round(600 * scale)).toBeLessThanOrEqual(LETTERHEAD_MAX_PX.width);
    expect(scale).toBe(LETTERHEAD_MAX_PX.height / 1200);
  });
});
