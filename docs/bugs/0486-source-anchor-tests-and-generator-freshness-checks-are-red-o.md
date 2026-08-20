## Source-anchor tests and generator freshness checks are red on any CRLF checkout [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** On untouched `origin/main`, on this machine, on every branch: two
suites and three `audit:` gates fail, while the same commit is green in Actions.

```
FAIL  tests/showroomVenueCompanyScope.test.ts > showroom venue picker is company-scoped > the project_venues half it merges with is scoped too
Error: GET /api/projects/venues project half: anchor not found in source: FROM project_venues

FAIL  tests/posExchangeSessionOrigin.test.ts > the population this ruling turns off > every POS-gated refusal in the SO routes hangs off isPosTabletCaller
AssertionError: expected '// /mfg-sales-orders - B2B sales orde...' to contain 'async function isPosTabletCaller(c: P...'

audit:ac-coverage        AutoCount coverage is STALE. Run: npm --prefix backend run gen:ac-coverage
audit:ac-master-maps     src\services\autocount-master-maps.ts is STALE.
```

Red that has nothing to do with the code is the expensive kind: it teaches
everyone here to read red as noise, and the local `audit:` gates in particular
get skipped rather than run.

**Root cause (traced).** `core.autocrlf=true` is set in this machine's system
git config, so the checkout carries CRLF — `git ls-files --eol
backend/src/routes/projects.ts` reports `i/lf w/crlf`, and the file holds 5,002
CRLF pairs. Two consequences, one per family:

* **The tests** match SOURCE anchors that span a line, written with `\n`:
  `"FROM project_venues\n      WHERE active = 1"` and
  `"async function isPosTabletCaller(c: PosCallerSource): Promise<boolean> {\n  return …"`.
  The haystack is the file read through `?raw`, so it carries `\r\n` and
  `indexOf` / `toContain` miss. Single-line anchors in the same files are
  unaffected, which is why only these two of the 48 `?raw` suites went red.
* **The generators** build their output with `\n` and compare it against
  `fs.readFileSync(OUT, "utf8")` with a bare `!==`. Five generators had already
  learned this and carried five copies of the same one-liner under five
  different names (`lf`, `eol`, `normalise`, plus two inline `.replace()`
  calls); `gen-autocount-coverage.mjs` and `gen-autocount-master-maps.mjs` had
  no copy. A rule copied by hand is a rule some of the copies do not get.

**Fix.** Normalise where the source ENTERS the file, not at each anchor —
`onlySource()` in `showroomVenueCompanyScope.test.ts`, and one `lf()` over both
raw imports in `posExchangeSessionOrigin.test.ts`. For the generators, one home:
`backend/scripts/lib/eol.mjs` exports `lf()` / `sameIgnoringEol()`, the two
generators that had no normalisation now use it, and the five hand-rolled copies
were collapsed onto it so there is no sixth to miss. Nothing was regenerated and
committed, and no git config was changed — the checks have to be correct however
the tree was checked out.

Proved RED on the unfixed tree, and proved still-red for the RIGHT reason after
the fix: deleting `${activeCompanySql(c)}` from the `project_venues` statement in
`backend/src/routes/projects.ts` now fails
`showroomVenueCompanyScope.test.ts` with `expected '\`SELECT id, name, state,
size, notes,…' to contain 'activeCompanySql(c)'` — i.e. the guard is live rather
than merely silenced. For the generators, a freshly generated
`route-locator.md` rewritten to CRLF passes the fixed `--check`
(`route-locator.md up to date (1038 routes)`) where a raw compare reports stale.

**Also found, and NOT a CRLF fault:** `docs/generated/route-locator.md` on
`origin/main` is genuinely stale — 1037 registrations recorded against 1038 in
the tree, and `backend/src/scm/routes/autocount-outbox.ts` missing entirely. That
is the documented, deliberate state (`audit:route-locator` is not a CI gate
precisely because the file embeds line numbers and drifts on every backend
merge), so it is reported here rather than papered over by committing a
regenerated file. My first reading blamed CRLF for this one; regenerating and
diffing refuted it.

**Ref.** fix/crlf-source-anchors, 2026-08-21.
