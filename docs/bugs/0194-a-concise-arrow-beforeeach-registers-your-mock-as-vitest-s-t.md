## A concise-arrow beforeEach registers your mock as vitest's teardown [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** One test in `frontend/src/pages/autoCountSync.test.tsx` failed in
26 ms with `Error: the queue is unreachable` — the exact error the test had
armed with `mockRejectedValue` — attributed to the line that CONSTRUCTED the
Error, before any assertion could run. The page was fine: rendering it with the
same rejection in a scratch file passed.

**Root cause, traced, not guessed.** The file had
`beforeEach(() => apiGet.mockReset())`. `mockReset()` is chainable and returns
the mock, so the concise arrow RETURNS A FUNCTION — and vitest calls a function
returned from a hook as that test's teardown. So vitest invoked `apiGet()` after
every test; in the one test that had armed a rejecting implementation, the
teardown's rejected promise was awaited and became the test's failure.

Proven by bisection (adding braces fixed it; `mockClear` instead of `mockReset`
did not; a `QueryCache` `onError` did not — so it was never an unhandled React
Query rejection) and then directly, with a two-test probe whose `beforeEach`
returned a counter-incrementing function: the counter read `1` at the start of
the second test.

**Fix.** Braces instead of a concise arrow at both sites that had the shape —
`frontend/src/pages/autoCountSync.test.tsx` and
`frontend/src/vendor/scm/lib/so-versioned-mutation.test.ts` — each with a comment
naming the trap. The second was latent rather than failing: every test there arms
`...Once` implementations, which its own calls consume, so the teardown call
found an empty mock and returned `undefined`. It would have broken on the first
plain `mockRejectedValue`.

**NOT fixed here, and it is the thing that stops the third one:** no check
catches this shape. `grep -rEn 'beforeEach\(\(\) => [A-Za-z_$][A-Za-z0-9_$.]*\.mock[A-Za-z]*\('`
over `frontend/src`, `backend/src` and `backend/tests` found exactly the two
sites above, so the tree is clean today — which is precisely when a lint rule is
cheap to add. Filed as a follow-up.

**Ref.** 2026-08-15. Lesson: **an error attributed to a line that cannot explain
it is a harness bug, not a code bug.** The instinct was to blame React Query's
error handling; it took a scratch reproduction that PASSED to turn the search
around and look at the hook.
