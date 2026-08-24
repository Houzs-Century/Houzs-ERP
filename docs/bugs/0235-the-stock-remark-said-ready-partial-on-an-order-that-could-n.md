## The stock remark said READY (PARTIAL) on an order that could not ship [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, on a real accessory-only sales order with one accessory
line short: the Stock Status column read `READY (PARTIAL)` while the same
order was not ship-able — 骗人. Separately, a service-only SO (delivery fee
only, nothing to allocate) could never become ready at all: it showed a blank
remark and sat in CONFIRMED forever.

**Root cause (traced).** Both defects were one line each in
`backend/src/scm/lib/so-readiness.ts`.

`isMainReady = mainCount > 0 ? mainReady === mainCount : true` is VACUOUSLY
true when the SO has no MAIN (sofa/bedframe/mattress) line — the right reading
for an accessory-only order, and the wrong one for a label. The remark branched
on it (`else if (isMainReady) stockRemark = 'READY (PARTIAL)'`) three lines
below the ship gate that branched on `isShipReady`, so the two answered the
same question differently in the same function.

`if (isServiceLine(...)) continue` dropped every service line before it could
be counted, so a service-only SO ended with `mainCount + accCount === 0` and
was byte-identical to an SO with no lines at all — the husk case #2186 had
deliberately made un-shippable.

Compounding both: `isServiceLine` documents `category` (mfg_products.category)
as its strongest signal, but the `ReadinessLine` type had no field for it, so
no caller could pass it and a delivery fee saved with `item_group: 'others'`
counted as a short accessory.

**Fix.** The remark now names what is MISSING — `''` for a line-less SO,
`'READY'`, or `'SHORT: BEDFRAME, ACCESSORY'` — and never contains the substring
READY while anything is short. It no longer reads `isMainReady` at all. Service
lines are COUNTED (`svcCount`) rather than dropped, which is what makes
"had lines, all of them service" distinguishable from "no lines"; `isFullyReady`
requires at least one live line (service included) plus every stock-bearing line
allocated, so service-only is ready and the husk still is not. `isShipReady`'s
formula is untouched: every SO carrying a main line gates exactly as before.
`ReadinessLine.category` was added and is resolved at all five construction
sites through the new `lib/so-readiness-category.ts`, which also replaced three
hand-rolled copies of the same chunked catalog read.

**Ref.** PR #2295, fix/so-readiness-says-what-is-missing, 2026-08-16.
