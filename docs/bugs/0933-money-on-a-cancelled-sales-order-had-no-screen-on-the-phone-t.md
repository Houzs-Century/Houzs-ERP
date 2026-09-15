## Money on a cancelled sales order had no screen on the phone: the panel, the method and the converted row existed on the desktop only [medium]

<!-- area: Frontend + mobile -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15: 「他应该是 convert or refund，所以功能要做一起 …
这个按钮我觉得挨着一起」— built for the desktop in docs/bugs/0931 (the
backend is docs/bugs/0927). On the phone a cancelled order's Payments card
still showed the money and nothing to do with it; the phone's two payment
editors (the pre-create row on New SO, the Add payment sheet on an order)
knew the maintenance catalog's methods and none that the money came from
another order; a converted row recorded from the desktop read as its raw
code with a pencil the server refuses.

**Root cause (traced).** `frontend/src/mobile/MobileSODetail.tsx` mounted
the ledger and nothing under it; `frontend/src/mobile/RecordedPayments.tsx`
(`AddPaymentSheet`) and the `PayCard` in `frontend/src/mobile/MobileNewSO.tsx`
built their method list from `useSoDropdownOptions("payment_method")` alone
and their body from `paymentMethodCodeForValue`, which does not know the
converted method; `frontend/src/mobile/PaymentInfoBlock.tsx` had four method
labels.

**Fix (the phone; one logic layer with the desktop).**

- **The panel** — `frontend/src/vendor/scm/components/OrderMoneyPanel.tsx`
  gains `onOpenNewOrder`: given, the Convert form hands the ticks to the
  caller instead of navigating. `MobileSODetail.tsx` mounts the panel under
  the Payments card (it renders nothing unless the order is cancelled with
  money) and passes the ticks up; `frontend/src/mobile/MobileApp.tsx` opens
  the `new-so` screen with `convertFrom` (`MobileConvertPrefill`).
- **`frontend/src/mobile/MobileOrderMoney.tsx`** — the phone's own pieces:
  `withConvertOption` (the method joins the picker only while the customer
  has a cancelled order with money), `useMobileConvertSources` (a saved order
  by its number, the New SO screen by phone once six digits are typed),
  `ConvertSourceField` (the L2 pick — which cancelled order; picking fills an
  empty amount with what is left), `convertedBody` (source and amount alone;
  the server fixes the paid day and the collector), `rmInput`.
- **`frontend/src/mobile/MobileNewSO.tsx`** (69 lines under its ceiling, so
  every addition is terse): `convertFrom` copies the cancelled order's
  customer and lines (fresh lines, no photos) and seeds one converted row per
  pick; `PayCard` offers the method and its pick; `recordNewPayments` posts
  the converted body; the pre-create gate wants the order picked.
- **`frontend/src/mobile/RecordedPayments.tsx`** — the Add payment sheet
  offers the method for a saved order with sources, never on an edit; the
  pick fills the amount; the body is the converted one (no slip session). A
  stored converted row has no pencil; the trash stays.
- **`frontend/src/mobile/PaymentInfoBlock.tsx`** — the label and "from SO-x".

No migration, no new number series.

Proved RED on main's source: `frontend/src/mobile/MobileOrderMoney.test.tsx`,
`frontend/src/mobile/RecordedPayments.convert.test.tsx`,
`frontend/src/mobile/MobileNewSO.convert.test.tsx` (the module, the option,
the seed and the source pick did not exist), and the phone case in
`frontend/src/vendor/scm/components/OrderMoneyPanel.test.tsx` (the panel
navigated regardless). Green after.

**Ref.** acc/so-money-mobile, 2026-09-15.
