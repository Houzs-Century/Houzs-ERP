## The phone PO Amendments queue left out every SO amendment that revises a bound PO [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner 2026-09-15: 「修复手机 PO amendment 列表缺少 SO 改单」. On
desktop, the PO Amendments queue lists two kinds of row. One is a PO amendment
raised from a PO. The other is an SO amendment that revises a bound PO, shown with
Source "From SO amendment": once the Sales Order side approves it, purchasing must
revise that PO and send it to the supplier again. The phone queue listed only the
first kind. A purchaser working from the phone never saw the second kind, and it
was left out of the "N to action" count too. Found by reading the code on
2026-09-14, while building the approver badge (#3840). How many such rows
production holds right now was not measured.

**Root cause (traced).** The rule for which SO amendments belong in the PO queue
had one home, and it was inside the desktop page:

- #1248 (2026-07-25, `a0c08b1a1`) built both queues on `usePoAmendments()` alone.
- #1347 (2026-07-27, `07435be3a`) turned the desktop queue into a two-source inbox.
  It also reads `useAmendments()` and keeps rows whose `bound_pos` is non-empty,
  but it wrote that rule in a `useMemo` in `pages/scm-v2/PoAmendments.tsx`, and
  `mobile/MobilePoAmendments.tsx` was not touched.
- #3668 (2026-09-11, `1e64d1fa7`) added the DELIVERY-lane exclusion in the same
  desktop-only place.

The phone file's only data source stayed
`const { data, isLoading, error } = usePoAmendments();`. The mechanism is the
known desktop/mobile drift class: a rule written in one surface's component
instead of the shared layer.

This was proved by rendering both surfaces with the same data: one direct
amendment, plus four SO amendments (product lane with a bound PO, legacy with a
bound PO, delivery lane with a bound PO, product lane with no PO). Desktop listed
`PO-p, PO-s, PO-t`. The unfixed phone listed `PO-p` only.

**Fix.** The rule moved, unchanged, out of the desktop page into
`frontend/src/vendor/scm/lib/po-amendment-inbox.ts` (`buildPoAmendmentInbox`),
and both queues now call it. On the phone:

- the SO-driven card reads "From SO amendment · <SO no>" and carries its lane's
  approver badge;
- it counts toward "N to action" and the chips;
- tapping it opens the Sales Order. That is where the phone SO Amendments queue
  already sends the same row, because `MobileSODetail` hosts the SO amendment
  gates.

If one of the two lists fails to load, the phone now keeps the other list's rows
under the error line, as desktop does. Before, the error replaced the whole list.

`frontend/src/mobile/MobilePoAmendments.test.tsx` has 6 tests, including a
desktop/phone parity render. All 6 were RED on the unfixed phone file, e.g.
`expected [ 'PO-p' ] to deeply equal [ 'PO-p', 'PO-s', 'PO-t' ]`.
`frontend/src/vendor/scm/lib/po-amendment-inbox.test.ts` pins the rule itself.

Known limit, not changed here: the phone Sales Order page shows only the NEWEST
open amendment (`open_amendment`, `mfg-sales-orders.ts`). When an order has both a
product-lane and a delivery-lane amendment open, and the delivery-lane one is
newer, tapping the product-lane row lands on a page whose banner shows the
delivery one. The phone SO Amendments
queue has had the same limit all along.

**Ref.** `fix/mobile-po-amendments-so-rows`, 2026-09-15.
