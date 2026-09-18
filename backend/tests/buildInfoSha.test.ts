// GET /health's build-stamp resolution (2026-09-01). /health reports which
// commit the Worker was built from, and the Deploy watchdog compares it to main
// to catch a rogue/stale prod overwrite. The stamp now comes from a value baked
// into the bundle (build-info.ts) rather than a `--var GIT_SHA` env, because the
// post-deploy `wrangler secret bulk` could drop the CLI var and leave the stamp
// null. resolveBuildSha is the precedence these tests pin.
import { describe, expect, test } from "vitest";
import { resolveBuildSha } from "../src/build-info";

describe("resolveBuildSha — the /health stamp precedence", () => {
  test("a real bundled sha wins over everything", () => {
    expect(resolveBuildSha("abc123", "env-sha")).toBe("abc123");
    expect(resolveBuildSha("abc123", null)).toBe("abc123");
  });

  test('the "dev" placeholder falls back to the legacy env var', () => {
    expect(resolveBuildSha("dev", "env-sha")).toBe("env-sha");
  });

  test("no bundled stamp and no env → null (what the watchdog reads as un-stamped)", () => {
    expect(resolveBuildSha("dev", null)).toBeNull();
    expect(resolveBuildSha("dev", undefined)).toBeNull();
  });
});
