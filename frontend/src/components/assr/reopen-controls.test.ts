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
