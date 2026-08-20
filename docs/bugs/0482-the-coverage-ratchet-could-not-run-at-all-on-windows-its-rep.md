## The coverage ratchet could not run at all on Windows — its repo root was C:\C:\Users\... [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** On the OS this repo is developed on, `coverage-ratchet --check`
measured the report correctly and then enforced **nothing**:

```
REPO_ROOT = C:\C:\Users\User\Desktop\...\checker-repair
read frontend/coverage/coverage-final.json: 641 files

area          lines  covered     pct   floor  files  no-test  floor
------------  -----  -------  ------  ------  -----  -------  -----
frontend/src  61446    10428  16.97%       -    639      314      -

FAIL frontend/src:
  - area "frontend/src" has no entry in the baseline — add one with --update
```

Both floor columns are `-`. `listAreaFiles` returned **0 files for all six
areas**, and `coverage-baseline.json` was two directories the process could not
see. Linux CI was unaffected throughout, so the gate read as healthy.

**Root cause (traced, not guessed).** `scripts/coverage-areas.mjs:24`:

```js
export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
```

A file URL's `pathname` is a **URL path**, not a filesystem path. On Windows it
is `/C:/Users/...` — leading slash included — and `path.resolve` reads that slash
as "absolute", prefixing the current drive. On POSIX a file URL's pathname
already IS the path, so Linux never saw it. It also percent-encodes, so a
checkout under a path containing a space would break the same way on Linux.

Observed, both primitives on the same URL:

```
pathname      "/C:/Users/x/repo/scripts/coverage-areas.mjs"
fileURLToPath "C:\\Users\\x\\repo\\scripts\\coverage-areas.mjs"
```

Same class as the ESLint `.bin` shim, and — sharply — as the `file://${...}`
entry-point bug **two hundred lines away in `coverage-ratchet.mjs`**, which
carries a long comment about `main()` never being called on Windows. The lesson
was written down next door and the sibling file still had it.

**One honest correction to the report that prompted this.** It was described as
printing that message *while exiting 0*. Measured here with a real
`coverage-final.json`, the unfixed script prints exactly that message and exits
**1**, because a missing baseline entry is already a `FAIL` verdict. The
dangerous half is real and reproduced — zero floors enforced, every area scanning
zero files — but the exit code was not 0 in this configuration, and no
configuration was found in which it is.

**Fix.**

- `fileURLToPath` from `node:url`, the primitive that decodes both the drive
  letter and percent-encoding. Checked repo-wide:
  `git grep "new URL(import.meta.url)"` finds **this line and nothing else**;
  every other `import.meta.url` site passes a URL *object* straight to `node:fs`,
  which converts correctly on both platforms, and there is no remaining
  `file://${...}` concatenation anywhere.
- **A load-time self-test**, the property every other checker here carries. For a
  pattern-based checker the dead thing is a regex that cannot match; here it is a
  root that is not the repo, and the failure reads identically — empty scans,
  zero counts, a clean report. It asserts that this very file is where REPO_ROOT
  says it is and that every area directory exists, and THROWS otherwise. Proved
  by reverting the line: vitest cannot even load its config, printing the doubled
  root and all six missing areas.
- **A missing baseline is FATAL in `--check`.** It used to fall back to
  `{ areas: {}, knownAbsent: [] }` — a gate with no floors, which is precisely
  the branch the path bug made the only one that ever ran locally. `--update` may
  still bootstrap one, but says so on stdout. New code `FATAL.NO_BASELINE`;
  proved by pointing `--baseline` at a file that does not exist: exit 1.

**Pinned by** `backend/tests/coverageAreasRepoRoot.test.mjs`, and the two guards
cover different platforms on purpose — on Windows the load-time self-test throws
before any test runs; on Linux, where that self-test is satisfied, the last test
reads the source and fails if `.pathname` returns. Proved RED both ways on the
unfixed file.

**After, on this Windows machine, same report, no ceiling touched:**

```
frontend/src  61446  10428  16.97%  13.01%  639  314  351
coverage-ratchet: every area held its floor.                              exit 0
```

**Ref.** `fix/coverage-ratchet-windows-path`, 2026-08-21.
