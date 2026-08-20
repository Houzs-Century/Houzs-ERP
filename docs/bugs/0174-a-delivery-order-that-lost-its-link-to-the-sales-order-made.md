## A delivery order that lost its link to the sales order made MRP order the goods a second time [high]

**Symptom.** The owner, on the MRP Stock Status Report, 2026-08-14: "all these
SO already have PO & some done delivered, why still appear at MRP for ordering?"
Four sales orders he named were fully shipped — one of them on a delivery order
already marked DELIVERED — and MRP was still asking purchasing to buy the goods.

**Root cause.** Of the three places `delivery-orders-mfg.ts` inserts DO lines,
the two that build a row from a client-supplied item body go through
`buildItemRow`, which does `so_item_id: (it.soItemId) ?? null` — taken from the
request, with no derivation and no guard. The third, `POST /from-sos`, sets it
from the picks server-side and always has it; that is the shape the other two
should have had. A client that omits the field writes a delivery the system can
never attribute, silently and permanently.

Everything that asks "how much of this order is still to fulfil" resolves on
that column — the remaining-qty guard, the sofa batch guard, the SO header's
status flip, and MRP's delivered-netting, which does `.in('so_item_id', ...)`
and skips a null. So a shipped order reads as entirely undelivered. MRP is
correct about everything it can see; it simply could not see the shipments.

`2990-SO-2606-025` is the clearest tell: its delivery order is DELIVERED while
the header still says CONFIRMED, because the header only flips when every line
is covered and no line could be.

**Measured on prod.** 24 unlinked lines on live delivery orders, across 11 open
sales orders, every one of them over-reporting shortage. None in June; 13
between 2026-07-02 and 07-30; 11 more between 08-03 and 08-06; none since.

**Why the earlier fix did not end it.** PR #1395 (2026-07-29) fixed the DO-create
page to send `soItemId` — and lines created on 08-03 and 08-06 are still
unlinked, from a client path that path did not cover. The reason one client
regression could write a month of permanently bad data is that the server
accepts the omission. `backfill-do-line-snapshot.mjs` had even met these rows
already ("WHERE so_item_id IS NULL there is no parent... leaves the line alone")
and correctly skipped them; nobody asked why the orphans existed.

**Fix, part one — the data.** `backfill-do-so-item-link.mjs` re-links what can
be read: only within the sales order the DO already names, only between lines of
the same item code, and where a code repeats, only on a variant identity unique
on both sides. `2990-SO-2606-016` carries two `CODY-(K)` lines differing only by
colour (BF-10 / BF-12) and both documents carry that colour, so that pair is
read rather than guessed. Two genuinely indistinguishable lines are REFUSED —
a bijection exists but choosing one is a coin flip, and the two SO lines can
differ in what is linked to them. A wrong link is worse than none: it credits
one line's shipment against another and cannot be told from a fact afterwards.

**Fix, part two — the hole (2026-08-15).** `scm/lib/derive-do-so-item-id.ts`
reads the link off the sales order before either body-driven insert path can
write a null, which is what `POST /from-sos` always did and is why that path
never produced one. Three outcomes, and the middle one is the whole point:

  · code on the SO, resolvable  → link it, no client change required;
  · code on the SO, ambiguous   → **400**. Only the client knows which line it
    meant, and a coin flip is worse than a refusal — a wrong link credits one
    line's shipment against another and cannot be told from a fact afterwards;
  · code NOT on the SO          → the null stands. That is the ad-hoc line the
    delivery paths already document. Prod carries none today, but closing a
    hole is not a licence to break a supported shape.

A failed read of the sales order refuses too, rather than defaulting to the null
it exists to prevent — the same fail-closed rule `downstream-lock` follows.

The pairing is IMPORTED from `scripts/lib/do-so-item-pairing.mjs`, not mirrored
into `src` the way `do-shipped-states` / `variant-summary` are, so the repair
script and the runtime guard cannot drift into two opinions about what a link
means. Precedent for crossing that boundary: `autocount-sofa-collapse.ts`
importing `parse-sofa.mjs`.
