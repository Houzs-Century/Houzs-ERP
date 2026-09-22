/* The desktop (ReopenCaseControl) and mobile (MobileReopenControl) reopen
 * controls are two presentations of the same action. The stage choices now live
 * in ONE shared module (vendor/scm/lib/assr/reopen), so this pins: both surfaces
 * import that list rather than defining their own, both POST /reopen, and both
 * show only on a completed/voided case. The shared values are the slugs the
 * backend REOPEN_STAGES validates (assrReopen.test.ts pins that side). */
import { describe, expect, test } from "vitest";
import desktopRaw from "./ReopenCaseControl.tsx?raw";
import mobileRaw from "../../mobile/MobileReopenControl.tsx?raw";
import { REOPEN_STAGE_OPTIONS } from "../../vendor/scm/lib/assr/reopen";

describe("reopen controls agree across surfaces", () => {
  test("the shared list offers the three assessment stages", () => {
    expect(REOPEN_STAGE_OPTIONS.map((o) => o.value)).toEqual([
      "under_verification",
      "pending_solution",
      "pending_review",
    ]);
  });

  test("both surfaces render the SHARED list, not their own copy", () => {
    for (const src of [desktopRaw, mobileRaw]) {
      expect(src).toContain("REOPEN_STAGE_OPTIONS");
      expect(src).toContain("vendor/scm/lib/assr/reopen");
      // no locally-defined stage list on either surface
      expect(src).not.toMatch(/value: "under_verification", label:/);
    }
  });

  test("both POST /reopen", () => {
    expect(desktopRaw).toContain("/reopen`");
    expect(mobileRaw).toContain("/reopen`");
  });

  test("both show only on a completed/voided case", () => {
    for (const src of [desktopRaw, mobileRaw]) {
      expect(src).toMatch(/stage === "completed" \|\| stage === "voided"/);
    }
  });
});
