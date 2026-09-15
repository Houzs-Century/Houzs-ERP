## Money on a cancelled sales order had no screen: no way to refund it or move it to a new order from the order itself [high]

<!-- area: Frontend + mobile -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15: 「他应该是 convert or refund，所以功能要做一起 …
这个按钮我觉得挨着一起 … 如果要分开就应该是 create new so 时他的 payment 是
convert from cancel bill … 这个是可以选多张一起 convert?」. The backend of
docs/bugs/0927 landed the two exits; the desktop had no way to reach them:
a cancelled order's Payments card showed the money and nothing to do with
it, the New SO page's method select knew four ways money arrives and none
that it came from another order, and Finance had no list of cancelled
orders still holding money.

**Root cause (traced).** `PaymentsTable`
(`frontend/src/vendor/scm/components/PaymentsTable.tsx`) resolved every
method through the maintenance list's four values (`labelToApi`,
`draftMethodFields`, `missingMethodSubField`), so a `converted` row could
neither be composed nor opened; nothing under the table read `GET
/:docNo/money`; `SalesOrderNew.tsx` seeded a copy of an order without its
money.

**Fix (the desktop; mobile follows).**

- **`frontend/src/vendor/scm/lib/so-money-queries.ts`** — the panel's read
  (`useOrderMoney`), the sources a row may draw on (`useConvertSources`,
  `useCancelledWithMoney` by phone for a page with no order yet), the
  refund request (`useRequestRefund`), and the converted row's vocabulary:
  `CONVERT_LABEL` ("Convert from cancelled SO"), `CONVERTED_METHOD`, the
  `?convert=SO-a:sen,SO-b:sen` parameter (`convertParamOf`,
  `convertPicksFrom`, `newOrderWithMoneyHref`).
- **`frontend/src/vendor/scm/components/OrderMoneyPanel.tsx`** — under a
  cancelled order's payments: paid · refunded (the vouchers, with status) ·
  moved (to which orders) · remaining, and **[Refund] [Convert]** side by
  side. Refund takes an amount (part or all) and a note and raises the
  Customer Refund voucher DRAFT for Finance. Convert lists this order
  (ticked) and the customer's other cancelled orders with money (tick to
  add), each for what is left, and opens the New SO page with the customer
  and lines copied (`copyFrom`) and one converted row per tick.
- **`PaymentsTable.tsx`** — "Convert from cancelled SO" is a method of its
  own: offered when the customer has a cancelled order with money (a saved
  order asks the server; the New SO page hands the sources in by phone,
  `convertSources`), its L2 pick is the cancelled order (picking one fills
  an empty amount with what is left), it resolves to `converted` carrying
  `convertedFromDocNo`, the gate wants the order picked. A stored
  converted row reads "Convert from cancelled SO" with "from SO-x" under it
  and has no pencil — it is moved back by deleting it. `convertDraftsFrom`
  seeds the rows from the parameter. The `SoPayment` row type
  (`frontend/src/vendor/scm/lib/sales-order-queries.ts`) carries the
  method and the source column.
- **`frontend/src/pages/scm-v2/SalesOrderNew.tsx`** — at its size ceiling,
  so paid for line by line: the copy seed also reads `?convert=` and seeds
  the converted rows; the page reads the customer's cancelled orders with
  money by phone and hands them to the table.
- **`frontend/src/lib/paymentRetryHandoff.ts`** — a converted draft that
  failed to book survives the retry handoff with its source, like any row.
- **`frontend/src/pages/scm-v2/CancelledWithMoneyCard.tsx`**, on the
  Self-check tab of `frontend/src/pages/scm-v2/Accounting.tsx` — Finance's
  list: every cancelled order still holding money, with what is left.
- **Backend**: `GET /mfg-sales-orders/cancelled-with-money?phone=` narrows
  the list to one customer's (`backend/src/scm/lib/so-money.ts`,
  `backend/src/scm/routes/so-money-routes.ts`).

No migration, no new number series.

Proved RED on main's source:
`frontend/src/vendor/scm/components/PaymentsTable.test.ts` (the label was
refused, the gate silent, the seed absent),
`frontend/src/lib/paymentRetryHandoff.test.ts` (a converted draft was
dropped from the handoff), `frontend/src/vendor/scm/components/OrderMoneyPanel.test.tsx`,
`frontend/src/vendor/scm/lib/so-money-queries.test.tsx` and
`frontend/src/pages/scm-v2/CancelledWithMoneyCard.test.tsx` (no module),
`backend/tests/soMoneyConvert.test.ts` (the phone filter). Green after.

**Ref.** acc/so-money-screens, 2026-09-15.
