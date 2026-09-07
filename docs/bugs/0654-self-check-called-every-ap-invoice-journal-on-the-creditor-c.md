## Self-check called every AP-invoice journal on the creditor controls foreign, and dropped the never-booked payments figure on the way to the page [medium]

<!-- area: Accounting + GL -->

**Symptom.** Owner, 2026-09-07, screenshot of Accounting → Self-check for
2990 with 什么意思?: "Other Creditors control 405-0000 — 21 FINDINGS — Lines
on this control account from sources that do not belong here: 2990-JE-2603-0002
(API), 2990-JE-2604-0015 (API), … (API_REVERSAL)" — every AP invoice he had
posted — while the card below read "Payments that reached the ledger — all
of them — its SO/SI payment tables hold no bookable row", the day after
docs/bugs/0652 had established 171 unbooked customer payments in that company.

**Root cause (traced).** Two lines in `controlCheckHandler`
(`routes/accounting.ts`). (1) The creditor controls' source family was
`{PI, PI_REVERSAL, PV, PV_REVERSAL}` — written before the AP invoice module
(2026-09-06) added `API` / `API_REVERSAL`, which credit 400 or 405 by the
supplier's code exactly as a PI does; nor did the AP arm walk `ap_invoices`
for drift. (2) The response shaping built `payments` field by field —
`since, rows, totalSen, ok` — and `unbookedPayments`' new `neverBooked`
(0652) never made it into the JSON; the card's never-booked branch read an
undefined count as zero and fell through to the clean sentence. The 0652 card
test rendered the card from a prop and so could not see the route drop it.

**Fix.** `API` and `API_REVERSAL` join the creditor family; the AP arm walks
`ap_invoices` (posted with no journal = drift, draft/cancelled skipped, a
journal without its bill reported) — `apControlCheckUnpostedPi.test.ts`, RED on
the unfixed tree (three foreign lines where one is due; no API drift). The
route passes `neverBooked` through and `ok` is false while it counts anything
— `tests/controlCheckPayments.test.ts`, RED on the unfixed tree
(`neverBooked` undefined, `ok` true).

**Ref.** fix/self-check-api-family, 2026-09-07.
