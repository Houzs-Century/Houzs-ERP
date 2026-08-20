## A CANCELLED purchase order could be hard-purged from the database [high]

**Symptom** - not a crash; a capability that should never have existed.
`DELETE /api/scm/mfg-purchase-orders/:id` removed a CANCELLED PO's header and,
by FK cascade, every line. Both surfaces offered it: the desktop detail page
("Permanently delete PO ... This removes the header + all line items and cannot
be undone") and the phone action bar.

**Root cause (traced, not guessed)** - it predates the owner's rule
不可以删只可以 cancel, and nothing later re-checked it against that rule. The
code knew what it was doing and said so: the audit row written immediately after
the purge is documented as "the ONLY remaining evidence that the PO existed",
with po_number / supplier / total snapshotted into `field_changes` because
"nothing can be joined back to afterwards". An audit row that has to carry a
copy of the document is not an audit trail, it is an obituary. It is also a
cancel-divergence generator the moment AutoCount sync goes live: AutoCount keeps
a cancelled PO, a purged one has no row to reconcile against, and no way to tell
whether the ERP ever held that document.

**Fix** - the endpoint is gone, along with `useDeletePurchaseOrder`, the desktop
button and the mobile action. CANCELLED already did everything the delete was
used for: the PO leaves every working list, releases its SO quota and clears its
allocation sub-lines. The only thing delete added was losing the record.
Explicitly NOT removed, and called out in a comment where the endpoint used to
be: the create-time rollback deletes in `POST /` and `POST /from-sos`.
supabase-js has no transaction, so those compensating deletes are the only thing
standing between a failed line insert and a headerless orphan document - they
remove a document that never successfully existed. Removing them would be a
serious regression. The SO equivalent was audited and left alone: it is
DRAFT-only and refuses anything else with "A confirmed order must be cancelled,
not deleted", which is the rule already being honoured.

**Lesson** - when a comment has to explain that an action destroys the only
evidence of its own subject, the comment is the review finding.

**Ref** - fix/po-no-hard-delete, 2026-08-11
