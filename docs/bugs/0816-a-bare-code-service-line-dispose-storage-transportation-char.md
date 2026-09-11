## A bare-code service line (DISPOSE / STORAGE / TRANSPORTATION CHARGES) amendment routed to Purchasing and could raise an empty PO amendment [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-09-11, on the SO amendment for HC-SO-013222 (whose
changed line is `DISPOSE`, `item_group='service'`): 「这个是 under service line
item 为什么是 purchasing Approved」 — a disposal charge asking for a PURCHASING
signature. And of the service-side amendments raised that day 「今天提交的还是会
升级到 PO amendment」 — they surfaced in the PO Amendments inbox as if they
revised a PO.

This is the SIBLING of the 2026-09-09 fix (`serviceOnlyChange`, #3414). That fix
stopped the PO FOLLOW-UP for a service-line change, but only in
`raisePoFollowUps` (which already used `isServiceLine`). The SO amendment was
still LANE-classified upstream as product/Purchasing, so it still demanded the
wrong desk's signature and still appeared in the PO inbox.

**Root cause (traced).** `scm/shared/amendment-lane.ts:classifyLineItemCode`
decided a line's lane with `isServiceSkuCode` — the `SVC-` PREFIX alone. The
go-live / AutoCount service lines carry BARE codes with `item_group='service'`
and no prefix, so every one classified as `LINES` (Purchasing). Measured on
production (`anogrigyjbduyzclzjgn`, scm schema, company 1, 2026-09-11) —
`mfg_sales_order_items` with `item_group='service'`, by code:

```
TRANSPORTATION CHARGES  323      SVC-DELIVERY        124   (SVC-* → DELIVERY, correct)
DISPOSE                 220      SVC-DELIVERY-CROSS   25
STORAGE                  34      SVC-DISPOSE-SOFA      5
DISPOSE BEDDING/MATT/BF   7      SVC-DISPOSE-*         …
RC-CUS / RC-TRP / RC-COM  5
```

~590 live service lines mis-routed; only the `SVC-*` codes routed to `DELIVERY`.
The module's own header already named "disposal add on" and "transportation
charges" as DELIVERY (the owner's category 2), so the classifier contradicted
its own spec. Confirmed the target line directly: HC-SO-013222/A1's changed
`sales_order_item_id` resolves to `item_code='DISPOSE'`, `item_group='service'`,
and the amendment row's `lane='LINES'`.

Two consequences: (1) the SO amendment demanded `scm.amendment.approve_lines`
(Purchasing) for a Logistics charge; (2) once approved, the `LINES` lane calls
`raisePoFollowUps`. Separately, the desktop PO inbox (`PoAmendments.tsx`) merged
in EVERY bound-PO SO amendment with NO lane filter — so even a pure `DELIVERY`
amendment (an address change: HC-SO-009093/A2, `header_changes={address1,
address2, city}`, `lane='DELIVERY'`) appeared in the PO revision inbox.

**Fix.**

- `amendment-lane.ts` classifies by the full `isServiceLine` signal (item_group
  / category / `SVC-` code), not the prefix alone. `classifyLineItemCode` and
  `splitAmendmentByLane` take the SO line's `item_group`, resolved SERVER-SIDE in
  `mfg-sales-orders.ts` (the amendment-submit SELECT now reads `item_group` as
  well as `item_code`). A bare-code service line in a mixed submission now splits
  into its own `DELIVERY` (Logistics) document; a service-only submission never
  reaches Purchasing or a PO follow-up.
- `PoAmendments.tsx` excludes `lane === 'DELIVERY'` from the SO-driven rows, so
  the PO revision inbox shows only product-side (`LINES`) and legacy (lane null)
  amendments. Mobile (`MobilePoAmendments.tsx`) never merged SO amendments, so it
  was already clean.
- `amendment-lane.test.ts` pins `DISPOSE` / `TRANSPORTATION CHARGES` / `STORAGE`
  with `item_group='service'` → `DELIVERY`, a real product line staying `LINES`,
  and the mixed split via the item_group resolver. Proved RED on the unfixed tree
  (prefix-only classified all three as `LINES`).

**Ref.** `fix/amendment-service-line-lane`, 2026-09-11.
