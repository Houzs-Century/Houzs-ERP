## Money in server-written messages read as raw sen, whole ringgit, or without thousands separators [medium]

<!-- area: Accounting + GL -->

**Symptom.** Owner, 2026-09-15: every amount must read the way AutoCount prints
it, which means ringgit, two decimals and thousands separators (「全部amount需要跟Autocount 的一样」).
The server writes money into refusal messages, warnings, journal narrations,
audit notes, print pages and one CSV that staff read. A census of `backend/src`
found four shapes that do not:

- **Raw sen integer.**
  - Bank reconciliation's inconsistency message: "The difference of 1250 sen does not equal...".
  - The bank-month gap note: "... 3400 sen moved on days ...".
  - Other Debtors over-allocation: "That bill has only 50000 sen outstanding".
  - The PV over-allocation note: "asked 150000 sen, applied 120000 sen".
  - The customer-credit audit note: `${creditSen / 100}`, e.g. "carried 1500 as customer credit".
- **Whole ringgit.**
  - The SO deposit refusal: "Deposit RM 450 of RM 1,500 needed" (`fmtRM(Math.round(sen / 100))`).
  - The SI price-drift warning: `fmtRM(sen / 100)`, which is the 2990 whole-MYR helper.
  - The document-flow payment label: `toFixed(0)`.
  - The sales-intelligence agent summary: `toFixed(0)`.
  - The mattress/bedframe price breakdown: `price.toLocaleString()`.
  - The Projects print headline strip: `fmtMoney0`, plus the rental `RM 12/m²/day` note.
- **No thousands separator.** `(sen / 100).toFixed(2)` → "15000.00". 38 sites:
  - Settlement parse/match/receipt refusals and journal narrations.
  - Daily cash close and closing-stock narrations.
  - Deposit invoice lines.
  - PV refund, advance and cancel refusals, and PV audit notes.
  - AP invoice and Other Debtors refusals.
  - SO amendment and product-swap discount refusals.
  - The bank split refusal.
  - Release-gate and delivery-agent reasons.
  - The supplier-portal quote note.
- **No fixed decimals in an export.** The service-case CSV wrote `po_amount` as stored ("150", "150.5").

**Root cause (traced).** The backend had no sen formatter. `scm/shared/format.ts`
carried only the 2990 POS whole-MYR `fmtMoney`/`fmtRM`, while its frontend mirror
`vendor/shared/format.ts` had `fmtSen`/`fmtMoneySen`. So each route typed its
own `(sen / 100).toFixed(2)`, or reached for `fmtRM` and rounded. Nothing checked
the shape of money text on the server.

**Fix.**
- `scm/shared/format.ts` gains `fmtSen` / `fmtMoneySen`, byte-identical to the frontend copies.
- The sites above call `fmtSen` ("RM 15,000.00"), or the print page's own 2dp `fmtMoney`.
- `fmtMoney0` is removed.
- The service-case CSV writes `po_amount` with 2 decimals.

Pinned by `backend/tests/moneyTextShape.test.ts`. It scans non-test `.ts` under
`backend/src` for five shapes: `/100).toFixed(2)`, bare `sen / 100`, whole-ringgit
rounding, `ringgit.toFixed(2)` behind RM, and `${x} sen`. It skips `console.*`
lines, and it asserts `fmtSen(1500000) === 'RM 15,000.00'`. RED on the unfixed
tree: 6 of 7 failed (29 + 1 + 10 + 1 + 6 hits, and `fmtSen is not a function`).
GREEN after.

**Ref.** fix/money-backend-text, 2026-09-15.
