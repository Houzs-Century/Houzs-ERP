## Move up / Move down on a category did nothing when the server refused it [medium]

**Symptom.** The owner's canonical shape: press the kebab menu's "Move up", the
card stays where it was, nothing is said. Indistinguishable from a dead button.

**Root cause.** `Categories.move()` (frontend/src/pages/scm-v2/Categories.tsx)
fires `updateMut.mutate(...)` twice — fire-and-forget, nothing awaits it — and
`useUpdateCategory` carried an `onSuccess` and no `onError`. The page's OTHER
consumer of the same hook, `CategoryForm.onSubmit`, awaits `mutateAsync` in a
try/catch and renders `errMsg(e)`, so the SAVE path was always loud and only the
REORDER path was mute. A hook is not safe because one of its callers is: the
verdict has to be taken per call site.

**Fix.** Per-call `onError: writeFailedAs('Category order not changed')` on both
`.mutate` calls in `move()`, leaving the form's inline error panel untouched. The
same sweep closed 37 other mutations that had no error path at all — every one of
them an exported hook in `frontend/src/vendor/scm/lib/*-queries.ts` with ZERO
callers today, so nothing was broken for a user yet; they now carry
`writeFailed` / `writeFailedAs` so the first page wired to one cannot inherit the
silence. `check-silent-mutations.mjs` went 41 UNRESOLVED to 0.

**Lesson.** `check-silent-mutations.mjs` resolves a hook by asking whether ANY
consumer handles the failure. That is the right question for reporting and the
wrong one for a verdict — `useUpdateCategory` would have passed on the strength of
the consumer that was fine. Also: a stale comment sent the reader the other way —
`grn-queries.ts` still describes `usePurchaseReturnFromGrn` as "a context-menu
action on a LIST row (GoodsReceived.tsx)", and that file no longer exists and no
caller does either.

**Ref.** branch `fix/company-scope-sweep`, 2026-08-13.
