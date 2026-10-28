// ----------------------------------------------------------------------------
// The `react-hooks/rules-of-hooks` rule must stay ON at error level.
//
// WHY THIS TEST EXISTS AND NOT ONLY THE LINT JOB. The rule is what catches a
// hook called after a conditional `return` — the shape that made a Purchase
// Order, Purchase Invoice or Goods Receipt opened by direct URL / refresh die
// with React error #310 ("rendered more hooks than during the previous
// render"), showing "Something went wrong loading this page." Ten components
// were in that state on 2026-08-17 and nothing said a word, because the plugin
// was registered with every rule set to 'off'.
//
// ESLint does catch it now — but `lint` is its OWN CI job and is NOT one of the
// required status checks (`backend-typecheck` + `frontend`), so a red lint run
// does not block a merge. This test runs in `npm run test:coverage`, which
// `frontend-checks` runs, which the required `frontend` roll-up covers. So
// flipping the rule back to 'off' fails a check that actually stops the merge.
// Same reasoning as backend/tests/classifyTests.test.mjs: if an assertion must
// BLOCK a merge, it has to live in a required context.
// ----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eslint.config.mjs");

/** The rule's setting, or null when the rule is not configured at all. */
function settingFor(source: string, rule: string): string | null {
  const m = new RegExp(String.raw`['"]${rule.replace("/", "\\/")}['"]\s*:\s*['"](\w+)['"]`).exec(source);
  return m ? m[1] : null;
}

describe("react-hooks/rules-of-hooks stays enforced", () => {
  const source = readFileSync(CONFIG, "utf8");

  // CLAUDE.md: "a checker that cannot match reports a clean run". Prove the
  // matcher can see a rule in this file at all before trusting what it says
  // about the one that matters — exhaustive-deps is deliberately 'off' and is
  // therefore a live negative control, not a placeholder.
  it("has a matcher that actually matches this config", () => {
    expect(settingFor(source, "react-hooks/exhaustive-deps")).toBe("off");
  });

  it("keeps rules-of-hooks at error", () => {
    expect(settingFor(source, "react-hooks/rules-of-hooks")).toBe("error");
  });

  // A ratcheted WARNING would let every existing violation sit at its ceiling
  // and only stop new ones in files the manifest has never seen. Every
  // violation of this rule is a page that crashes, so it has to be a hard
  // ESLint error — lint-ratchet.mjs routes severity-2 messages to `hardErrors`,
  // which never ratchet and are never advisory.
  it("does not let the rule be downgraded to a ratcheted warning", () => {
    expect(settingFor(source, "react-hooks/rules-of-hooks")).not.toBe("warn");
  });
});
