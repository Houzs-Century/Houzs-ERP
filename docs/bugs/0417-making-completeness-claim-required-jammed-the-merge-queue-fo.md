## Making completeness-claim REQUIRED jammed the merge queue for the whole repo [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** 今天早上把 completeness-claim 设成必过之后，合并队列就卡死了 —— 不是某一个 PR
的问题，是所有 PR 都进不去。原因是这个检查只在 pull_request 时才跑，队列里跑的是
merge_group，那时候根本没有 PR 内容可读，所以它永远不会回报结果，队列就一直等。第一个
排队的 PR 十六项检查全绿，还是停在 AWAITING_CHECKS 第一位。现在让这个 job 在
merge_group 时立刻回报通过（PR 阶段已经真的验过了），队列才走得动。顺手修了并发设定：
merge_group 没有 PR 编号，原本的写法会让每个 merge group 共用同一个并发组、互相取消，
被取消的检查不算通过，那会用另一种方式再把队列卡住一次。

**Symptom.** #2516 sat at merge-queue position 1 in `AWAITING_CHECKS` with all
16 of its merge-group checks `completed/success`, and did not merge. Nothing was
wrong with the PR: the same PR's checks were green, `mergeStateStatus` was
`CLEAN`, `mergeable` was `MERGEABLE`, and its timeline showed
`added_to_merge_queue` with no removal. Any PR enqueued after 2026-08-20 10:40
would have done the same, so this was a repo-wide stop, not one branch's problem.

**Root cause (traced).** The `main` ruleset (id 20119902) requires four
contexts: `backend-typecheck`, `frontend`, `company-scope-ratchet` and
`completeness-claim`. The first three are jobs in `ci.yml`, which declares
`on: pull_request` **and** `merge_group`. `completeness-claim.yml` declared
`on: pull_request` only. A required context must report on the MERGE GROUP, not
just on the PR, so the queue waited for a check that could never arrive.

The ruleset's `updated_at` is `2026-08-20T10:40:56+08:00`; #2516 was enqueued at
`10:51:26+08:00`, eleven minutes later. #2514 and #2515 merged earlier the same
morning, and #2514's merge-group head carries no `completeness-claim` check
either — it merged because the context was not required yet. So the requirement,
not the workflow, is what changed.

**Why the workflow cannot simply run there.** Its inputs are the PR title, body
and labels — its own header says so, and explains that this is why it is not a
job inside `ci.yml`. A `merge_group` event has no pull request attached, so
there is no claim to reproduce. Two things would have broken if it were merely
given the trigger with nothing else changed:

- the checkout pins `ref: github.event.pull_request.head.sha`, which is empty on
  a merge group. It would resolve to the default branch and the gate would
  quietly measure the wrong tree rather than fail;
- `concurrency.group` keys on `github.event.pull_request.number`, also empty, so
  every merge group would share one group named `completeness-` and
  `cancel-in-progress` would cancel the previous group's run. **A cancelled
  check is not a passed check**, so that jams the queue a second time, in a form
  that looks like flakiness rather than a rule.

**Fix.** The job answers immediately on `merge_group` and does no work,
reporting the verdict already reached against the same content on the PR run
that let the PR be enqueued. Every real step is guarded
`if: github.event_name != 'merge_group'`, and the concurrency group falls back
to `github.ref` when there is no PR number. The job NAME is untouched, because
the ruleset matches on that string and renaming it would silently un-require the
gate.

The gate keeps its teeth where they belong: on the pull request, where the claim
exists and where the author can still fix it.

**Ref.** ci/completeness-claim-reports-on-merge-group, 2026-08-20. The gate
itself is `4a7c4eb6` (weisiang329-eng, 2026-08-13) and is not at fault — it was
correct as an advisory PR check; only promoting it to required exposed the
missing trigger.
