// ----------------------------------------------------------------------------
// coverage-areas — the ONE definition of what the coverage ratchet measures.
//
// Imported by BOTH the ratchet gate (scripts/coverage-ratchet.mjs) and the two
// vitest configs' `coverage.include`. One list, so the set of files vitest
// instruments and the set the gate audits cannot drift apart — and when they
// DO drift the gate says so instead of quietly reporting a smaller denominator
// as a higher percentage.
//
// WHY PER-AREA AND NOT ONE GLOBAL NUMBER. A single repo-wide percentage lets a
// well-tested area subsidise an untested one: `scm/shared` is small and mostly
// pure, `scm/routes` is 86k lines of handlers, and averaging them hides which
// one is thin. Each area is ratcheted at its OWN number.
//
// Areas are disjoint by construction. Anything under backend/src that is NOT
// under scm/ is measured but unratcheted, and the gate prints it as such rather
// than dropping it silently.
// ----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

/** Repo root, derived from this file's location — never a cwd guess. */
export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/**
 * A ratcheted area.
 *  · id       — stable key in coverage-baseline.json. Renaming one resets its floor,
 *               so don't.
 *  · dir      — repo-relative directory.
 *  · exts     — file extensions that count as source here.
 *  · project  — which vitest project produces this area's coverage.
 *  · notIn    — sub-paths owned by an EARLIER area, so the areas stay disjoint.
 *  · ratchetNoTest
 *             — whether the "files with no test" floor applies. Default true.
 *
 * ORDER MATTERS: areaOf takes the first match, so a narrower area must come
 * before the directory that contains it.
 */
export const AREAS = [
  { id: 'backend/src/scm/routes', dir: 'backend/src/scm/routes', exts: ['.ts'], project: 'backend' },
  { id: 'backend/src/scm/lib', dir: 'backend/src/scm/lib', exts: ['.ts'], project: 'backend' },
  { id: 'backend/src/scm/shared', dir: 'backend/src/scm/shared', exts: ['.ts'], project: 'backend' },
  // scripts/lib is where a module lives BECAUSE a test imports it (CLAUDE.md's
  // shebang rule), so it is held to both floors.
  { id: 'backend/scripts/lib', dir: 'backend/scripts/lib', exts: ['.mjs'], project: 'backend' },
  // Everything else under scripts/ is one-shot operational tooling: dispatched
  // by hand through a workflow, output read once by a human. Several land a
  // week and a new one legitimately has no test, so the no-test floor is OFF
  // here — a floor that goes red on every ops script is a floor somebody
  // deletes, and then there is no floor at all. The percentage floor stays, so
  // deleting existing tests still fails, and the count is still measured and
  // printed.
  {
    id: 'backend/scripts',
    dir: 'backend/scripts',
    exts: ['.mjs'],
    project: 'backend',
    notIn: ['backend/scripts/lib/'],
    ratchetNoTest: false,
  },
  { id: 'frontend/src', dir: 'frontend/src', exts: ['.ts', '.tsx'], project: 'frontend' },
];

/** Directories that hold no executable source of ours. */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'data', '__snapshots__']);

/** A test file is not the thing under test — it never counts toward a denominator. */
export const isTestFile = (rel) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)tests?(-node|-pg)?\//.test(rel);

/** Declarations emit nothing, so they can neither be covered nor uncovered. */
const isTypeOnly = (rel) => rel.endsWith('.d.ts');

/**
 * Does this repo-relative path count as source in `area`?
 * Pure — the gate applies it to on-disk paths and to report keys alike, so the
 * two sides can never disagree about what is in scope.
 */
export function isAreaSource(area, rel) {
  if (!rel.startsWith(`${area.dir}/`)) return false;
  if ((area.notIn ?? []).some((p) => rel.startsWith(p))) return false;
  if (!area.exts.some((e) => rel.endsWith(e))) return false;
  if (isTestFile(rel) || isTypeOnly(rel)) return false;
  const parts = rel.split('/');
  return !parts.some((p) => EXCLUDED_DIRS.has(p));
}

/** Which area owns this repo-relative path, or null. Areas are disjoint. */
export function areaOf(rel) {
  return AREAS.find((a) => isAreaSource(a, rel)) ?? null;
}

/** Every source file on disk for `area`, repo-relative, sorted. */
export function listAreaFiles(area, root = REPO_ROOT) {
  const out = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (EXCLUDED_DIRS.has(e.name)) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else {
        const rel = path.relative(root, child).split(path.sep).join('/');
        if (isAreaSource(area, rel)) out.push(rel);
      }
    }
  };
  walk(path.join(root, area.dir));
  return out.sort();
}

/**
 * `coverage.include` globs for one vitest project, derived from the same AREAS.
 * Used by backend/vitest.config.mts and frontend/vitest.config.ts, so widening
 * an area widens what vitest instruments in the same commit.
 */
export function includeGlobsFor(project, projectDir) {
  const prefix = `${projectDir}/`;
  return AREAS.filter((a) => a.project === project && a.dir.startsWith(prefix)).flatMap((a) => {
    const rel = a.dir.slice(prefix.length);
    return a.exts.map((e) => `${rel}/**/*${e}`);
  });
}
