// ---------------------------------------------------------------------------
// eol.mjs — comparing a GENERATED artifact against the one on disk, without
// line endings deciding the answer.
//
// WHY THIS EXISTS, ONCE, INSTEAD OF FIVE TIMES.
//
// Every `--check` generator in this directory builds its output with `\n` and
// compares it against `fs.readFileSync(OUT, "utf8")`. This repo is developed on
// Windows with `core.autocrlf=true`, so git hands the checkout CRLF: a raw
// `!==` is therefore red on every developer machine and green on the Linux
// runner, for a tree where nothing changed at all. That is the expensive kind
// of wrong — the gate says "regenerate", regenerating writes a byte-identical
// file, and `git diff` shows nothing to explain it. A gate that cries wolf
// locally is a gate somebody deletes.
//
// Five generators had already learned this and carried five copies of the same
// one-liner under five names (`lf`, `eol`, `normalise`, plus two inline
// `.replace()` calls). Three did NOT — `gen-autocount-coverage.mjs`,
// `gen-autocount-master-maps.mjs` and `gen-route-locator.mjs` — so
// `audit:ac-coverage`, `audit:ac-master-maps` and `audit:route-locator` failed
// on every branch on this machine while CI stayed green. Measured on untouched
// `origin/main`, 2026-08-21. A rule copied by hand is a rule two thirds of the
// generators get right.
//
// This is deliberately NOT a fix in .gitattributes or in anyone's git config:
// the check has to be correct however the tree was checked out, including on a
// clone that predates any such setting.
// ---------------------------------------------------------------------------

/** CRLF -> LF. Non-strings (a missing file read as `null`) pass through. */
export function lf(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : text;
}

/** Do these two artifacts have the same CONTENT, whatever their line endings? */
export function sameIgnoringEol(a, b) {
  return lf(a) === lf(b);
}
