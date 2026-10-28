// Test helper shared by the permission source-scanning suites
// (projectAccess.test.ts, permissionDivergence.test.ts).
//
// Those suites assert that a removed fail-open pattern is not LIVE again. The
// files they scan deliberately QUOTE the removed code in comments — that is how
// the next reader learns what was wrong and why — so a naive `toContain` scan
// fails on our own prose. The honest fix is to strip comments properly rather
// than to weaken the patterns until they stop matching the explanation.
//
// Crude by design: it does not understand comment markers inside string or
// regex literals. That errs toward stripping, i.e. toward a false PASS rather
// than a false FAIL, which is the right direction for a helper whose failure
// mode would otherwise be "CI blocks on a code comment".

/** Remove `/* … *\/` blocks (a JSX `{/* … *\/}` comment is one) and whole-line
 *  `//` comments, leaving only code a scan should consider live. */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
