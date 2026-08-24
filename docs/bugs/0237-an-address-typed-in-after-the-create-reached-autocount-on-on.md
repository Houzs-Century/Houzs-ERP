## An address typed in AFTER the create reached AutoCount on one side only [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner, comparing our documents against the ones Inistate writes
— Inistate being the connector the ERP replaces: *"address 和 delivery address
也是你去查看一下 Inistate 开单都会把什么东西输入进去 AutoCount。"* Read off the
live book on 2026-08-16:

| | InvAddr1 | InvAddr3 | DeliverAddr1 | DeliverAddr3 |
|---|---|---|---|---|
| `HC-SO-2608-002` — address typed in by an EDIT | `dsdsd` | `05200 Alor Setar` | **(empty)** | **(empty)** |
| `HC-SO-2608-003` — address present at CREATE | `gjhghj` | `01560 Kangar` | `gjhghj` | `01560 Kangar` |
| `SO-013264/5/6` — Inistate's own | filled | filled | identical to Inv | identical to Inv |

**Root cause.** `CreateSo` falls back per line —
`so.DeliverAddr1 = Or(Str(p,"DeliverAddr1"), Str(p,"InvAddr1"))` — so a document
created WITH an address gets both copies from the one the ERP sends. `/edit`'s
header loop is `ContainsKey`-gated and `soEditHeader` only ever emitted
`InvAddr1..4`, so an address added or changed after the create updated the
invoice copy and left the delivery copy at whatever the create had put there —
empty, for an order created without one.

This is the same shape as the delivery-date and the clearing defects before it:
**the CREATE path fills a field and the EDIT path does not.** Three instances
now, all in the same function, all found by comparing the book against the ERP
rather than by reading either alone.

**Fix.** `deliverAddressOf` mirrors `soInvoiceAddress`'s four values onto the
`DeliverAddr*` keys, built FROM it rather than re-derived so the two copies
cannot drift — a second implementation of the five-columns-into-four packing is
exactly how they would. Omit-when-absent still holds on both copies, and
`clearedAcKeys` now nulls both when an address column is cleared: clearing one
half would leave the book showing a street on the delivery side that the order
no longer has.

The mirroring is not a guess about what AutoCount wants — it is what Inistate,
the system being replaced, already writes.

Also tidied: the extraction that created this file left `export` orphaned above
the doc comment (`export /**`), which compiles and reads as though the comment
belongs to the export rather than the function.

The first of the three new cases was observed RED with the mirror removed.

**Ref.** 2026-08-16, PR #2280.
