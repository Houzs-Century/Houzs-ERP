## A merge left conflict markers in a script and only the ops-script parse test caught it [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- status: fixed -->

**Symptom.** PR #3228 went red on `backend-typecheck`:

```
/home/runner/work/Houzs-ERP/Houzs-ERP/backend/scripts/probe-gr-iv-pi-remainder.mjs:45
<<<<<<< HEAD
^^
SyntaxError: Unexpected token '<<'
 ❯ tests/opsScriptsParse.test.ts:36:62
```

Unresolved conflict markers were committed and pushed inside a script and inside
a bug-ledger entry.

**Root cause (traced).** `git merge origin/main` conflicted in TWO files. The
command was run as `git merge origin/main --no-edit -q 2>&1 | tail -3`, and
`tail -3` cut the output down to the LAST conflict line plus the summary — so
only `docs/cutover-gr-iv-pi-remainder-2026-09-08.md` was seen and resolved.
`git add -A && git commit --no-edit` then committed the second file with its
markers intact, because `git add` on a conflicted path is exactly how you tell
git a conflict is resolved. Nothing local objected: `node --check` was run on the
file that HAD been fixed, not on the one that had not.

Two independent lessons, and the second is the one that generalises:

* **Never pipe a merge's output through `tail`.** A conflict list is the one
  output whose LENGTH is the information.
* **`git add -A` after a merge is an assertion that every conflict is resolved.**
  The cheap check that would have caught it in one second is
  `git grep -n -e '^<<<<<<< ' -e '^>>>>>>> '`, and it belongs before the commit,
  not after CI.

**Fix.** Markers stripped from both files, keeping this branch's side, which is
what the resolution had already decided in the file that was seen.
`node --check backend/scripts/probe-gr-iv-pi-remainder.mjs` clean and
`git grep -n -e '^<<<<<<< ' -e '^>>>>>>> '` returns nothing across the tracked
tree.

**What already worked, and needs no change:** `backend/tests/opsScriptsParse.test.ts`
parses every script in `backend/scripts` and it failed loudly, in
`backend-typecheck`, which is a REQUIRED status check — so the merge was blocked
rather than landing. That gate did its whole job; the defect was upstream of it.

**Ref.** fix/gr-iv-pi-remainder, PR #3228, 2026-09-08.
