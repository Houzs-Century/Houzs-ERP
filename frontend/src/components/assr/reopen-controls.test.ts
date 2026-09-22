/* The desktop (ReopenCaseControl) and mobile (MobileReopenControl) reopen
 * controls are two presentations of the same action. This pins the two things
 * that must not drift between them: they both POST /reopen, both show only on a
 * completed/voided case, and both offer the SAME reopen-stage options in the
 * SAME order (the values the backend REOPEN_STAGES validates). */
import { describe, expect, test } from "vitest";
import desktopRaw from "./ReopenCaseControl.tsx?raw";
import mobileRaw from "../../mobile/MobileReopenControl.tsx?raw";

const stageValues = (src: string): string[] =>
  [...src.matchAll(/\{ value: "([a-z_]+)", label:/g)].map((m) => m[1]);

describe("reopen controls agree across surfaces", () => {
  test("both POST /reopen", () => {
    expect(desktopRaw).toContain("/reopen`");
    expect(mobileRaw).toContain("/reopen`");
  });

  test("both show only on a completed/voided case", () => {
    for (const src of [desktopRaw, mobileRaw]) {
      expect(src).toMatch(/stage === "completed" \|\| stage === "voided"/);
    }
  });

  test("both offer the same three stage options in the same order", () => {
    const d = stageValues(desktopRaw);
    const m = stageValues(mobileRaw);
    expect(d).toEqual(["under_verification", "pending_solution", "pending_review"]);
    expect(m).toEqual(d);
  });
});
