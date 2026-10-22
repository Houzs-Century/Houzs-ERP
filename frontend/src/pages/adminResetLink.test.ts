import { describe, expect, test } from "vitest";

/* The client half of the admin "send reset link" invariant.
 *
 * The backend no longer returns the reset token (pinned in
 * backend/tests/adminResetLink.test.ts). This pins the other end: neither admin
 * screen may put a reset link in the admin's hands. Both used to — on every
 * SUCCESSFUL send, not merely as an email-is-down fallback — which meant any
 * holder of `users.manage` walked away with a working one-hour credential for
 * the account they had just "helped", including accounts more privileged than
 * their own. The audit row said a reset was issued; it could not say who used it.
 *
 * Kept as a source test for the same reason as its backend twin: the regression
 * is a two-line convenience that reads as helpful in review, so it needs a red
 * test rather than a comment. Team.tsx legitimately copies INVITE links, so the
 * assertions are scoped to a window around the reset call rather than the file.
 *
 * import.meta.glob (not fs) so this stays runnable under any vitest environment
 * the suite is configured with, and so a path that stops resolving fails loudly
 * on the emptiness assertions below instead of silently passing on "".
 */

const sources = import.meta.glob(
  // The three admin surfaces that can send a reset link: the classic Team page,
  // the member-profile drawer, and the mobile member actions (extracted from
  // MobileModuleDetail to keep that file under its size ceiling).
  ["./Team.tsx", "./team/TeamMemberProfile.tsx", "../mobile/MemberAccountActions.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const screens = Object.entries(sources);

describe("the admin reset screens were actually loaded", () => {
  test("all files resolved and are non-trivial", () => {
    expect(screens.length).toBe(3);
    for (const [, src] of screens) expect(src.length).toBeGreaterThan(1000);
  });

  test("all call the reset endpoint", () => {
    for (const [, src] of screens) expect(src).toContain("reset-password");
  });
});

/* TWO window sizes, because the two questions live at different distances from
   the call and a single wide window is not free: at ±1400 the Team.tsx window
   swallowed the neighbouring `impersonate` handler and its unrelated
   `res.token`, i.e. it failed on code that has nothing to do with resets. A
   test that reports the wrong function is worse than a narrower one.

   RESPONSE window — tight, forward-biased: what this call does with what came
   back. Everything asserted here happens within a few lines of the api.post.
   CONFIRM window — wider, backward-biased: the dialog copy sits at the top of
   the enclosing function, before the call. */
function windows(src: string, back: number, fwd: number): string[] {
  const out: string[] = [];
  let i = src.indexOf("reset-password");
  while (i !== -1) {
    out.push(src.slice(Math.max(0, i - back), i + fwd));
    i = src.indexOf("reset-password", i + 1);
  }
  return out;
}

const responseWindows = (src: string) => windows(src, 120, 900);
const confirmWindows = (src: string) => windows(src, 1400, 400);

describe.each(screens)("%s", (_path, src) => {
  test("never writes a reset link to the clipboard", () => {
    for (const w of responseWindows(src)) {
      expect(w).not.toMatch(/clipboard/i);
      expect(w).not.toMatch(/copyLink\(/);
    }
  });

  test("never reads a token or a reset path off the response", () => {
    for (const w of responseWindows(src)) {
      expect(w).not.toMatch(/reset_path/);
      expect(w).not.toMatch(/\.token\b/);
    }
  });

  test("still reports delivery status, so a disabled channel is not read as success", () => {
    // The whole point of keeping email_status: "not sent" must be visible, or an
    // admin walks away believing a colleague was emailed when nothing left.
    expect(responseWindows(src).some((w) => /email_status/.test(w))).toBe(true);
  });

  test("tells the admin the account is unchanged until the member clicks", () => {
    // The old copy promised a logout the old handler really performed. If the
    // confirm text ever promises a state change again, either the copy is lying
    // or the handler regressed — both worth a red test.
    const w = confirmWindows(src).join("\n");
    expect(w).not.toMatch(/sessions will be logged out/i);
    expect(w).not.toMatch(/sessions are logged out/i);
    expect(w).toMatch(/[Nn]othing changes/);
  });
});
