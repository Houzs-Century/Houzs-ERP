## A write that refuses in silence is now gated, in the 943 raw calls the old checker could not see [medium]

**Symptom.** Two separate silent-refusal bugs shipped on 2026-08-21 while
`frontend/scripts/check-silent-mutations.mjs` reported `0 SILENT`: six Fleet
Health writes (`docs/bugs/0489-fleet-health-refused-six-writes-in-silence-under-a-comment-c.md`)
and the Post GRN / Post Purchase Invoice commits
(`docs/bugs/0490-post-grn-and-post-purchase-invoice-had-no-error-path-and-the.md`).
On the phone, a PMS photo caption and a checklist remark typed on blur were
discarded by a refused PATCH with the typed text still on screen, so the box
looked exactly like a saved one.

**Root cause (traced) — of the GAP, not of any one bug.**
`check-silent-mutations.mjs` is narrow in two ways it does not claim to cover:

1. **Its corpus is `useMutation(`** — 303 call sites. There are **943** raw
   write calls (`api.post/put/patch/del`, `authedFetch` with a write method,
   `portalApi.*`) across **141** files in `frontend/src`, and it never looks at
   one. Fleet Health writes with raw `api.*`.
2. **Its verdict is per HOOK, not per CALL SITE.** `consumerHandles()` returns
   true as soon as ANY consumer file awaits `mutateAsync` or reads `.isError`,
   so ONE handling consumer clears every other consumer of the same hook.
   `usePostGrn` was CAUGHT on the strength of `GrnNew.tsx`'s
   `await post.mutateAsync(...)` while three other call sites passed nothing.

**Fix.** `frontend/scripts/check-silent-writes.mjs`, wired `--strict` into
`ci.yml` beside its sibling, plus `npm --prefix frontend run check:silent-writes`.
It asks one smaller question per SITE: a write ran inside a `try`, it threw —
did anything happen? A catch passes if it SURFACES (toast / dialog / error state
/ console.error / rethrow) or RECORDS (a tally, a flag, a returned failure) or
carries `// silent-write-ok: <reason>` at the site.

Measured on the tree it landed on: **287 write-inside-try sites — 252 SURFACE,
20 RECORD, 15 WAIVED, 0 SILENT.** The backlog was judged in the same PR rather
than left as a number: 15 deliberate no-ops marked with their reason at the
site, and the two PMS remark saves fixed
(`frontend/src/mobile/MobilePmsRemarkSave.test.tsx`, proved RED first —
`Unable to find an element with the text: /not saved/i`, `Tests 2 failed |
1 passed`, then `3 passed`).

**What it cannot see, so a clean run is not over-read.** A dropped promise with
no `try` (that is `@typescript-eslint/no-floating-promises`); a 200 that reports
its failure in the body (that is `check-inband-failures.mjs`); and a failed READ
rendered as a confident state — the 2FA "Enable" button on an account that had
2FA on, the trial balance reading "books balance" off a ledger it never loaded.
That last shape has no `catch` to look at; a regex over `?? []` produced 1,277
candidates and no findings when tried, so it is deliberately NOT gated and is
written down as a reader's job in the script header.

**Proved three ways, not two.**
- Clean tree, `--strict`: `0 SILENT`, exit **0**.
- WRITE pattern deliberately broken (`api` -> `apiZZZ`): `internal pattern
  self-test FAILED — not reporting`, exit **2**. A verdict computed over nothing
  must never read as a pass — this repo broke that rule five times in one day.
- One `catch { /* surfaced on reload */ }` re-introduced into FleetHealth.tsx:
  `1 SILENT`, exit **1**; reverted, exit **0**.

**Ref.** chore/gate-silent-writes, 2026-08-21.
