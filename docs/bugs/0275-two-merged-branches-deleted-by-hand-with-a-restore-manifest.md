## Two merged branches deleted by hand, with a restore manifest [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

`delete_branch_on_merge` is ON and works — verified by listing every branch from
this session's PRs and finding all thirteen gone. These two merged BEFORE the
setting took effect and GitHub does not apply it retroactively, so they were the
last of that set.

Selected on the PR being MERGED, never on age — `fix/bug-index-area-tags` is
PR #2202 and `fix/file-size-rebaseline-is-not-a-thing` is PR #2207, both
verified merged before deletion. `sha<TAB>branch` recorded in
`docs/branch-manifests/2026-08-15-post-setting-leftovers.tsv`, committed BEFORE
the delete so the restore information outlives the branch.

**Ref.** 2026-08-15.
