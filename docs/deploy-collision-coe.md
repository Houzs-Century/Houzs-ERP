# Houzs ERP — Deploy Collision COE (Correction of Error)

**Date:** 2026-07-17 (twice, in one evening: ~20:27 and ~21:32 MYT); **again 2026-07-22** — see §1a
**Trigger:** Nothing broke visibly, which is the whole problem. The owner's **view-as** flow was reported broken, fixed, merged — and stayed broken in production. Staff continued to hit bugs that had already been fixed on main. Every deploy in the window reported **green**.
**Status:** All three episodes recovered. **The two mechanisms that caused them are now fixed in `deploy.yml`** — the frontend release is unconditional (#992) and the backend's diff window now spans everything unreleased rather than one push, plus a guard that refuses to publish an ancestor of what is live. The manual "check the frontend job says success, not skipped" rule is no longer the only defence.

---

## 1. Incident — what happened and why

Production's frontend silently stopped tracking main. On 2026-07-17 it happened twice: **4 files stale**, recovered at 20:27 (`e90e1017`, sw v187); then **8 files stale**, recovered at 21:32 (`1d35ae28`, sw v188). Between the two, the second batch included the entire authentication-token seam — so the fix for the owner's own reported bug was merged, marked done, and never reached a browser.

### Root cause — three correct mechanisms composing into a wrong one

`.github/workflows/deploy.yml` **as it was**, verified at `9db13349`
(2026-07-21). All three mechanisms below are historical — §5 records which fix
closed each, and none of them describes the file today:

1. **It is push-only.** `on: push: branches: [main]` (`:3-5`). There is no `workflow_dispatch`, so there is no way to deploy without a new commit. (Today there is: `deploy.yml:6`.)
2. **Queued runs collapse.** `concurrency: group: deploy-${{ github.ref }}` with `cancel-in-progress: false` (`:7-9`). GitHub keeps *one* running and *one* pending run per group; when a third arrives the pending one is **cancelled**. So in a burst, the running deploy finishes and every queued run except the newest is cancelled — cancelled **before its `frontend` job ever exists**.
3. **The survivor computes the wrong diff.** `dorny/paths-filter@v3` (`:24-33`) on a push event compares `github.event.before..github.sha` — that is *this push's* range, not "everything since the last successful deploy". The one surviving run sees only the **last** merge's diff. If that last merge happened to be backend-only, `frontend` evaluates to `false` and the frontend job is **skipped**.

Every frontend change carried by a cancelled run therefore never deploys, and the run that *did* execute goes green. **There is no error anywhere.** The workflow is not failing; it is correctly reporting that the last push touched no frontend files.

Each of those three decisions is defensible in isolation. `cancel-in-progress: false` exists so a deploy is never killed mid-`wrangler deploy`. The paths filter was added deliberately on 2026-07-11 (`7717cf78`) because *"the July 5 Supabase outage retry-storm + high push frequency burned ~4,900 Actions minutes in a week (limit 3,000/mo)"* — a real cost problem, correctly solved. The failure is in the composition: **the filter's diff window assumes every push gets its own run, and the concurrency group guarantees that some pushes do not.**

### Evidence

- **The burst is in the PR timestamps.** Episode two: **#714 merged 13:25:27Z, #718 at 13:25:37Z, #719 at 13:26:14Z** — three merges inside 47 seconds. `e90e1017` records episode one as *"seven PRs merged back-to-back."*
- **The staleness was measured against a named SHA, not estimated.** Episode one: prod's frontend had not moved since `b8bce7e7` (merge of #673, 2026-07-17 19:21 MYT), with `query-persist.ts`, `MobilePOD.tsx`, `Positions.tsx`, `types.ts` landed and unshipped. Episode two: stale since `abb908dc` (#717, 21:15 MYT), with 8 files including `lib/authToken.ts` — *"the view-as fix itself"* — plus `main.tsx`, `api/client.ts`, `pages/Projects.tsx` and four `vendor/scm/lib/*` modules. `1d35ae28`'s message states the consequence plainly: *"So #718 fixed the owner's view-as, merged, and did not ship. Every view-as session still breaks the whole /scm surface."*
- **The mechanism is recorded in the source tree**, at `frontend/public/sw.js:316-329`, next to the constant that was bumped to recover.

---

## 1a. Third firing — 2026-07-22, and a rollback that was stopped by luck

Five days after this COE was written, the same mechanism stranded **10 commits** of frontend, including the whole of #906 (214 files). Full trace in `BUG-HISTORY.md`, 2026-07-22, "The frontend sat 10 commits behind main". Two things it adds to the record:

**It can strand everything, not just the middle of a burst.** On 2026-07-17 a run always survived and the fault was the survivor's diff window (§1 mechanism 3). On 2026-07-22 the run for `850014c` held the group for **40 minutes** — `changes` completed 02:39:40, `backend` did not start until 03:19:46 — and *all three* runs queued behind it were cancelled, main tip included. `gh run view 29887977202 --json jobs` returns no job rows: cancelled before a job existed. So mechanism 2 alone is sufficient; mechanism 3 is not required, and a fix that only corrects the diff window would not have helped here.

**A slow run is a time machine, and nothing in the pipeline knows it.** `850014c` is an *ancestor* of the already-deployed `644d25d`. Its `wrangler deploy` would have published a Worker **older than the live one**, silently reverting #995, #994 and `8f17f39`. It was stopped only because `npm test` failed at step 7 — `850014c` predates the `cloudflare:test` fetchMock migration that #995 landed — so `pg-migrate`, `wrangler deploy` and the smoke check all skipped. **An unrelated red test is the only thing that prevented a production rollback.** `deploy.yml` has no check that the SHA it is about to publish descends from the SHA already live; with `cancel-in-progress: false` and a queue that can hold a run for 40 minutes, publishing an ancestor is a normal outcome, not a freak one.

---

## 2. Fixes shipped (2026-07-17)

| Ref | What | Effect |
|----|------|--------|
| `e90e1017` | `sw.js` VERSION v186 → **v187**. One line. | **Recovery, not a feature bump.** The bump is itself a change under `frontend/**`, so `paths-filter` fires on the next push and the 4 stranded files ship with it. |
| `1d35ae28` | `sw.js` VERSION v187 → **v188**, plus 16 lines of reasoning written next to the constant. | Recovers the 8 stranded files including the whole `authToken` seam — the owner's view-as flow reaches production for the first time. The comment (`sw.js:316-329`) states the full mechanism, names the real fix, and records the interim rule so the next session does not have to re-derive it. |

**The recovery works precisely because it is the crudest possible change.** A no-op edit to a file under `frontend/**` is the only lever available when the pipeline is push-only and the filter has already decided your changes do not exist.

---

## 3. What this COE rules OUT

- **Not the service worker.** The v187/v188 bumps look like the PWA cache-churn class (`api-fetch-hardening-coe.md`'s first lesson, and `sw.js:29` v4), but they are the opposite: there the SW cache held *stale chunks of a build that had shipped*; here the build **never shipped at all**. No amount of cache work would have helped, and the SW is the fix vehicle rather than the fault.
- **Not `cancel-in-progress` misconfigured.** `cancel-in-progress: false` is correct — flipping it to `true` would kill deploys mid-`wrangler deploy`, and would not help anyway: the middle runs are cancelled by the queue's depth-1 limit, not by that flag.
- **Not the paths filter being wrong to exist.** It was added for a measured reason (4,900 of 3,000 monthly Actions minutes burned in a week) and it halves deploy cost on the common single-side push. The bug is its **diff window**, not its existence.
- **Not the same incident as the two collision modes already on record.** `BUG-HISTORY.md` line 3425 describes *"Version 跑回 old"* — a **manual `wrangler` deploy racing the CI deploy**, whose remedy was "let CI own deploys". `api-fetch-hardening-coe.md`'s second lesson describes a **deploy patch built from an unscoped `git diff origin/main`** against a lagging local tree, which reverted ~80 files of same-day work and rolled sw v69 back to v66. Both are human-driven races against CI. **This one needs no human and no second deploy path**: CI alone, doing exactly what it was configured to do, silently dropped changes. Same family, different mechanism, and the earlier remedies do not cover it.

---

## 4. What the record does NOT show

- **How long each window actually lasted in production.** Both recoveries are timestamped, but the point at which the frontend *became* stale is only bounded by the last-shipped SHA (`b8bce7e7` 19:21, `abb908dc` 21:15). No deploy log or run listing is preserved in the repo.
- **Whether this happened before 2026-07-17 and went unnoticed.** The mechanism has existed since `7717cf78` (2026-07-11) — six days — and it produces **no signal at all**. `1d35ae28` says *"Same cause as v187, same session"*, but nothing establishes 2026-07-17 as the first occurrence. It is only the first occurrence somebody noticed, and they noticed because a bug that had been fixed was still biting the owner.
- **Who caught it, or how.** Neither commit records the detection path.

---

## 5. Deferred — what remains now that the pipeline fixes have landed

> **This section's heading read "the real fix is not shipped" until 2026-08-13.
> It had shipped.** Verified against `.github/workflows/deploy.yml:246-253`: the
> `frontend` job is unconditional today (`if: github.ref == 'refs/heads/main'`,
> no path condition), with a comment giving exactly the reasoning row 1 below
> describes — *"a per-push path diff can therefore miss frontend files that
> existed only in an earlier cancelled run … also makes workflow_dispatch a
> reliable one-click recovery path."* Rows 3 and 4 already record the backend
> half as FIXED, so rows 1 and 2 were the only stale ones.

| Item | Owner | Status |
|------|-------|--------|
| **`workflow_dispatch` + a `force` input on `deploy.yml`.** Named as the real fix in both `e90e1017` and `sw.js:326-327`. It needs *both*: `paths-filter` has no `github.event.before` on a dispatch, so a dispatch without a force input would compute an empty diff and skip both jobs — the same bug by another route. | — | **SHIPPED.** It solved the "no force input" trap by removing the condition instead of adding a flag: the `frontend` job is unconditional (`deploy.yml:246-253`), so a dispatch always republishes. Both jobs stay guarded on `refs/heads/main`. |
| **A filter diff window that spans everything since the last successful deploy**, rather than one push's range. | — | **RESOLVED, differently on each side.** The frontend dropped the condition entirely; the backend got a window that spans everything since the last run whose backend job actually succeeded — see the row below, which was already marked FIXED while this row still described the asymmetry as open. |
| **The backend keeps a diff window that #992 proves untrustworthy.** #992's premise is that a per-push path diff cannot prove what is live; its remedy was applied only to the frontend. | — | **FIXED.** The `changes` job now resolves the SHA of the last run whose **backend job** concluded success (a run can be green with backend skipped — that is precisely how the 2026-07-22 window stayed invisible) and passes it to `dorny/paths-filter` as `base`. The filter now asks "is anything unreleased?" rather than "did this one push touch backend?". Fails OPEN: unresolvable base -> the backend job runs anyway. |
| **Refuse to publish an ancestor of what is already live.** | — | **FIXED.** The backend job compares `GITHUB_SHA` against the last released backend SHA with `git merge-base --is-ancestor` before anything is built, and fails with a sentence explaining itself. Equal SHAs are allowed (a rerun of the live commit is how the 2026-07-22 window was recovered); an unknown base skips the check, same fail-open rule. |
| ~~**Interim rule, in force now:** *after any burst merge, check that the last deploy's `frontend` job says **success**, not **skipped**.* Recorded at `sw.js:328-329`.~~ | — | **RETIRED — and its stated home is gone.** Re-checked 2026-08-13: `sw.js` no longer records that rule anywhere (`grep skipped` returns nothing); the comment beside the constant now reads *"The release gate now fixes the class instead of relying on another bump: deploy.yml always rebuilds the latest main frontend after a completed run and exposes workflow_dispatch as a one-click recovery."* There is nothing left to check by hand: the `frontend` job cannot be skipped (`deploy.yml:246-253`), and the deploy ends in a smoke that asserts the LIVE entry chunk and `sw` VERSION equal the ones just built — a machine check where this row asked for a human one. |

---

## 6. Lessons

1. **A green deploy is not evidence that your change is live.** This pipeline can report success for a run that deployed nothing you merged. Until the diff window is fixed, "CI is green" answers a different question than "is my code in production" — check the `frontend` job's own status, and check it says *success*, not *skipped*.
2. **A skipped job is a silent failure with a success badge.** Conditional jobs (`if: needs.changes.outputs.frontend == 'true'`) convert "we decided not to do this" into a state that is visually indistinguishable from "there was nothing to do". Any conditional deploy step needs a way to assert afterwards that the deployed artifact matches the merged tree.
3. **A diff window that assumes one run per push is broken by any concurrency group.** `github.event.before..github.sha` is only correct when every push gets its own run. `concurrency` with a depth-1 queue guarantees that some pushes never do. **If you add a paths filter to a workflow that has a concurrency group, the filter must diff against the last deployed SHA, not against the push.**
4. **Merge bursts are a deploy hazard in their own right, independent of caching.** This repo already knew "do not burst-deploy the PWA" for service-worker reasons (`api-fetch-hardening-coe.md`). 2026-07-17 adds a second, unrelated reason with a worse failure mode: burst merges do not churn the cache, they **discard the build**. Three merges in 47 seconds is enough.
5. **The bug that hides is the one that hits the person who reported it.** #718 fixed the owner's view-as, merged green, and left every view-as session breaking the whole `/scm` surface. The fix existed on main for over an hour while the person who asked for it kept experiencing the bug — the worst possible signal to send about whether reports get acted on.
6. **Record the mechanism where the next person will trip over it.** `1d35ae28` spent 16 lines writing the cause into `sw.js` beside the constant being bumped, including the fix that was *not* taken and why. That comment is why this COE could be reconstructed at all, and it is the pattern to copy: **when you ship a workaround, document the real fix next to the workaround, not in a commit message nobody will `git log`.**

---

## See also

- `.github/workflows/deploy.yml:7-9` (concurrency), `:24-33` (paths filter) — the two mechanisms that compose into the fault.
- `frontend/public/sw.js:316-329` — the in-tree record of the incident and the unshipped fix.
- `docs/api-fetch-hardening-coe.md` — burst-deploy SW cache churn, and the unscoped-`git diff` deploy-patch reversion; both adjacent, neither the same.
- `BUG-HISTORY.md` line 3425 — the manual-`wrangler`-vs-CI collision, the earlier member of this family.
