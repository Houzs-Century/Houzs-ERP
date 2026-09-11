## No deposit invoice — money received before the final invoice was never a sale of its own, and the switch to make it one did not exist [medium]

<!-- area: Accounting + GL -->

**Symptom.** A customer paid a deposit on a sofa; the books held it as a
payment against the customer (Dr cash or transit / Cr AR) and nothing else.
Under the e-invoice reading the owner works to (2026-09-12: e-invoice 好像是
根据收钱就认 sales 了), that money is a sale the day it arrives and wants an
invoice of its own — and the debit side is the customer's own code, never a
deposit liability (每个顾客不是有自己本身的 account code 吗). There was no
document to issue, no journal to post, and no way to say which company, from
which day, should do it (做成开关，houzs 那边往后也是需要，只是暂时先关闭 …
可以自己选几时要开始自动开 deposit invoice).

**Root cause (traced).** The ledger knew a payment and a final sales invoice
and nothing between them; the accounting layer had no per-company setting
at all (`public.companies` carries id, code, name, is_active, created_at).

**Fix.** `scm.acc_deposit_invoices` and `scm.acc_company_settings` (migration
`20260912T0300_acc_deposit_invoices.sql`), `acc/deposit-invoices.ts` and
`/scm/deposit-invoices` (`backend/src/scm/routes/deposit-invoices.ts`). One
DEPOSIT INVOICE per customer payment received before the order's final
sales invoice: Dr AR with the customer as party / Cr DEPOSIT PAY BY CUSTOMER
(new role `DEPOSIT_INCOME`, 509-0000), dated the payment's day, numbered
`{co}-DI-YYMM-NNN` (NEW series), posted through `postJournal` keyed
(`DI`, the number). It is born in `so-payment-row.ts`'s
`bookSoPaymentBestEffort` — the one hook every payment birth passes (the
panel, the scan job, both SO-create deposit inserts) — and decides for
itself: the company's switch is on, the day is on or after the start, the
order has no live sales invoice yet (a draft or a cancelled one is none —
`absorbsOrderDeposit`'s reading). An edited payment whose amount or day
moved cancels its invoice by contra and issues the next number (cancelled
and re-issued, never rewritten); a deleted payment cancels it; a payment
after the final invoice gets none. The switch is per company with a start
day; switching on needs the day; the page counts the payments since the
start that have no invoice and issues them on a button. Finance cancels
with a reason and re-posts an invoice whose journal was refused at birth.
2990 on from the day the owner picks; HOUZS off.

Left for the next step (④c): the final invoice at delivery, and one credit
note per deposit invoice at that moment (`credit_note_id` is where the
link lands); until then the sale stays on 509-0000.

Pinned by `backend/tests/depositInvoices.test.ts` (the switch off; on from
a day — the number, the party, the journal, the next number; before the
start and an invoiced order refused by name; issuing twice; the edit's
cancel-and-reissue; the delete's cancel; the routes, the switch's
validation, the backlog, cancel with a reason, post again, the permission
gate) and `frontend/src/pages/scm-v2/DepositInvoices.test.tsx`. New
surface: RED is the absence.

**Ref.** acc/deposit-invoices, 2026-09-12.
