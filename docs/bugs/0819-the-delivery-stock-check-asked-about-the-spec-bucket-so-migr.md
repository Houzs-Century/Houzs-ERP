## The delivery stock check asked about the spec bucket, so migrated stock standing in the warehouse read as none [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** Owner, 2026-09-11, after the hard-binding fix landed: 「我明白了 那
如果出货这些 我们统一只看SKU呢？不看规格？」 — staff open a delivery order, the
screen says *"need 1, available 0"*, and the goods are standing at that
warehouse. The furniture is there. The screen cannot see it.

**Root cause (measured on production, not reasoned).** Stock and orders are
keyed differently, and nothing reconciles them:

| | how it is keyed |
| --- | --- |
| stock that arrived from the AutoCount cutover | item code + **BLANK** variant key — the book holds no fabric / gap / divan / leg |
| what a delivery order asks for | item code + the order's **full spec** |

Company 1's stock is almost entirely the first kind. Measured 2026-09-11 on
`scm.inventory_movements`:

```
AC_CUTOVER  ADJUSTMENT  3478 movements
GRN         IN           157
DO          OUT          296
```

Our own goods receipts began on 2026-09-08, so 3,478 of 3,931 movements are the
snapshot. The spec bucket a delivery order asks about has therefore never had
anything in it, while the blank bucket beside it is full.

Measured across every live sales-order line (the real `computeVariantKey`, not a
re-implementation of it):

| company / group | lines | short today | have that SKU at that warehouse under another key |
| --- | ---: | ---: | ---: |
| co1 bedframe | 2,451 | 2,236 | **1,632** |
| co1 sofa | 1,219 | 1,087 | **693** |
| co2 sofa | 171 | 139 | 74 |
| co1 mattress / accessory / service / others | 10,908 | 1,185 | **0** |

The last row is the control: those groups carry no variants, so the spec-blind
total already IS their bucket total and this change cannot move them.

**And it is where the negative stock comes from.** Of the 52 negative
bedframe/sofa buckets (−55 units), **46 were shipped out of a bucket that had
never received anything** — IN 0, ADJUSTMENT 0, a delivery order OUT — and in
**43** of those the same item at the same warehouse was holding stock under the
blank key. Our own goods receipts had posted into **none** of the 52. The
operator was told there was no stock, pressed Ship anyway because the goods were
visibly there, and the spec bucket went to −1 while the blank bucket stayed full.
It was never an over-ship: **goods came in under one name and left under
another.**

**Fix.** `checkStockAvailability` counts what the warehouse holds by
`item_code`, summing every spec bucket, and the cross-warehouse hint sums each
warehouse's specs into one row. Lines sharing an item code are aggregated into
one ask, so two specs of the same SKU can never both pass on the same unit.
`variantKey` is still reported on the shortage — the operator needs to know what
was asked for; it no longer decides whether the goods exist.

The hint mattered as much as the number: keyed per spec, it was blind in exactly
the case it exists for. The goods sit at the other warehouse under the blank key,
so *"Other warehouses: B (3)"* was never printed and Ship anyway was the only
visible way forward. The dialog already renders `alternatives`
(`frontend/src/vendor/scm/lib/authed-fetch.ts`), so no screen changed — the
numbers in it became true.

**What this deliberately does NOT do.** The OUT movement still writes to the
spec bucket, and the FIFO cost lots are still keyed by spec
(`backend/src/scm/lib/fifo-out-consume.ts`). Checking blind and DEDUCTING blind
are different changes and the second one moves money — an OUT whose lot lookup
misses ships uncosted, which is the MAKOTO false-short class (mig 0195). The
real repair is the data: put the spec back on the migrated stock. This keeps the
screen honest until that lands, and stops new negatives by removing the reason
anyone presses Ship anyway.

**Proved RED.** Re-keying availability and the hint by spec — the old behaviour,
restored in one edit — fails three of the four new cases in
`backend/tests/stockCheckableLines.test.ts`, first among them *"stock under the
BLANK key covers a line that asked for the full spec"*. Restored: **25 passed**.
`npm --prefix backend run typecheck` clean.

**Ref.** `fix/do-stock-check-by-sku`, 2026-09-11. Owner's decision, in his
words: 「那就A」. Guide updated in the same PR: `docs/modules/delivery-order.md`.
Predecessor: `docs/bugs/0818-the-delivery-order-stock-guard-did-not-honour-hard-binding-s.md`.
