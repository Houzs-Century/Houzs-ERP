## "Create Service Case" stayed grey, and the screen could not say why [high]

**Symptom.** 2026-08-19, a salesperson on mobile: the SO field held `SO-005263`,
the line under it read **"No matching sales orders."**, and the *Create Service
Case* button stayed disabled. Reported as "I cannot submit" — the submit is fine,
the form refuses to submit without a linked order.

**Root cause (traced, not guessed).** `useSoSearch` in
`frontend/src/mobile/MobileServiceCase.tsx` destructured only `{ data,
isFetching }` from its `useQuery` and returned `data?.results ?? []`. **The error
was dropped**, so a REFUSAL rendered byte-identical to an honest empty answer.

That matters here because `GET /api/assr/search-so` is gated by
`requireServiceCaseAccess()`, which **403s without `service_cases.read`** — and a
person can hold the permission that OPENS the Service Case form without holding
that one. Their every search then returns nothing, with no reason given, forever.

**What it actually cost.** Two hypotheses were raised and both were guesses,
because the screen carries no information to separate them: (a) the person is not
granted HOUZS, so `assr.ts:1256` skips the AutoCount mirror where a bare
`SO-XXXXXX` lives; (b) the order never synced. The owner refuted (a) by hand.
Neither could be settled from the report.

**Fix.** The hook returns `error`, and the picker renders it in red INSTEAD of
"No matching sales orders" — a refusal now reads as a refusal. This is the bug
class `CLAUDE.md` names as *"a failure that reaches nobody is worse than a
crash"*, and the reason `check-silent-mutations` exists; that gate covers
`useMutation`, not `useQuery`, which is how this one survived.

**Also shipped, so the next report is not a guess either:**
`backend/scripts/check-so-visible-to-user.mjs` + a `workflow_dispatch` that takes
the SO number and the person's name and prints WHICH cause it is — not in the
mirror, in the mirror but spelled differently (it re-searches on digits alone),
or present-and-visible so the answer lies in that person's grants.

**Ref.** `fix/impersonate-presence-rbac-scoped`, 2026-08-19.
