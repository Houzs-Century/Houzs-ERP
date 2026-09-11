## A delivery order invented the sofa's leg height, so the stock reserved for it read as a different product [high]

<!-- area: Sofa, fabric, variants -->

**白话.** 沙发就在巴生仓，单也已经绑好那张采购单，可是开送货单的时候系统还是说
「仓库库存不够」。原因是送货单表单会自己帮沙发填一个「脚高 = Default」，而仓库里
那台沙发当初入库时没有脚高这一项 —— 多了一项，系统就当成是两个不同的货，找不到。
更麻烦的是：**当天已经有三张送货单是按「Ship anyway」硬开出去的**
（HC-DO-2609-004、-009、-011），货出了，但库存那台沙发没有被扣掉，成本也是 0。

**Symptom.** Nico, 2026-09-08 21:50 (+08), on HC-SO-012565 after the sofa was
repaired, its stock opened and its two lines flipped READY: 「还是不能转换」. The
New Delivery Order screen answered *"Stock not enough at the selected warehouse —
8030-2A(LHF) At BALAKONG WAREHOUSE: need 1, available 0 (short 1)"*, and the same
for `8030-1A(RHF)`, for a sofa that is standing at that warehouse under that
order's own batch.

**Root cause (traced).** The leg height is part of the STOCK BUCKET, and the
delivery form fills it in when the sales order does not have one.

`computeVariantKey` (`backend/src/scm/shared/variant-key.ts`) emits
`legheight=` for a sofa. `SoLineCard`'s heal effect
(`frontend/src/vendor/scm/components/SoLineCard.tsx`) auto-filled a blank sofa
Leg Height with the maintenance pool's "Default" option — the owner's 2026-07-13
convenience so a SALES ORDER never shows an empty field. The card is SHARED, so
the same seeding ran on the Delivery Order form, and the key the pre-flight asked
about was one nothing had ever been stored under. Read live on production
2026-09-08:

| what | key | qty |
| --- | --- | --- |
| the lot at BALAKONG, batch HC-PO-009435 | `fabriccode=bo315-31\|seatheight=26\|special=bottom wrap nylon fabric,fully cover to floor,nylon fabric,seat base fully cover with no leg` | 1 |
| the sales-order line (no leg height at all) | the same | — |
| what the delivery form asked for | the same **plus `legheight=default`** | 0 |

`checkStockAvailability` (`backend/src/scm/lib/check-stock-availability.ts`)
compares `(item_code, variant_key)` against `scm.inventory_balances`, so an
invented attribute reads as "available 0" no matter how much stock is there.

**It is not only a block — three documents already shipped through it.** Of 179
sofa compartment lots, **0** carry `legheight=default`; of the sofa OUT movements
since 2026-07-01, exactly **2** do, both from 2026-09-08 morning. Their delivery
lines (`scm.delivery_order_items`, 5 lines across HC-DO-2609-004, HC-DO-2609-009
and HC-DO-2609-011) carry `legHeight: "Default"` while every one of their sales
lines carries none, and every one of those movements has
`inventory_lot_consumptions` **0** and `unit_cost_sen` **0**. So the goods left
the building, the lot they came from is still open on the books, and the sale
carries no cost. Those five lines are recorded here and NOT repaired — a stock
write needs its own plan/apply tool and the owner's word.

**Fix.** `seedSofaLegDefault` is now a MANDATORY prop on `SoLineCard`, no
default, so the compiler enumerates the call sites — the same discipline
`variantsRequired` already carries on that component, and the CLAUDE.md rule
"a parameter that DECIDES something is required, never optional". A document that
SPECIFIES the sofa passes `true` (Sales Order New/Detail, Consignment Order
New/Detail — the key they write is the one the purchase order and then the lot
inherit, so seeding stays consistent downstream); a document that FULFILS one
passes `false` (Delivery Order, Delivery Return, Consignment Note New/Detail,
Consignment Return New/Detail, Sales Invoice). All 15 render sites across 11
files. Leg Height is `required: false` in
`frontend/src/vendor/shared/so-variant-rule.ts`, so a blank one blocks no Confirm
gate on either side.

`frontend/src/vendor/scm/components/sofa-leg-default-seed.test.ts` pins it (14
tests), read from source like `po-line-card-photos.test.ts` because the defect is
about which SURFACES wire the decision. PROVED RED three ways on the unfixed
tree, each watched to fail and then restored: dropping the prop from the seed
condition fails 1; dropping it from the effect's dependency list fails 1; setting
the Delivery Order's answer to `true` fails 1. Removing the prop from one call
site fails the TYPECHECK — `TS2741: Property 'seedSofaLegDefault' is missing`.

The mobile sales-order surface (`frontend/src/mobile/MobileNewSO.tsx`) has its
own copy of the seed and is deliberately untouched: it is a sales order, which is
the one place the default belongs.

**Not fixed here.** The durable version is that a delivery line should INHERIT
the bucket its sales line was reserved under rather than recompute one from
editable fields — `scm.delivery_order_items.committed_variant_key` already exists
for the drop-ship path. That is a change to the stock/money path and is the
owner's call.

**PROVEN in production 2026-09-08 23:49 (+08).** The first delivery raised after
this shipped, HC-DO-2609-013 off HC-SO-012565, wrote its OUT movements under the
lot's own key with **no `legheight=default`**, and both lots under batch
HC-PO-009435 went `qty_remaining` 1 -> 0 with a consumption row each. That is the
whole defect closed end to end: this morning's three deliveries moved goods and
consumed nothing; this one consumed what it shipped. Full trace in
`docs/bugs/0714-the-sofa-purchase-line-was-filed-as-others-so-the-sales-orde.md`.

**Ref.** claude/so-do-conversion-remaining-wz1d5x, 2026-09-08. Found while
finishing `docs/bugs/0714-the-sofa-purchase-line-was-filed-as-others-so-the-sales-orde.md`,
whose LIKELY this refutes: the three steps there were necessary and were not
sufficient.
