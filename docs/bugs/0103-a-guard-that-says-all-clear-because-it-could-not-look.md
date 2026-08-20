## A guard that says "all clear" because it could not look [high]

**The shape, named** — a Supabase read destructures `data` (or `count`) and
DROPS `error`, so a query that FAILED arrives as `data ?? []` / `count ?? 0` —
i.e. as **an absence** — and the absence is the very thing that authorises the
next write. This is the sibling of the ZEROING shape already recorded in this
file (discarded-error read → `?? []` fold → money column written as 0). Same
destructure, different consequence: the zeroing shape writes a wrong NUMBER,
this one writes a document that should have been REFUSED.

**The rule, in one line** — *a failed read must never read as an absence when
the absence is what authorises the write.*

**The worked example: payment vouchers double-posted to the GL.** `POST
/payment-vouchers/:id/post` asked whether a journal entry already existed for
the voucher with `const { data: existingRows } = await sb…`. On a read failure
`existingRows` is `undefined`, `?? []` makes that "no journal entry exists", the
idempotency check passes, and the handler posts a **SECOND** journal entry
against the same voucher — the supplier payment hits the GL twice, and nothing
anywhere logs why. Fixed 2026-08-13; the read now returns 500 with the
database's own message rather than deciding the voucher is unposted.

**Why grep-by-name never finds these.** The dangerous ones are not spelled
`existingRows`. They are helpers with reassuring names — `soHasDownstream`,
`piLocked`, `findServiceLineCodes` — whose contract is "returns the refusal, or
null if the document is free". `null` is the answer for BOTH "I looked and there
is nothing" and "I could not look", and only one of those may end in a write.
Grep for the SHAPE (`const {` … `data` … no `error`), then keep only the reads
whose empty result authorises something.

**Measured 2026-08-13 at `origin/main` 2bde7bd9** — `backend/src` holds **1791**
`const { data` destructures outside tests, of which **972 bind no `error` at
all** (**959** of those in `backend/src/scm`), plus **23** `const { count`
destructures with no `error`. The class is endemic; the subset that matters is
the one where the absence authorises a write. `sweep/swallowed-error` converted
**12** of them (8 `data`, 4 `count`) — every GUARD HELPER in SCM whose all-clear
verdict lets a mutation through:

- `scm/lib/downstream-lock.ts` — `liveCount` + `grnHasDownstream`. The owner's
  2026-08-10 rule ("已经转到下游的单据, AutoCount 不许取消/改动") is enforced here for
  SO / PO / DO / GRN at ~30 call sites. One dropped `count` and a **shipped SO
  was cancellable again**. Now refuses with `downstream_check_failed`; call
  sites already 409 on any refusal, so nothing else changed.
- the four route-local clones of that same guard, which the shared module never
  absorbed: `pcoHasDownstream` (`purchase-consignment-orders.ts`),
  `coHasDownstream` (`consignment-orders.ts`), `pcReceiveHasDownstream`
  (`purchase-consignment-receives.ts`), `noteHasDownstream`
  (`consignment-notes.ts`).
- `purchase-invoices.ts` `piLocked` — a failed read answered "not locked", so a
  **PAID or CANCELLED invoice became editable**.
- `scm/lib/service-line-guard.ts` `findServiceLineCodes` — the catalog read is
  the half that catches a payload lying about `item_group` AND code prefix. A
  failed read returned `[]`, indistinguishable from "all clear", and the SERVICE
  line went into a Delivery Return, which **writes phantom stock IN**. Now
  returns `{ ok: false, reason }`; the four DR call sites refuse on it.
- `scm/lib/allowed-options-check.ts` `loadProductAndModel` /
  `loadProductsAndModels` — the file's own header had **named this bug in
  writing since 2026-08-01** ("the discarded error becomes `product = null`,
  which this gate reads as allowed") and left it in place. A duplicated code
  across companies returns PGRST116, not a row; the variant gate then stopped
  checking instead of stopping the line. Now carries `lookupError`, and all 8
  call sites in `mfg-sales-orders.ts` / `consignment-orders.ts` 409 on it.

**Deliberately NOT fixed here, and why** — the **post-insert over-receipt /
over-invoice / over-return verifiers** (`grns.ts` `verifyGrnOverReceipt` +
add-line, `purchase-invoices.ts` `verifyGrnLinesNotOverInvoiced` + add-line,
`purchase-returns.ts`, `purchase-consignment-receives.ts`,
`purchase-consignment-returns.ts` — 8 sites). They carry the same swallow with a
worse consequence: a failed read leaves an over-quantity row COMMITTED. But
`verifyGrnOverReceipt` states an explicit policy — *"Best-effort: a verification
read failure must not block the receipt"* — and making them fail closed means
409-ing legitimate receipts on a transient blip. That is a policy the owner
should choose, not a bug fix. Note the policy comment is also **inaccurate**: it
describes the `try/catch`, and a PostgREST error is RETURNED, not thrown, so the
`catch` never sees the case it claims to cover. Corrected in place.

**Checked and found FAIL-CLOSED — no change needed** (recorded so nobody
re-opens them): `scm/lib/validate-item-codes.ts` (a failed read makes every code
unknown → 409), `scm/lib/check-stock-availability.ts` (a failed balance read
makes every line short → blocks), `scm/lib/so-confirm-gate.ts`'s catalog read
(failed → every code non-catalog → refuses), `scm/lib/amendment-command.ts:147`
(a failed post-23505 lookup throws `command_enqueue_failed`, it does not enqueue
twice). Duplicate-code checks backed by a real unique index —
`threepl-companies.ts` code mint, `warehouse.ts` rack seeding — degrade to a
23505 and a wrong error message, never a duplicate row; left, and listed.

**Lesson** — **a helper whose return type cannot express "I could not look" will
eventually answer "nothing found", and the caller will spend that as
permission.** Every guard fixed here returned `X | null`, and every one of them
was correct code for the happy path. The type was the bug. Where a guard's
verdict authorises a mutation, give the failure its own value — a refusal, a
`lookupError`, an `ok: false` — and let the call site decide; do not let it
share a representation with "clear to proceed".

**Ref** — `sweep/swallowed-error`, 2026-08-13. Backend only; **no migration**.
Tests: `downstream-lock.test.ts` (new failed-read cases),
`service-line-guard.test.ts` (new file),
`product-lookup-company-scope.test.ts` (the "silently passes" case now pins the
reported PGRST116 instead).
