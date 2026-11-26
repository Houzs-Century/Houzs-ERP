import { describe, expect, test } from "vitest";


const sources = import.meta.glob(
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
    expect(responseWindows(src).some((w) => /email_status/.test(w))).toBe(true);
  });

  test("tells the admin the account is unchanged until the member clicks", () => {
    const w = confirmWindows(src).join("\n");
    expect(w).not.toMatch(/sessions will be logged out/i);
    expect(w).not.toMatch(/sessions are logged out/i);
    expect(w).toMatch(/[Nn]othing changes/);
  });
});
