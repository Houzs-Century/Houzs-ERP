## No merchant charge report — what each acquirer charged against the gross, per month and per merchant, could not be read anywhere [low]

<!-- area: Accounting + GL -->

**Symptom.** Finance could see a merchant fee only line by line on the
Merchant reconciliation screen, and the bank's payout charge only on the
Payment advice tab. What PBB, GHL, HLB or Maybank cost as a percentage of
the card sales they carried — per month, per merchant, and across merchants
— had to be worked out by hand. Owner (2026-09-11/12): 「我需要知道 merchant
charge 多少%，就是 charge / received amount，每个月的然后每个 merchant，总之就是
多层然后我自己 filter … 每个不同 merchant 都要能看到，我指的是 gross … 每个月全部
merchant 加起来的%」.

**Root cause (traced).** The figures existed — `acc_settlement_rows` carries
gross, fee and net per line with the acquirer and trading day, and
`acc_settlement_payout_batches.charge_sen` carries the bank's own charge on a
payout day (docs/bugs/0787) — but nothing summed them by month and acquirer.
Prod 2990, read-only while designing: June PBB 14 lines RM 35,651 gross,
RM 279.48 fee (0.78%); GHL 2 lines RM 6,355, RM 254.20 (4.00%); HLB 4 lines
RM 9,145, RM 95.07 (1.04%); July PBB 18 lines RM 41,242, RM 736.82 (1.79%);
one payout charge, PBB 06/06, RM 324.00.

**Fix.** `GET /accounting/reports/merchant-charges?from=YYYY-MM&to=YYYY-MM&acquirer&confirmed`
(`backend/src/scm/routes/accounting-merchant-charges.ts`) reads the lines by
trading day and the payout charges by the day the payout landed, and answers
per month, per acquirer: lines, gross, merchant fee, net, fee % of gross,
bank charge, the two together and their % of gross; a line per month across
acquirers; a grand total; and the reports (files) behind each
month-and-acquirer with the same figures. The Merchant charges tab
(`frontend/src/pages/scm-v2/MerchantChargesReport.tsx`, reached from the
Reports group as `/scm/accounting?tab=charges`) shows a month as a block —
all merchants first, then each merchant, opening to its reports — with month
pickers, the merchant filter, a confirmed-only tick and an Export of the
table as CSV.

Pinned by `backend/tests/merchantChargesReport.test.ts` (the month-and-
acquirer figures with the bank charge beside the fee, the month across
acquirers, the grand total, the reports under a merchant; confirmed-only
and the acquirer filter; a bad range refused; the permission gate) and
`frontend/src/pages/scm-v2/MerchantChargesReport.test.tsx` (the month block,
opening a merchant to its files, the filters reaching the server, the CSV).
New surface, so no RED beyond the absence.

**Ref.** acc/merchant-charges-report, 2026-09-12.
