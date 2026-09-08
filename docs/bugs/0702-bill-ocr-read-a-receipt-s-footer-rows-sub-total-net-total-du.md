## Bill OCR read a receipt's footer rows (Sub Total, NET TOTAL, DUITNOW QR, CHANGE) as line items, so a scanned voucher came out at roughly twice the receipt [medium]

<!-- area: Accounting + GL -->

**Symptom.** Owner, 2026-09-08, scanning a 99 Speedmart receipt on the bill
pile: 这个 ocr 会显示 sub total，这样我开 ocr 时会开，不太对. The read bill
listed the goods AND the receipt's footer — Sub Total, Rounding, NET TOTAL,
DUITNOW QR (the tender), CHANGE — as line items, so "Open as voucher"
pre-filled a voucher whose lines added up to about twice what the receipt
asked for.

**Root cause (traced).** `backend/src/acc/bill-extract.ts`: the prompt asked
for "EVERY line item printed on the bill … one entry per printed line", and
a receipt's footer IS printed lines, so the model obeyed; `coerceBillJson`
then kept every entry it was handed (it clamps shapes, it never judged what a
line is). Nothing between the reader and the New voucher page filtered a
restated total or a tender row, and `applyExtraction` makes one voucher line
per entry with a positive amount.

**Fix.** The prompt now asks for the rows that ADD UP to the amount paid
(goods/service lines plus any discount, tax or rounding row) and says the
footer is not line items; and because a vision model is not a filter,
`stripFooterLines` / `isFooterLine` in the same file drop, deterministically
on the WHOLE folded description, a restated total (sub / net / grand total,
amount due, balance), a tender row however the money was handed over (cash,
card, DuitNow/QR, TNG and the other wallets, FPX, tendered, paid), the
change, an item count and a zero rounding row — while a discount, a tax row
and a non-zero rounding stay, so the lines still add up to the receipt.
Pinned by `backend/src/acc/bill-extract.test.ts` (+3: the owner's receipt
shape with made-up goods → the two goods only, summing to the total; the
moving rows kept; every wallet/card tender dropped and "TOTAL CARE SHAMPOO"
kept). Proved RED on the unfixed tree: the three new tests failed on the
untouched `coerceBillJson` (all 8 entries returned), GREEN after.

**Ref.** feat/pv-scan-receipts, 2026-09-08.
