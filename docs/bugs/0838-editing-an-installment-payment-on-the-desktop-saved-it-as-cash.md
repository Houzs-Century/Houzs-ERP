## Editing an installment payment on the desktop saved it as cash [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Finance opened an `installment` payment on the desktop
Payments card to correct one field and pressed Save; the row came back as
`cash` — plan cleared, Account Sheet "Card terminal" → "Cash", the receipt
journal reversed and re-posted into cash — and had to be edited a second
time back to Merchant + bank + plan. Prod audit log, 2026-09-12 14:53–15:02
(actor Chew): SO-2606-013 (amount 3,365 → 3,565) and SO-2606-026 (approval
code) both went installment → cash on the first save. Owner: 用 finance 权限改
资料时 payment method account 会跳掉去 cash … 应该是设计成我按 edit 时默认会已
输入的资料啊，我只会 edit 我想要 edit 的东西罢了. One earlier row looks like the
same fall: SO-2608-029, 22/08, RM 2,970, method cash with approval code
561887.

**Root cause (traced).** `labelToApi` in
`frontend/src/vendor/scm/components/PaymentsTable.tsx` resolved the method
value through the shared `PAYMENT_METHOD_VALUE_TO_CODE`, which deliberately
lists only Merchant / Online / Cash — it is the LOCK list of protected L1 rows,
Installment having become "the plan under Merchant" on 2026-06-24 — and on a
miss logged a console warning and returned `cash`. The edit draft rehydrates a
stored `installment` row as the value 'Installment' (`PAYMENT_METHOD_CODE_TO_VALUE`
has it), so every save of such a row fell through to cash; the server then saw
the method change, judged the sheet "Card terminal" a stale auto-fill and
re-derived "Cash". 2990 still runs an active L1 Installment row and holds 44
installment payments (28 without a bank); nine callers share the resolver, so a
NEW payment keyed as Installment on the desktop was saved as cash too. The
mobile app sends codes directly and was never affected.

**Fix.** `labelToApi` resolves all four values the ledger stores through the
inverse of `PAYMENT_METHOD_CODE_TO_VALUE` and REFUSES a value none of the four
(`UnknownPaymentMethodError`, shown by the desktop's three commit paths: the
in-place edit, Save on a row, the page's Save of every row) — never a silent
substitute. `editDraftOf` seeds the edit draft verbatim from the persisted row,
and a stored code the screen does not know opens under its own name instead
of as Cash. The shared lock map is untouched; the dropdown row stays as the
owner left it.

Pinned by `frontend/src/vendor/scm/components/PaymentsTable.test.ts`: the four
values resolve (Installment → `installment`); an unknown value throws by name;
an installment row's edit draft carries its bank, plan, sheet, code and
collector and saves as `installment` with the bank and plan; an unknown stored
code opens under its own name.

**Ref.** fix/desktop-installment-method, 2026-09-12.
