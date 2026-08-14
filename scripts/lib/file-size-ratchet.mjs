// File-size ratchet — the decision logic, kept pure so it can be unit-tested
// without a repo, a git history or a filesystem.
//
// NO SHEBANG, ON PURPOSE. This module is imported by a test, and a `#!` that is
// not at byte 0 after vitest inlines the source is a `SyntaxError` on Windows
// only — see the CLAUDE.md note and BUG-HISTORY #2062. Runnable entry points
// (../check-file-size.mjs) keep their shebang; this file must not have one.
//
// ---------------------------------------------------------------------------
// WHAT THIS ENFORCES
//
// As of 2026-08-13 the repo had 39 source files over 2,000 lines under
// backend/src + frontend/src (41 counting backend/scripts), the largest 14,867
// and the sales-order router 12,094. Those figures are a snapshot and will age —
// the LIVE numbers are `npm run check:file-size:list`, and the per-file record is
// scripts/file-size-ceilings.json, which is generated and gated rather than
// typed. Splitting these files is a refactor with real risk and it is NOT what
// this gate is for. This gate only stops the problem GROWING:
//
//   · a file already over the limit carries its OWN ceiling, recorded once from
//     the tree. It may shrink freely; it may not grow past what it already was.
//   · every other file is capped at NEW_FILE_LIMIT. A brand-new 3,000-line file
//     fails. A 1,900-line file is fine and has no manifest entry.
//   · a ceiling may only FALL. Raising one is the failure mode that turns a
//     ratchet back into a suggestion, so it is refused mechanically rather than
//     left to review — see `findRaisedCeilings`.
//
// This is deliberately a RATCHET and not a limit: pointed at the tree as it
// stands today, it is green. A gate that goes red on day one against existing
// code gets deleted within a day, and then there is no gate at all.
//
// WHY THE MANIFEST ONLY LISTS OFFENDERS
//
// Recording a ceiling for all ~2,000 source files (2026-08-13) would produce a manifest that
// churns on every merge and conflicts constantly at this repo's merge rate. Only
// files ABOVE the limit need an entry; everything else is covered by the single
// shared cap. So the manifest is ~41 lines, reviewable in a diff, and it SHRINKS
// as files are split — when a grandfathered file drops under the limit it leaves
// the manifest for good and can never come back above it.

/**
 * Files at or below this many lines need no manifest entry. A file NOT in the
 * manifest may not exceed it.
 *
 * 2,000 is the number the codebase already treats as "too big to open whole"
 * (CLAUDE.md: "Do not open a 5,000+ line file whole"; docs/CODEBASE-MAP.md's
 * largest-files section). It is chosen so that the current tree is green: every
 * file above it is grandfathered with its own ceiling.
 */
export const NEW_FILE_LIMIT = 2000;

/**
 * Source files modified in the working tree, parsed out of `git status
 * --porcelain -z`.
 *
 * WHY THIS MATTERS AT ALL. The gate compares the COMMITTED tree against the
 * merge base. Run it with source edits still uncommitted and it measures HEAD,
 * prints "file-size ratchet OK", and the author reads that as a verdict on the
 * code in front of them. On 2026-08-14 a change that grew an over-ceiling file
 * by one line was told OK, and turned red the instant it was committed. The
 * caller uses this to REFUSE rather than answer.
 *
 * The parse is here and the `git` call is not, because a shell-out is not
 * testable and this is: porcelain gives `XY <path>`, and a rename gives
 * `R  old -> new`, where only the NEW path is a file that exists to measure.
 *
 * @param {string} porcelainZ raw output of `git status --porcelain -z`
 * @param {readonly string[]} extensions the source extensions the gate measures
 * @returns {string[]} sorted, de-duplicated paths
 */
export function uncommittedSourcePaths(porcelainZ, extensions) {
  const out = new Set();
  for (const entry of String(porcelainZ ?? '').split('\0')) {
    if (entry.length < 4) continue;             // '' or a bare status with no path
    let p = entry.slice(3);                     // 'XY ' is exactly three characters
    const arrow = p.indexOf(' -> ');            // a rename: measure where it landed
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = p.trim();
    if (p && extensions.some((e) => p.endsWith(e))) out.add(p);
  }
  return [...out].sort();
}

/**
 * Extensions the gate measures. Data (.json), documents (.md, .pdf), fonts and
 * lockfiles are excluded: their size is not a legibility problem and a data
 * refresh must never fail a gate about hand-written code.
 */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * A file whose header says a machine wrote it is exempt.
 *
 * This is a marker check and not a path list on purpose: a path list rots the
 * moment a generated file moves, and rots SILENTLY — the gate keeps passing
 * while measuring nothing. The marker travels with the file.
 *
 * Exemption is necessary, not cosmetic. `backend/src/services/autocount-sofa-corpus.ts`
 * is 7,933 lines compiled from a licensed account-book export, and
 * `autocount-item-map.ts` is 1,571 from the cutover map. Both grow when the
 * DATA grows. Under a "may only fall" ceiling an ordinary export refresh would
 * fail CI, and the only way out would be raising a ceiling — the one thing this
 * gate exists to prevent. Skipped files are counted and printed by the reporter,
 * so an exemption is never invisible.
 */
export const GENERATED_MARKERS = [
  'GENERATED FILE',
  '@generated',
  'AUTO-GENERATED',
  'Generated by',
  'generated by',
  'DO NOT EDIT',
];

/** How many leading lines of a file are searched for a generated-marker. */
export const GENERATED_HEADER_LINES = 5;

/**
 * True when `head` (the first lines of a file, already split) marks it machine-
 * generated. Only the header is consulted so that a stray "@generated" in a
 * comment 4,000 lines down cannot exempt a hand-written file.
 */
export function isGeneratedHeader(head) {
  const window = head.slice(0, GENERATED_HEADER_LINES).join('\n');
  return GENERATED_MARKERS.some((m) => window.includes(m));
}

/**
 * The ceiling that applies to a path: its recorded one, or the shared cap.
 */
export function ceilingFor(path, ceilings, newFileLimit = NEW_FILE_LIMIT) {
  return Object.prototype.hasOwnProperty.call(ceilings, path) ? ceilings[path] : newFileLimit;
}

/**
 * Decide the run.
 *
 * @param {Array<{path: string, lines: number}>} measured  every scanned file
 * @param {Record<string, number>} ceilings                manifest, path -> max lines
 * @param {number} newFileLimit
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{path, lines, ceiling, over, grandfathered}>,
 *   shrunk: Array<{path, lines, ceiling}>,
 *   stale: string[],
 *   belowLimit: Array<{path, lines, ceiling}>,
 * }}
 */
export function verdict(measured, ceilings, newFileLimit = NEW_FILE_LIMIT) {
  const violations = [];
  const shrunk = [];
  const belowLimit = [];
  const seen = new Set();

  for (const { path, lines } of measured) {
    seen.add(path);
    const grandfathered = Object.prototype.hasOwnProperty.call(ceilings, path);
    const ceiling = ceilingFor(path, ceilings, newFileLimit);
    if (lines > ceiling) {
      violations.push({ path, lines, ceiling, over: lines - ceiling, grandfathered });
    } else if (grandfathered && lines < ceiling) {
      // The ratchet has slack: the file shrank and the manifest still records
      // the old, higher number. Not a failure — reporting it is how the ceiling
      // gets lowered (`--update`).
      shrunk.push({ path, lines, ceiling });
      if (lines <= newFileLimit) {
        // It has come all the way down. `--update` drops the entry entirely and
        // the file is capped with everything else from then on.
        belowLimit.push({ path, lines, ceiling });
      }
    }
  }

  // Manifest entries whose file is gone (deleted or renamed). Harmless to the
  // verdict, but they must be reported or the manifest slowly fills with
  // ceilings for files that no longer exist and stops being readable.
  const stale = Object.keys(ceilings)
    .filter((p) => !seen.has(p))
    .sort();

  return { ok: violations.length === 0, violations, shrunk, stale, belowLimit };
}

/**
 * Recompute the manifest so that every ceiling is the file's CURRENT size, and
 * files at or under the cap leave the manifest.
 *
 * Monotonic by construction: a ceiling is only ever written when it is LOWER
 * than the recorded one, and a file that is not already in the manifest is only
 * added when it exceeds the cap (that case is a violation the gate has already
 * failed on — `--update` is not a way to launder it, see `findRaisedCeilings`).
 */
export function lowerCeilings(measured, ceilings, newFileLimit = NEW_FILE_LIMIT) {
  const next = {};
  for (const { path, lines } of measured) {
    const has = Object.prototype.hasOwnProperty.call(ceilings, path);
    if (has) {
      const current = ceilings[path];
      // Never raise. If the file grew past its ceiling the gate fails; --update
      // must not paper over it by writing the bigger number.
      const lowered = Math.min(current, lines);
      if (lowered > newFileLimit) next[path] = lowered;
      // else: it has fallen to/below the shared cap and leaves the manifest.
    } else if (lines > newFileLimit) {
      // A file over the cap with no entry. Only reachable when someone is
      // deliberately grandfathering a new offender; the gate reports it as a
      // violation and this keeps --update honest by recording the real number.
      next[path] = lines;
    }
  }
  return sortKeys(next);
}

/**
 * The "may only fall" check, run against the manifest as it exists on the merge
 * base. Returns every entry that got LOOSER — a raised ceiling, or a newly
 * grandfathered file.
 *
 * Without this the manifest is just a file, and the cheapest way past a red gate
 * is to edit the number. With it, loosening the ratchet fails CI and has to be
 * argued for rather than slipped in.
 */
export function findRaisedCeilings(baseCeilings, headCeilings, newFileLimit = NEW_FILE_LIMIT) {
  const raised = [];
  for (const [path, value] of Object.entries(headCeilings)) {
    const had = Object.prototype.hasOwnProperty.call(baseCeilings, path);
    if (!had) {
      raised.push({ path, from: null, to: value, reason: 'newly grandfathered' });
    } else if (value > baseCeilings[path]) {
      raised.push({ path, from: baseCeilings[path], to: value, reason: 'ceiling raised' });
    }
  }
  // A file dropping out of the manifest is the ratchet WORKING, not loosening —
  // it is now bound by the shared cap, which is stricter than any entry.
  return raised.sort((a, b) => a.path.localeCompare(b.path));
}

/** Stable key order so the manifest diffs cleanly. */
export function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
