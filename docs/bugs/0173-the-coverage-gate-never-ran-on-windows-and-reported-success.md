## The coverage gate never ran on Windows and reported success without reading a report [high]

**Symptom.** `node scripts/coverage-ratchet.mjs --check --report <file>` on a
Windows checkout: no output at all, exit 0. Not "every area held its floor" — no
table, no area list, nothing. The same command on Linux CI prints a six-area
table and fails correctly.

**Root cause, traced to one line.** The entry-point guard was

```js
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
```

On Windows `process.argv[1]` is `C:\…\coverage-ratchet.mjs`, so the template
builds `file://C:\…` — two slashes, backslash separators. `import.meta.url` is
`file:///C:/…` — three slashes, forward slashes. They can never be equal, so
`main()` was never called and the module fell off the end having done nothing.
On POSIX the path already starts with `/`, so the concatenation happens to
produce the three-slash form and the comparison matches **by luck**.

**Why it is worse than a papercut.** This is the gate that holds line coverage
and the no-test-file floor. Locally it answered every question with a silent
success — `npm run coverage:check` was indistinguishable from a pass — so a
developer on Windows could not check a floor before pushing, and would be told
everything was fine. The repo's own rule names this exact shape: *"A verdict
computed over nothing must never read as a pass."*

**Fix.** `import.meta.url === pathToFileURL(process.argv[1]).href`. Same
comparison, done by the API that knows about drive letters and separators.
Verified by running the gate on Windows afterwards: it now reads the report
(733 files), prints all six areas, and fails on the areas that are genuinely
below their floor.

**The class, for next time.** Second instance in one day of *a gate that is
silently a no-op on the OS this repo is developed on, while Linux CI stays
green* — the first was `lint-ratchet.mjs` spawning `.bin/eslint`
(BUG-HISTORY 2026-08-14). Both were invisible to CI by construction. When a
check is added, run it on Windows once and confirm it PRINTS something.

**Ref** — 2026-08-14, PR `fix/coverage-lib-tests`. No migration.
