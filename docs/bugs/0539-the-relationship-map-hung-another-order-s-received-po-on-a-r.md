## The relationship map hung another order's received PO on a rebuilt sales order, and the PO drift check cried a false warehouse move [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-08-25, opening the Relationship Map of a CONFIRMED
sales order that had received nothing: its purchase chain showed **2 purchase
orders** plus a fully-RECEIVED GRN and a Purchase Invoice — a completed purchase
leg on an order whose own lines were all still PENDING. Separately, that order's
covering PO showed a red **"⚠ SO warehouse moved — this PO still points at the
old one"** on a line whose warehouse had never moved.

Both landed on `2990-SO-2607-019`, a sales order that had been REBUILT after an
earlier doc-no clobber (see the clobber write-up): the number it now carries was
briefly held by a different order, since renumbered to `2990-SO-2607-030`.

**Root cause (traced).** Two naive identity comparisons, each fooled by the
residue the rebuild left behind:

1. **`routes/document-flow.ts` — note-text beats the FK.** The map attaches a PO
   to an SO by two links: the hard `purchase_order_items.so_item_id`, AND the
   PO's free-text `"From SOs: …"` note (whole-token match). `2990-PO-2607-020`'s
   line items hard-link to `2990-SO-2607-030` (its real goods — BOAAT, received
   on GRN-2608-017, billed on PI-2608-016), but its note still read
   `From SOs: 2990-SO-2607-019` — a leftover from when 2607-030 briefly held the
   number 2607-019. The note match ran regardless of the contradicting FK, so
   the whole received chain was dragged onto the rebuilt 2607-019.

2. **`routes/mfg-purchase-orders.ts` (SO-drift) — raw NULL read as "moved".** The
   drift check compared the PO line's `warehouse_id` against the SO line's raw
   `warehouse_id` with `poWh !== soLineWh`. The rebuilt SO's lines carry
   `warehouse_id = NULL` (they inherit the header's `sales_location`), so
   `KL-uuid !== NULL` was true and "SO warehouse moved" fired on every such line
   even though nothing had moved.

**Fix.** (a) document-flow now drops note edges for any PO that carries a hard
`so_item_id` link — the note is authoritative only for pre-`so_item_id` POs with
no FK at all, so a stale note can no longer contradict the FK. (b) the drift
check resolves the SO line's EFFECTIVE warehouse (its own, else the order
header's, via `lib/so-warehouse.resolveLineWarehouseId`) before comparing, and
only flags when BOTH sides resolve to a real, DIFFERENT warehouse. New unit
tests in `so-warehouse.test.ts` pin the null→header resolution (proved RED
against the old raw-NULL behaviour: a NULL line warehouse against a real PO
warehouse used to compare unequal and flag a move). The specific stale note +
NULL line warehouses on 2607-019 were also corrected in prod data.

**Ref.** fix/docflow-drift-clobber-hardening, 2026-08-25.
