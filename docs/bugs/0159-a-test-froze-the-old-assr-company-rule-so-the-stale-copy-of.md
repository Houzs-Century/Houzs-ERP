## A test froze the OLD ASSR company rule, so the stale copy of it looked correct [medium]

**Symptom.** None visible, and that is the finding. When this branch deleted
`search.ts`'s private copy of `assrCompanySql` — a copy still applying a HOUZS
pin the owner removed on 2026-07-20, so a 2990 rep saw HOUZS service cases and
missed their own — `tests/searchScope.test.ts` went RED. The obvious reading was
that the fix had broken something. It had not. The test was the second stale
artifact.

**Root cause (traced).** PR #934 (`dc16fb2e`, 2026-07-21) deleted
`assrPinsToHouzs()` and the `houzsCompanySql` branch, leaving
`assrCompanySql(c, col) = allowedCompaniesSql(c, col)` — no role consulted at
all (`routes/assr.ts:141`). It updated `assr.ts` and
`tests/assrCompanyScope.test.ts` and missed TWO other places that held the old
rule: the private copy in `search.ts` and `tests/searchScope.test.ts`, whose
`toEqual([9001])` is a frozen snapshot of the pre-#934 pin (last touched by #910
and #859, both older than #934).

**Two stale artifacts agreeing with each other is why neither looked wrong.**
The test asserted the copy's behaviour, the copy satisfied the test, and the
pair was self-consistent and jointly wrong for three weeks. A drift only becomes
visible when something OUTSIDE the pair is compared against it.

**Fix.** The test now asserts the real rule, plus the direction nothing covered:
a Sales rep granted only 2990 sees ONLY the 2990 case. That is the half of the
old pin's damage that was invisible — it did not merely add HOUZS cases the rep
holds no grant for, it HID the rep's own.

**Lesson.** A test is a copy of a rule, and it rots exactly like the code copies
`check-shared-mirrors` exists to referee. When a rule changes, grep for its
NAME across `src` AND `tests` before deciding the change is complete — #934
changed the rule in one file and left it standing in two others.

**Ref.** #934 (the original miss), this branch (both copies removed), 2026-08-13.
