## A conversion payload named no customer, so the service had to look one up [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The ERP half of the outage fixed in #2340. A conversion whose target
carries no `DebtorCode` when the transfer runs is refused by AutoCount — PROVEN
on the host, 2026-08-17 00:55 — and `enqueueConvert` composed
`{ DocNo, DocDate?, Ref?, DtlKeys? }` with no account in it at all.

**Root cause (traced).** Nothing chose to omit it. The conversion payload was
designed around "the target inherits everything from the source", which is true
of the LINES and false of the master: `cmd.AddNew()` creates the target empty and
the transfer will not run against an empty account. The ERP has always known the
customer — every sales document in this book goes to `AC_DEBTOR_CODE` — and
simply never said so.

**Fix.** `enqueueConvert` sends `DebtorCode: AC_DEBTOR_CODE` on the two SALES
conversions. The set is DERIVED from `CONVERT_TARGET` rather than hand-listed, so
a fifth conversion joins it on its own if its target is a sales document; a
second hand-written list of ops is the duplicated-list bug this repo keeps
paying for.

**The purchase half is deliberately NOT done**, and the reason is cost, not
principle: `scm.grns` and `scm.purchase_invoices` carry no supplier column, so a
`CreditorCode` here needs a `grn -> purchase_order -> supplier` join, and
`po_to_gr` has never once succeeded anyway — it fails earlier, on
`IndexOutOfRangeException: There is no row at position -1`. Both purchase
conversions stay on the service's book fallback. Divergence **D15** stays on the
register for that half, dropped from `high` to `medium`.

**KEEP THE BOOK FALLBACK.** #2340 made the service read the account off the
source document when the payload names none, and this change does not retire it:
it is the only thing that drains an outbox row composed before today, and it is
the whole purchase side. A lookup that quietly stops being exercised is a lookup
someone deletes.

**Test.** `autocount-writeback.contract.test.ts` — "the SALES conversions put the
debtor on the wire, and the purchase ones do not". Verified to FAIL when the
change is reverted (`expected undefined to be '300-C002'`), because a new
assertion that passes against both trees is not a test.

**Not fixed here, and worth someone's attention:** the four whole-body conversion
assertions in that file are all `test.skip` and have rotted — `SO -> DO` still
carries the comment *"No `DtlKeys` on purpose"*, which stopped being true when the
ERP started naming lines. The skip fence counts them (11) but nothing checks what
they claim.

**Ref.** PR for `feat/convert-payload-carries-the-account`, 2026-08-17.
Follows #2340.
