## Posting a payment voucher stamped a journal entry into the other company's ledger [high]

**Symptom.** None at the keyboard. `POST /payment-vouchers/:id/post` accepted a
voucher id from either company and wrote the GL entry against whichever company
that voucher belonged to.

**Root cause.** The handler loaded the voucher by id with no company predicate,
then built the journal entry from `pv.pv_number`, `pv.credit_account_code` and
`pv.company_id` — so the leak was not a read of someone else's data, it was a
WRITE into someone else's books. The sibling paths were already correct: the GET
at `:208` scopes this exact read, and `cancelPaymentVoucherHandler` was hardened
by PR #826. Post is the same door and was the one left unlocked. RLS is not a
backstop here: mig 0061 enabled it with NO policies and the SCM client is the
service-role client, which bypasses it.

**Fix.** `requireActiveCompanyId` + `scopeToCompanyId` before the load, refusing
with the shared `NOT_THIS_COMPANY` 404.

**Lesson.** Found TWICE, independently — by this audit and by #2086 — and the two
fixes were byte-for-byte the same idea. An audit that hardens "the reads" and
stops has done half a job; the write paths are where the damage is, and they are
easy to miss precisely because a write path usually starts with a read.

**Ref.** #2086 and audit ledger §A, 2026-08-13.
