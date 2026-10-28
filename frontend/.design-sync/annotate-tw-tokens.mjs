// Tag Tailwind runtime variables (--tw-translate-x, --tw-shadow, …) in the
// compiled tailwind-built.css with `/* @kind other */` so claude.ai/design's
// check_design_system stops classifying them as design tokens. They are
// compiler output needed at render time (transforms/shadows/rings), not
// design sources — the real tokens live in src/vendor/design-system/tokens.css.
// Runs as a buildCmd post-step (see .design-sync/config.json); idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("./tailwind-built.css", import.meta.url);
const MARK = "/* @kind other */";
// Strip any marks from a previous run, then re-annotate — keeps the step
// idempotent no matter how often the buildCmd re-runs.
const css = readFileSync(path, "utf8").split(MARK).join("");
// Match each --tw-* declaration (values never contain ; { }). The minified
// output drops the semicolon before `}`, so handle both terminators.
const next = css.replace(
  /(--tw-[a-z0-9-]+\s*:[^;{}]*)(;?)/g,
  (_, decl, semi) => decl + semi + MARK,
);
writeFileSync(path, next);
console.error(
  `annotate-tw-tokens: ${(next.match(/\/\* @kind other \*\//g) ?? []).length} --tw-* declarations tagged`,
);
