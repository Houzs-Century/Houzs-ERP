## Two more document-level hard deletes, and nobody had swept for the rest [high]

**Symptom** - the same capability the entry above removed from purchase orders
existed in two more modules. `DELETE /api/scm/purchase-consignment-orders/:id`
purged a CANCELLED PC Order, header and lines, behind a desktop "Permanently
delete" button. `DELETE /api/scm/quotes/:id` purged a quote with **no status
guard at all** - any quote in the active company, at any point in its life, by
id, including one already promoted to a sales order.

**Root cause (traced, not guessed)** - two separate causes, and the second is
the one that matters. (1) The PC Order module is a line-for-line clone of
`mfg-purchase-orders.ts`; the frontend hook said so in its own comment, "Cancel
+ delete (mirror PO)". The delete was copied along with everything else, and
copied WITHOUT the audit row the PO version at least wrote, so a purged PC Order
left no trace anywhere. (2) Nobody had ever swept for this class. Three hard
deletes were found on three separate occasions, one endpoint at a time, which is
the signature of ad-hoc discovery rather than an audit - so there was no way to
know whether three was the whole list.

The quote case had a second layer: `scm.quotes` (mig 0101) has no status column,
`expires_at` is written by nothing, and `promoted_to_order_id` is set only by a
conversion that already happened. Delete was not merely the worst retirement
path, it was the ONLY one. Removing it alone would have left the module unable
to close a quote at all.

**Fix** - both endpoints removed, with their callers:
`useDeletePurchaseConsignmentOrder` and the desktop CANCELLED-state button for
the PC Order; nothing for quotes, which has no frontend at all. PC Order already
had `PATCH /:id/cancel`, so removing the delete cost it nothing. Quotes did not,
so mig 0279 added `cancelled_at` / `cancelled_by` (the sibling documents' shape)
and `PATCH /quotes/:id/cancel` was built to use them - "open" now means not
promoted AND not cancelled, in the list filter, the edit path and the partial
index. Create-time rollback deletes left in place in both modules with comments
saying why. Two stale comments that still cited "Delete PO" as a live example
corrected (`MobileModuleDetail.tsx`, `PurchaseOrderDetail.tsx`), plus two
refusal messages in the PC Order module telling users to "delete" a PC Receive
that has no delete either.

The sweep that should have happened first now exists:
**`docs/hard-delete-inventory.md`** classifies all 70 `DELETE` handlers on the
SCM route surface plus every supabase `.delete()` call as VIOLATION / COMPLIANT
/ ROLLBACK-KEEP, records why each draft-discard and rollback is legitimate, and
names the one violation left open (`DELETE /trips/:id?hard=true` - no guard, but
zero callers and a different module's guide, so flagged not smuggled). Module
guides written for both modules, neither of which had one.

**Lesson** - a bug found three times in one day is not three bugs, it is one
missing audit. The fix for the third instance is the inventory, not the third
patch. And check what a delete is doing for the module before removing it: on
quotes it was carrying the retirement path, and deleting the delete without
replacing it would have shipped a dead end.

**Ref** - fix/remove-remaining-hard-deletes, 2026-08-11
