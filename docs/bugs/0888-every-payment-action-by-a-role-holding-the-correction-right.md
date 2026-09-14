## Every payment action by a role holding the correction right owes a reason and is listed with who first recorded the payment [medium]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, reading the Corrections tab after his own two
payments of the morning (2990-SO-2606-025, 2990-SO-2608-004) did not appear on
it: 「然后这个 correction 我想要看到是原本谁记录的，然后还要就是我如果记录新的
payment，其实也算是 correction，他们没有 update on time」; asked whether that
meant every payment action: 「只要是有关 collection payment 的，我或有权限的用户
做的动作都要记录写 reason。所以这一页不单单是 correction，也是 amend、update 都
算」; and on whom it should reach: 「可以不可以先我这边设计成 finance 和我的一定
要填？」— HOUZS CENTURY, the Owner account Houzs's admin uses, stays as it is.

**Root cause (traced).** Three facts the report could not hold. (1) The reason
rule hung on ONE door — `paymentRowMutable(...).via === 'amend'`, a correction
the amend right opened after the day the payment was keyed. A holder's
same-day edit, any add (`POST /:docNo/payments` took no reason at all), any
delete on the day, and the proof attach (`POST /:docNo/payments/:id/slip`,
deliberately outside the window) wrote a plain `web` audit row, and the report
filters `source = 'amend'`. (2) The rule could not tell Finance from the
Owner: `hasHouzsPerm` honours `*`, so "holds the key" was true of every god
position, and a rule keyed on it would have asked HOUZS CENTURY too. (3)
`mfg_so_audit_log` rows name the ORDER (`so_doc_no`) and never the payment,
so "who recorded this payment first" had no trail from a correction row to
the ADD_PAYMENT row it concerns — only a guess among the order's adds.

**Fix.**

*The key, read literally.* The four payment routes in
`scm/routes/mfg-sales-orders.ts` ask one rule, `paymentReasonRule`
(`scm/lib/so-payment-reason.ts`, unit-tested against a caller shaped like the
context), which reads the key through `holdsHouzsPermLiterally(c,
SO_PAYMENT_AMEND)` (`hasPermissionLiterally`: the `*` wildcard does not
count) and answers the refusal and the audit mark. A ROLE that
carries the key in its own list — granted under Team > Roles & Permissions,
the Roles section; it is a flat key, not a position capability — owes a
reason on the add (`paymentCreateSchema.reason`), on the edit and the delete
(`via === 'amend' || keyHolder`), and on the proof attach
(`paymentSlipAttachSchema.reason`); refused without one with
`KEY_HOLDER_REASON_REQUIRED`, a sentence under 200 characters naming
Accounting › Corrections. The WINDOW is unchanged: `mayAmend` still comes from
`hasHouzsPerm`, a reconciled payment stays shut to everybody, the Owner's `*`
still corrects after the day with a reason, Sales positions are as they were.
Every such row is audited `source = 'amend'` with the reason in `note`
(`recordSoPaymentRow` takes `auditSource` / `auditNote` from the POST; the
proof route's note is the reason, its `slipKey` change still says attach vs
replace).

*The payment on the row.* Migration
`backend/src/db/migrations-pg/20260914T1700_scm_so_audit_log_payment_id.sql`
adds nullable `payment_id` to `scm.mfg_so_audit_log` with a partial index;
`recordSoAudit` takes `paymentId`, set by the add (`so-payment-row.ts`), the
edit, the delete, the proof attach and both SO-create deposit rows.

*The report.* `GET /accounting/payment-corrections` reads the three payment
actions with `source = 'amend'` PLUS — the owner's two adds from before the
rule, 规则之前 — the `web` rows of the month whose actor name is a current
literal holder (`usersHoldingPermission`, which already excludes wildcard-only
roles, then `users.name`), marked `beforeRule` with no reason; a holders read
that fails refuses the report. `acc/payment-corrections.ts` adds the kinds
`added` and `proof` (an UPDATE_PAYMENT whose only change is `slipKey`), the
summary's `added` / `proof` / `addedSen`, and `recordedBy` / `recordedOn`
resolved in order: the ADD_PAYMENT row by `payment_id` (its actor); the
payment row's collector when that ADD row names nobody (the scan job's
receipts) or predates the tagging; for an untagged correction the order's own
earlier adds, named only when exactly one fits (the amount the correction
started from tells two apart) — otherwise a dash, never a guess.

*The screens.* `frontend/src/auth/literalPermission.ts` is the client's
literal reading (`user.permissions` is the role's list plus the injected
wildcard, so a Super Admin on a role naming the key holds it and keeps `*`);
`vendor/scm/lib/payment-reason.ts` is the one home for WHEN a payment action
asks (`reasonWhyFor`: the holder rule first, else the amend right) and in
what words (`paymentReasonAsk`). Desktop `PaymentsTable` asks on the add (the
row's Save and the page's Save, a dismissed ask reported as blocked), the
edit, the delete and the proof; mobile `RecordedPayments` the same, its sheet
told `reasonWhy` by the list and `MobileSODetail`'s standalone add sheet by
the holding. The proof mutation carries `reason`. The Corrections tab lists
every kind under its pill, adds a **First recorded by** column, prints *Before
the rule* in the reason column, filters by "Done by", and the printed report
(`payment-corrections-pdf.ts`) carries the same six columns. The permission's
description in `services/permissions.ts` says what holding it now means.

*Housekeeping the size gate asked for.* `mfg-sales-orders.ts` may only
shrink, so the CAS rollout grace window and `paymentVersionGuard` moved
unchanged to `scm/lib/so-cas.ts`, re-exported from the route for the two
suites that import them there.

*Not changed, on purpose.* The two deposit rows SO create books stay
`automation` rows with no reason (a Sales action; the owner's rule is about
the payments card); consignment-order payments are a different ledger and
untouched; a role WITHOUT the key is exactly as before.

Proved RED on the unfixed tree (the sources stashed, the new tests run):
`tests/soPaymentAmendRoutes.test.ts` (the four routes asking the one rule,
answering its refusal, carrying its audit mark and tagging the row, the add
and proof schemas carrying `reason`), `scm/lib/so-payment-reason.test.ts` (the
rule itself, against Finance, the Owner, Sales and a custom role holding both),
`acc/payment-corrections.test.ts`
(the kinds, the before-the-rule rows, the recorder resolutions),
`scm/routes/paymentCorrectionsRoute.test.ts` (the add listed, the
before-the-rule row through a fake Houzs DB, a wildcard-only role not a
holder, the recorder per row, a failed holders read refusing); frontend
`soPaymentAmendClients.test.ts` (both screens read the literal holding and
ask on the add and the proof), `PaymentCorrectionsTab.test.tsx` and
`payment-corrections-pdf.test.ts` (the new columns and kinds).
`auth/literalPermission.test.ts` and `lib/payment-reason.test.ts` pin the
new modules.

**On the owner.** FINANCE's role ("Finance") already names the key, so
Finance is under the rule the day this deploys. His own account is on the
system "Super Admin" role (`["*"]`, locked, shared with three others): to put
himself under the rule he makes a custom role naming the key under Team >
Roles & Permissions and assigns it to himself — the Super Admin position keeps
his `*`. HOUZS CENTURY (the Owner role: `*` plus approvals, no literal key) is
unchanged.

**Ref.** feat/payment-actions-reason-for-key-holders, 2026-09-14.
