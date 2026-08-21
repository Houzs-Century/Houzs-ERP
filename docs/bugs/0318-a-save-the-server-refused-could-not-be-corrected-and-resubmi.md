## A save the server refused could not be corrected and resubmitted [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Creating a GRN from a PO was refused by a correct business guard
(`zero_cost_receipt`). Entering the unit price it asked for and submitting again
answered 409 `idempotency_key_reused` — "This request key was already used for
different data." Only a full page reload recovered, losing everything typed.

**Root cause (traced).** `useIdempotencyKey()` mints one key per form mount and
deliberately never rotates — correct, because a retry after a COMMITTED write
must replay rather than book twice. What it did not distinguish is a refusal that
wrote nothing. The obvious client-side fix is wrong and was rejected in review:
`middleware/idempotency.ts` compares the request hash BEFORE it looks at
`status_code`, so `key_reused` is also what a committed 201 answers when the
payload changes — rotating on it would have told the operator to resubmit and
booked a duplicate document.

**Fix.** Decided on the server, where the outcome is known. A pre-write refusal
answers through `lib/no-write-refusal.ts` `refuseWithoutWriting`, which releases
the claim; `keyReuse` now returns `completed_status` so the client can tell the
two apart. 27 create forms — including five mobile screens — are covered without
touching their call sites. `tests/grnPreWriteRefusalsReleaseKey.test.ts` pins
that no refusal preceding a write answers with a bare `c.json`; it caught one
this very merge missed, at `grns.ts:3275`.

Ref: PR #2382, 2026-08-18.
