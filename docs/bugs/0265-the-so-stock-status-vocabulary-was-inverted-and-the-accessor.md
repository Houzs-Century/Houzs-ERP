## The SO Stock Status vocabulary was inverted, and the accessory-only lie was fixed on the wrong half [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Two owner instructions on 2026-08-16, both real, ten hours apart.
Morning, on an accessory-only SO with one short accessory line: the Stock
Status cell read `READY (PARTIAL)` while nothing on the order was ready and its
own ship gate said no — 「只有配件,有一行没齐 → READY (PARTIAL) ← 骗人 /
明说还缺什么」. Evening, confirmed against worked examples: the vocabulary he
set is the READY side — `READY`, `PARTIAL`, `BEDFRAME`, `MATTRESS/ACC` — and
the blank cell is what "nothing is ready" looks like.

**Root cause (traced).** PR #2295 read the morning instruction as "invert the
vocabulary" and flipped every token to name what was MISSING (`SHORT:
MATTRESS`). The lie was never in the DIRECTION of the vocabulary. It was one
`else if`:

```
} else if (isMainReady) { stockRemark = 'READY (PARTIAL)'; }
```

`isMainReady = mainCount > 0 ? mainReady === mainCount : true` is **VACUOUSLY
TRUE when the SO has no MAIN line** — the right convention for an
accessory-only order and the wrong one for a label. `PARTIAL` asserts "the main
products are in"; an order with no main line has none, so the branch fired on
an order where nothing was ready, three lines below an `isShipReady` of false.
The same rollup's ship gate had ALREADY been written as `mainCount > 0 ?
isMainReady : isFullyReady` for exactly this reason — the guard existed on the
gate and was missing on the label, in the same function.

**Fix.** The vocabulary is the READY side again, and the branch carries the
guard the gate always had: `mainCount > 0 && isMainReady`, so an accessory-only
order with a short accessory falls through to the (empty) ready list and the
cell says nothing. The label is the bare word `PARTIAL`, never `READY
(PARTIAL)` — which keeps #2295's real invariant, that the string never contains
`READY` while anything is short. Kept from #2295 and untouched: service lines
COUNTED (`svcCount`) rather than dropped, `isShipReady` as THE gate,
`is_ship_ready` on the delivery-planning payload, `ReadinessLine.category`
threaded at all five construction sites, and `lib/so-readiness-row.ts` as the
single expression of the four board fields — which is why the vocabulary could
move twice in a day with no board re-growing a copy of it.

`summariseReadiness` now returns `readyCategories` beside `pendingCategories`,
so the label is a join of a list the caller can also read rather than a string
only the producer understands, and `MAIN_CATEGORY_ORDER` is the single source
of both the emission order and `MAIN_CATEGORIES`.

Two consumers moved with it: `ConsignmentOrders.tsx` matched
`startsWith('SHORT:')` for its amber pill and scored `1000 - s.length` in its
sort (shorter = closer to ready, correct for a what-is-missing label, backwards
for a what-is-ready one) — the pill now branches on `remark !== 'READY'` so a
new token cannot fall through to the neutral slot, and the sort scores
`READY > PARTIAL > longer ready list > blank`.
`backend/scripts/check-stock-vs-autocount.mjs` carried a fourth copy of the
rollup that #2295 never updated, **including the missing `mainCount > 0`
guard**; it is corrected, and its `canon` now folds AutoCount's stored
`READY (PARTIAL)` into `PARTIAL` the same way it already folded `ACC/BEDFRAME`
into `BEDFRAME/ACC`.

**Ref.** this PR, 2026-08-16. Reverses the vocabulary half of PR #2295 and
keeps its correctness half. `docs/stock-reconciliation.md` §2.1 now describes
ONE vocabulary and records that `SHORT:`-form remarks were briefly written
between the morning of 2026-08-16 and this change, so a stored remark or an
AutoCount export from that window may still carry one.
