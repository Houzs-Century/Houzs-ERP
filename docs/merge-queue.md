# Merging — the queue, and why the button says something else now

`Houzs-Century/Houzs-ERP` merges through a **merge queue** as of 2026-08-18.
The button on a pull request reads **`Merge when ready`**, not `Squash and merge`.
Press it once and stop watching: the queue takes the merge from there.

## What it replaced

Before the queue, `main` was protected with
`strict_required_status_checks_policy`, which means a PR must be up to date with
`main` before it can merge. With many PRs open that is quadratic busywork: every
merge makes every other PR stale, and each one then needs *Update branch* and a
fresh CI run. Measured during the incident that produced
`docs/ci-capacity-coe.md`: **173 CI runs across 35 open PRs in 24 hours**, one
branch running CI **19 times in a single day**.

The queue does that work instead. It merges your branch with the current `main`
on a temporary `gh-readonly-queue/...` ref, runs CI on the RESULT, and merges
only if that passes. Nobody presses *Update branch* again.

## The settings, and why each one is what it is

| setting | value | why |
| --- | --- | --- |
| `merge_method` | `SQUASH` | matches how this repo already merged |
| `max_entries_to_build` | `3` | each queued entry triggers a full CI run (~11 runner slots). The org has 60 concurrent slots; 3 in flight leaves room for ordinary PR runs. Raise it only after watching the queue keep up |
| `grouping_strategy` | `HEADGREEN` | only the head commit of a group must be green, rather than every entry independently. The strict setting multiplies runner time, which is the resource this repo is short of |
| `check_response_timeout_minutes` | `30` | CI's slowest observed run is ~5 minutes; 30 is generous without stranding the queue |
| `min_entries_to_merge` | `1` | see the measurement below — this is what stops the wait timer mattering |

## The wait timer does NOT delay a single PR

`min_entries_to_merge_wait_minutes` is `5`, and the obvious reading — "every
merge now takes five minutes longer" — is wrong. A lone PR already satisfies
`min_entries_to_merge: 1`, so there is nothing to wait for. GitHub's
documentation does not state this either way; it was settled by measuring the
first real queued merge (**PR #2409**, 2026-08-18):

```
07:03:50   entered the queue, queue CI started
07:07:22   queue CI finished          -> 212s of CI
07:07:40   merged                     ->  18s of queue overhead
                                          230s total
```

**18 seconds of overhead, not five minutes.** If that ever changes, re-measure
before changing the setting.

## The trap to check before touching required checks

**A required status check whose workflow does not run on `merge_group` leaves
every queued PR hanging forever.** The queue asks for the check, nothing ever
reports it, and the entry sits until the timeout drops it.

`ci.yml` triggers on `pull_request` **and `merge_group`**, and both required
contexts — `backend-typecheck` and `frontend` — are jobs inside `ci.yml`. That
is why enabling the queue needed no workflow change at all.

If you add a required context, confirm its workflow has the `merge_group`
trigger first:

```bash
gh api repos/Houzs-Century/Houzs-ERP/rules/branches/main \
  -q '.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'
```

Then check every workflow that owns one of those contexts has `merge_group:` in
its `on:` block.

## Related

- `docs/ci-capacity-coe.md` — why the queue was needed, the 20-slot ceiling that
  forced the org move, and what the repo transfer preserved
- `.github/workflows/ci.yml` — the `changes` job, and which jobs are gated
- `.github/workflows/postsubmit.yml` — jobs that run after merge instead of before
