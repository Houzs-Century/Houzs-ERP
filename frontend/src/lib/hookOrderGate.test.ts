import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eslint.config.mjs");

function settingFor(source: string, rule: string): string | null {
  const m = new RegExp(String.raw`['"]${rule.replace("/", "\\/")}['"]\s*:\s*['"](\w+)['"]`).exec(source);
  return m ? m[1] : null;
}

describe("react-hooks/rules-of-hooks stays enforced", () => {
  const source = readFileSync(CONFIG, "utf8");

  it("has a matcher that actually matches this config", () => {
    expect(settingFor(source, "react-hooks/exhaustive-deps")).toBe("off");
  });

  it("keeps rules-of-hooks at error", () => {
    expect(settingFor(source, "react-hooks/rules-of-hooks")).toBe("error");
  });

  it("does not let the rule be downgraded to a ratcheted warning", () => {
    expect(settingFor(source, "react-hooks/rules-of-hooks")).not.toBe("warn");
  });
});
