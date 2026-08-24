## The new linter could not start on Windows, and said "no ESLint installed" while ESLint was installed [medium]

**Symptom.** `npm --prefix backend run lint` on a Windows checkout: first
`[lint] No ESLint in backend/node_modules. Run npm ci in backend/ first.` after a
`npm ci` that had just succeeded, then — once the obvious fix was tried —
`spawnSync ...\.bin\eslint.cmd EINVAL`. Linux CI was green throughout, so the
linter this repo had just gained was unrunnable on the OS the repo is developed
on, and no finding could be checked locally before pushing.

**Root cause, traced through the spawn.** `scripts/lint-ratchet.mjs` resolved
`node_modules/.bin/eslint` and guarded it with `existsSync`. On Windows npm
writes THREE shims — `eslint`, `eslint.cmd`, `eslint.ps1`. The extensionless one
is the POSIX shell script; it exists, so `existsSync` was satisfied and the
error message blamed a missing install, but it is not executable on Windows and
`spawnSync` returned ENOENT. Reaching for `.cmd` instead moves the failure, not
fixes it: since CVE-2024-27980 Node refuses to spawn a `.cmd` without a shell,
which is EINVAL.

**Fix.** Skip the shims. Run ESLint's own entry — `node_modules/eslint/bin/eslint.js`
— under `process.execPath`. No shell, so nothing is quoted or interpreted, and
the same code path serves both platforms.

**Why it is the same class as the shebang trap** (see CLAUDE.md, "Anything a TEST
imports lives in `backend/scripts/lib/`"): a defect that only the developer's
machine sees, invisible to CI by construction, where the symptom names the wrong
cause. A gate nobody can run locally is a gate that gets pushed blind.

**Verified.** 734 frontend files and the whole backend tree now lint locally,
where neither could previously start; both then reported real ratchet findings,
which is the proof the run was genuine and not a silent no-op.

**Ref** — 2026-08-14, PR #2137 `eslint-layer`. No migration.
