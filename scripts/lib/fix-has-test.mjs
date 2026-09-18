// A fix to product code must leave a test behind (owner, 2026-09-16).
//
// The bug ledger used to be the memory: one markdown file per bug, read before
// touching a subsystem. It grew to 1,477 files nobody could read, and a sweep of
// it found 126 of 138 "still open" entries were already fixed. A test is the
// memory that runs: it fails the day the bug comes back, which no file does.
//
// Narrow on purpose, so it can be believed:
//   · "a fix" means the conventional prefix (fix:, fix(scope):) or a fix/ branch.
//     A feat PR that also repairs something is not caught, and that is fine —
//     a gate that fires on ordinary work is a gate people learn to wave through.
//   · "product code" is backend/src or frontend/src, tests excluded.
//   · "a test" is any changed file under a tests folder or named *.test.* /
//     *.spec.*, anywhere in the repo, plus e2e/.

const TEST_PATH = /(^|\/)(tests?|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PRODUCT = /^(backend|frontend|mail-sync|native)\/src\/.+\.[cm]?[jt]sx?$/;
const SOURCE_SUFFIX = /\.[cm]?[jt]sx?$/;

export const WAIVER_LABEL = 'no-test-needed';

export function isTestFile(path) {
  return TEST_PATH.test(path) || TEST_NAME.test(path) || path.startsWith('e2e/');
}

export function isProductCode(path) {
  return PRODUCT.test(path) && !isTestFile(path);
}

export function looksLikeFix(title, branch) {
  const t = String(title ?? '').trim();
  const b = String(branch ?? '').trim();
  return /^fix(\([^)]*\))?!?:/i.test(t) || /^(fix|hotfix|bugfix)\//i.test(b);
}

/** The verdict for one pull request. `files` are the paths it changed. */
export function verdict({ title, branch, files, labels }) {
  const changed = (files ?? []).filter((f) => SOURCE_SUFFIX.test(f) || isTestFile(f));
  const product = changed.filter(isProductCode);
  const tests = changed.filter(isTestFile);
  const waived = (labels ?? []).map((l) => String(l).toLowerCase()).includes(WAIVER_LABEL);

  if (!looksLikeFix(title, branch)) return { ok: true, reason: 'not a fix', product, tests };
  if (product.length === 0) return { ok: true, reason: 'no product code changed', product, tests };
  if (tests.length > 0) return { ok: true, reason: 'a test changed with it', product, tests };
  if (waived) return { ok: true, waived: true, reason: `waived by the ${WAIVER_LABEL} label`, product, tests };
  return { ok: false, reason: 'a fix changed product code and no test moved with it', product, tests };
}
