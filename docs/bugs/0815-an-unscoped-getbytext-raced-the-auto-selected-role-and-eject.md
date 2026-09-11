## An unscoped getByText raced the auto-selected role and ejected three PRs from the merge queue [medium]

**Symptom.** `frontend/src/pages/team/TeamRolesV2.test.tsx` > "opens on the
Roles section" failed intermittently with

```
TestingLibraryElementError: Found multiple elements with the text: Owner
```

and passed on a re-run with no code change. `frontend` is a REQUIRED status
check and `main` runs a merge QUEUE, so each occurrence ejected whatever was
being merged. On 2026-09-11 it did that **three times** to two unrelated PRs
(#3646's branch, then #3657 twice), each time costing a full queue round.

**Root cause (traced).** Line 77 asserted `screen.getByText("Owner")`
unscoped. `Owner` is a SYSTEM role and the page AUTO-SELECTS it — the test's own
comment two lines below says so — so once that render lands the name is on
screen TWICE: once in the role list and once in the selected-role header.
`getByText` throws on more than one match. Whether the auto-select render had
landed by line 77 was a race: the preceding `waitFor` gates on `MD`, the CUSTOM
role, which says nothing about the Owner header.

So the test was not flaky about the code under test. It was flaky about its own
query.

**Fix.** `expect((await screen.findAllByText("Owner")).length).toBeGreaterThan(0)`.
That asserts what the test's title claims — the role list came from
`/api/roles` — and cannot race: `findAllByText` waits, and ALL tolerates the
header. Nothing else in the test changed; the matrix assertions below it still
click `MD` and wait for `Approve`.

Verified by running the file **three times in a row**, 3 passed each time. A
single pass does not prove a flake is gone.

**The wider lesson, which is the reason this is in the ledger at all.** An
unscoped text query against a list that also renders a SELECTED copy of the same
row is a bug class, not a one-off: any list-plus-detail screen has two places
for one name. Prefer `findAllByText`, a scoped container, or a testid. And a
required check that fails intermittently is worse than one that fails always —
it trains everybody to re-run instead of read.

**Ref.** `fix/teamroles-owner-flake`, 2026-09-11.
