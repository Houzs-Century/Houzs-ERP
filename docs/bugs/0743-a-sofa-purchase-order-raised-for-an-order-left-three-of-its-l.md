## A sofa purchase order raised for an order left three of its lines unlinked, so MRP kept asking the buyer to order them again [medium]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: owner-decision -->

**Symptom.** `HC-SO-012025` (WINNIE, IN_PRODUCTION) shows three sofa pieces as
still needing a purchase order, and its sales lines can never reach READY — while
the purchase order that was raised **for that very order** already carries those
three pieces.

**Root cause (traced).** `HC-PO-009024` was raised for `HC-SO-012025` and lists
all five sofa pieces. Three of its six lines carry `so_item_id = NULL`:

| piece | on the purchase order | linked |
| --- | --- | --- |
| `9050-1A(LHF)` | yes | yes |
| `9050-1S` | yes | yes |
| `9050-1A(RHF)` | yes | **no** |
| `9050-1NA` | yes | **no** |
| `9050-CNR` | yes | **no** |

The consequence lands on two screens, because `so_item_id` is the binding a
company-1 sofa line lights through (`HARD_BOUND_COMPANY_ID`,
`docs/bugs/0572-a-company-1-bound-line-with-no-receipt-fell-through-to-the-p.md`):

- **MRP** reports the three sales lines as a shortage and asks the buyer to raise
  a purchase order for pieces that are already on order — a double-buy risk with
  a customer behind it.
- **The stock allocator** can never light those lines, because it reads
  `purchase_order_items.received_qty` THROUGH `so_item_id` and nothing else. The
  order stays PENDING however much arrives.

**This is a LINKING gap, not a content mismatch, and the difference decides the
repair.** The two documents list exactly the same five pieces — checked before
anything was written. Compare with the population in
`docs/mrp-stock-vs-bound-rules-2026-09-09.md` §2c, where the purchase order asks
the factory for a piece the sales order does not list: those need a human
decision about which document is right. This one needs only the link.

**Measured 2026-09-09** (company 1, read-only). A LOOSE test — "an open purchase
order somewhere carries this item code" — returned **10** lines and was WRONG: it
paired `HC-PO-010085` (Jack Lai's order) with MICHAEL, James Low, MR LEW and
Farah purely because sofa compartment codes repeat across orders. Only a purchase
order **already linked to the same sales order** proves anything, and that test
returns **3**. Both numbers are recorded so the weaker one is not reused.

**Fix — data, and it is the owner's to run.**
`backend/scripts/repair-delivered-status-and-sofa-links.mjs` case B writes the
three links, matching PO line to SO line BY ITEM CODE inside this one document
pair, so the same-product gate is structural rather than an afterthought —
skipping that comparison is what put nine sales-order lines on a different bed
(`docs/bugs/0671-a-key-pair-is-not-an-identity-match-nine-sales-order-lines-w.md`).
It refuses outright if the unlinked remainder is not exactly three, which would
mean the document pair moved since this was written.

Default is PLAN; the apply needs a confirm phrase and goes through
`workflow_dispatch` on `secrets.DATABASE_URL`, because the desktop DSN is
read-only by design. **REVERSAL:** all three were `NULL`, so
`SET so_item_id = NULL` on those three ids restores the prior state exactly.

**Why the link was missing at all is NOT established.** The purchase order is
`RECEIVED` and carries AutoCount's `PO-009024`, so it is not a draft artefact.
Whether the convert dropped them or they were added to the purchase order by hand
afterwards is UNKNOWN, and no evidence in the row settles it — recorded as
unknown rather than guessed, because a plausible story here would be exactly the
kind this ledger exists to stop.
