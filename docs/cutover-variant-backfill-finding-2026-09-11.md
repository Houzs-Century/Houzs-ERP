# Putting the book's spec on the migrated stock does NOT clear the negative buckets

**Date.** 2026-09-11. **Tool.** `backend/scripts/backfill-cutover-movement-variants.mjs`
(plan mode, read-only, run against production).

## What was expected, and said out loud before it was measured

After `docs/bugs/0819` traced the negative bedframe/sofa buckets to a keying
mismatch — stock arrives from the AutoCount cutover with no fabric / gap / divan
/ leg and lands under a BLANK variant key, while a delivery order ships under the
order's full spec — the obvious next step looked like this, and was put to the
owner in these terms:

> 46 of the 55 negative units will cancel out once the migrated stock carries the
> spec it actually is.

**That is refuted.** It came from the right measurement asked the wrong way: 43
of the 46 negative buckets DO have stock under the blank key at that same
warehouse, which proves the goods are there — it does not prove they are the
SAME SPEC as the piece that was shipped.

## What the simulation says

The plan run simulates the move over today's live balances (moving an IN row's
key takes the quantity out of the blank bucket and puts it in the spec bucket —
that is the whole arithmetic):

```
negative buckets right now: 80 bucket(s), -4232 unit(s)
after this run they would be:   89 bucket(s), -4250 unit(s)  [simulated]
  planned rows with a NEGATIVE quantity: 7 (-8 units) — these are cutover CORRECTIONS
  positive rows only:             95 bucket(s), -4257 unit(s)  [simulated]
  buckets healed: 3   buckets newly negative: 12
```

Three buckets heal. Twelve new ones open. Restricting the run to positive rows
makes it worse, not better, so the negative cutover corrections are not the cause.

## Why — and this is the part worth keeping

A bedframe model is not one product. Printed side by side, a negative bucket and
what the book says the stock at that warehouse is:

```
JAGER-(Q)                -1
  shipped under: fabriccode=pc151-01|gap=12"|divanheight=8"|legheight=0"|totalheight=20"|special=hb fully cover
  book receipt:  fabriccode=pc151-01|gap=12"|divanheight=8"|legheight=0"|totalheight=20"
  book receipt:  fabriccode=pc151-01|gap=12"|divanheight=8"|legheight=4"|totalheight=24"
  book receipt:  fabriccode=nb-01|gap=12"|divanheight=8"|legheight=0"|totalheight=20"
  ... 16 distinct specs in all
```

The unit that shipped carried **HB fully cover**. No receipt of that model does.
The stock in the warehouse is sixteen genuinely different pieces that share one
item code, and the piece the customer got is not one of them — it was made for
that order.

So keying the migrated stock does not cancel a negative: it moves the goods out
of the blank bucket into a THIRD bucket, leaving the negative exactly as
negative and emptying the pile that was visually covering it.

**The negative is not a keying artefact. It is the honest record of a piece that
left the warehouse having never been booked into it** — the cutover imported a
flat quantity for that item, not the individual pieces.

## What this changes

- **Do not run this expecting the negatives to clear.** The simulation is part of
  the plan output for exactly that reason: it refuses to let the next person make
  the same claim without seeing the number.
- **The negatives are cosmetic for shipping.** Since `docs/bugs/0819` the delivery
  check counts by SKU and ignores the spec, so a negative spec bucket no longer
  blocks anyone or forces a Ship anyway.
- **What actually clears them is a stock take** — count the pieces, enter what is
  physically there. That is what every ERP does at a cutover and it is the only
  thing that can, because the information the system lacks (which physical piece
  is which spec) exists only in the warehouse.
- **The tool still has one real use:** labelling. 302 movements / 307 units can be
  matched to their OWN receipt document by number, so the spec written on them is
  the book's, not a guess. That makes "how many of this fabric are left" a real
  number for those units. It is a reporting gain, not a repair.

## The owner's decision

Presented as: run it for the labelling and accept the bucket count looking worse;
leave it; or do the stock take first and key the result. Recorded here rather
than in `docs/bugs/` because nothing is broken — the expectation was.

**Ref.** `fix/cutover-movement-variants`, 2026-09-11. Predecessors:
`docs/bugs/0818`, `docs/bugs/0819`,
`backend/scripts/fill-cutover-lot-variants-2026-09-09.mjs` (the same evidence
chain, applied to the COST lots on 2026-09-09 — which is why the screens never
moved: `scm.inventory_balances` is a view over the MOVEMENTS, not over the lots).
