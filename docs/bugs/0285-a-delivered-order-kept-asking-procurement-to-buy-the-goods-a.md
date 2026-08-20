## A delivered order kept asking Procurement to buy the goods again [high]

**Symptom.** Owner, 2026-08-17, with screenshots of MRP · Stock Status: *"check
all these SO already have PO & some done delivered, why still appear at MRP for
ordering"*. `2990-SO-2607-012` (BARON-(K), ARRUS-SOFT MATT Q) and
`2990-SO-2606-019` (TRION-(K), KETTA-FIRM MATT K) were sitting in MRP as
SHORT — orange, still to order — while their goods had shipped, stock was
deducted and the customer had the furniture. Both orders also read CONFIRMED
instead of DELIVERED. Reported as "还是出现" — it had been raised before.

**Root cause (traced, not guessed).** `delivery_order_items.so_item_id` was the
ONLY key either coverage engine read:

- `soDeliverableRemaining` (`delivery-orders-mfg.ts`) sums delivered qty with
  `.in('so_item_id', soItemIds)`, and MRP subtracts that from demand;
- `isSoFullyCovered` (`so-delivery-sync.ts`) opens with
  `if (!d.soItemId) continue;`, and that decides CONFIRMED → DELIVERED.

That column is nullable behind
`delivery_order_items_so_item_id_mfg_sales_order_items_id_fk … ON DELETE SET
NULL` (confirmed against prod `pg_constraint`, `confdeltype = 'n'`), so deleting
ONE Sales-Order line blanks the pointer on every downstream document that served
it — the same hazard `so-line-relink.ts` was written to defend against on the
PO/DO/SI side. When it blanks, a shipment that physically happened becomes
invisible to BOTH engines at once, and the two symptoms above are one fact read
twice.

Measured on prod, not inferred: **26 lines across 8 non-cancelled DOs** carried
`so_item_id IS NULL` while their DO header still named the order —
2990-DO-2607-008/009/011/013/014/025, 2990-DO-2608-003 and 2990-DO-2608-008.
`scm.inventory_movements` carries the OUT for them.

The links were NOT missing at creation. `scm.mfg_so_audit_log` for
2990-SO-2607-012 records, six seconds after 2990-DO-2608-008 was raised on
2026-08-13, `UPDATE_LINE → "READY: 2990S WP MP (K), …"` and `UPDATE_STATUS
CONFIRMED→DELIVERED` — two rows only reachable through a populated
`so_item_id`. They are gone now, and no trigger exists on the table
(`pg_trigger`: none) and no code writes the column to NULL (`grep`), which
leaves the FK as the mechanism. **Which path deletes the SO line is still
open** — this fix does not claim to have closed it, and says so where it
matters.

**Fix.** Three parts, in the order they help:

1. `backend/scripts/repair-do-so-item-links.mjs` + `scripts/lib/do-so-link-repair.mjs`
   — re-point the orphaned lines. A repair is offered only when it is FORCED:
   same SO doc (from the DO header), same item code, same qty, exactly one
   candidate, no competing claim. Dry-run by default, verified in-transaction
   against an over-delivery check, rolled back otherwise.
2. `backend/src/scm/lib/do-unlinked-coverage.ts` — give both engines the SECOND
   reading the database always held: `delivery_orders.so_doc_no`. Attribution is
   confined to the order the DO header names, matched on item code, and capped
   by what the real links already cover, so a repaired line and its unlinked
   twin can never double-count and no unit can move between orders.
3. Wired into `soDeliverableRemaining` (§2b) and `syncSoDeliveredFromDo`, with
   the synthesised lines registered for return-netting exactly like linked ones.

**What was deliberately NOT done.** `2990-DO-2607-017` has zero line rows and
three OUT movements — its lines are gone entirely, not just unlinked. Rebuilding
them writes money onto a customer-facing document from inference, and the fate
of its three service lines is a business call; it is reported, not guessed.
`2990-SO-2606-030`'s pillow is refused too: ordered qty 1, already delivered by
2990-DO-2608-010, with a second orphaned line on 2990-DO-2607-013 — linking it
would report 2 delivered against 1 ordered.

**The trap this leaves behind, and what holds it.** `loadUnlinkedDoCoverage` is
best-effort: a failed read returns `[]`, which is the same sentence a healthy
system produces. So it is written with two plain reads instead of the elegant
embedded-column filter (`.in('parent.so_doc_no', …)`) — the one PostgREST shape
the fake client in the route tests cannot exercise, and therefore the one that
could ship as a silent no-op — and the catch logs rather than swallows.

**Ref.** PR (branch `fix/do-so-link-repair-and-po-total-height`), 2026-08-17.
Tests: `backend/tests/doSoLinkRepair.test.ts`, `backend/tests/doUnlinkedCoverage.test.ts`.
