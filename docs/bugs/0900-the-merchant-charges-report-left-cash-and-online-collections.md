## The Merchant charges report left cash and online collections out, so its charge % was against card sales only [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, on the Merchant charges tab: 「这个 merchant
charge 其实会包括 cash online，只是 % 是 0 percent」. The report's months carried
only the acquirers (GHL, HLB, MBB, PBB), so "Charge %" was fee against CARD
gross, not against what was received, and the money paid in cash or by
online transfer was nowhere on it.

**Root cause (traced).** `scm/routes/accounting-merchant-charges.ts` read one
source: `acc_settlement_rows`, the lines of the acquirers' settlement
reports, by trading day. Cash and online transfers have no acquirer and no
report — they live only as payments keyed on sales orders
(`mfg_sales_order_payments`, method `cash` / `transfer`) — so nothing summed
them, and a month's line and the grand total were card-only.

**Fix.** The route reads the keyed payments for the range too (this company,
method `cash` / `transfer`, by `paid_at`, a CANCELLED order's money left out —
docs/bugs/0837's rule) and lists them under each month as **CASH** and
**ONLINE** after the acquirers, at 0.0%: lines = payments, gross = net = the
amount, no fee, no bank charge; the rows open to the payments themselves
(`payments: [{ id, docNo, paidOn, amountSen, subType }]`) instead of report
files. They roll into the month's line and the grand total, so Charge % reads
against everything received. `acquirer=CASH` / `ONLINE` keeps one channel; a
merchant filter leaves both out; `confirmed=1` does not reach them (a keyed
payment has nothing to confirm). Card and installment payments are never
counted here — the reports carry them. The tab
(`frontend/src/pages/scm-v2/MerchantChargesReport.tsx`) labels the rows Cash
and Online, lists them in the merchant filter after the acquirers, opens them
to the payments (order, day, sub-type), and Export writes them; the wire
shape gains `ChargePayment` and `payments?` on a row
(`vendor/scm/lib/merchant-charges-queries.ts`, with `channelLabel`,
`channelOrder`, `paymentFigures`).

Two calendars, on purpose and said on the tab: a merchant row is dated by the
report's trading day, a keyed payment by its own date. Prod 2990 while
designing (read-only, non-cancelled orders, by payment date): June cash 3 /
RM 4,878.00, online 7 / RM 13,473.00; July online 10 / RM 14,545.50; August
cash 1 / RM 250.00, online 18 / RM 29,437.00. June's card + installment in
the ledger (RM 84,674.00) equals the report's card gross exactly; July and
August differ because the reports lag and August's are still being uploaded.

Proved RED on the unfixed tree: the Cash-and-Online cases of
`backend/tests/merchantChargesReport.test.ts` (rows after the acquirers at
0%, the payments under them, a cancelled order's, a card payment and an
out-of-range payment not rows, a month with only keyed payments, the acquirer
filter naming a channel and the confirmed-only tick not reaching one, the old
world unchanged) and `frontend/src/pages/scm-v2/MerchantChargesReport.test.tsx`
(the rows after the merchants at 0%, the filter's words, opening to the
payments, the export).

**Ref.** acc/merchant-charges-cash-online, 2026-09-14.
