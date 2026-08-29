## The PO's line editor had no way to attach a photo [medium]

**Symptom.** The owner, 2026-08-28, on a Purchase Order with the line cards open:
「还是不能添加照片啊」 — this AFTER #2759 shipped "purchasers attach add-on photos
directly on a PO line" that same afternoon.

**Both things were true.** #2759 added the strip to the PO's **table** view and
gave the server its upload and delete routes. The owner was on the **rich line
editor** — the screen a purchaser is on when they are specifying a line and want
to attach the photo that explains it — and that screen had no control at all.

**Root cause, and it is a shape worth naming.** `PoLineCard` was extracted from
PurchaseOrderNew's inline card and its header says it "Mirrors the SoLineCard
pattern". It mirrors the LAYOUT. It is not the same component. So when
`SoLineCard` grew a photo rail (PR-F), the PO card did not — there was no
mechanism by which it could. Two cards that look alike and drift apart is the
defect; it will recur the next time either grows something.

**I also got the diagnosis wrong on the way, and the owner corrected it.** I told
him SO and PO were consistent — both photos-on-the-table-only — because grepping
for `SoLinePhotoStrip` found nothing in the SO's editor. That was the wrong
search: the SO's rail is `SoLineCard`'s OWN markup, not the shared strip. He sent
a screenshot of the SO edit screen with the PHOTOS box in it, which settled it in
one move. The lesson is the ordinary one: a negative grep for ONE implementation
is not evidence that a FEATURE is absent.

**Fix.** `PoLineCard` takes a `photos` render slot — a node, not data, so the
card stays a layout and learns nothing about documents or permissions (a test
asserts it never grows an upload of its own, because a second one would drift
from the first). `PurchaseOrderDetail` fills it with the SAME `SoLinePhotoStrip`,
the SAME cohort gate (`canOperatePurchaseOrders`) and the SAME key-ownership test
(`isPoOwnedPhotoKey`) the table view uses, so the two screens cannot disagree
about who may write or about which keys they own.

**An unsaved line is TOLD why, rather than left bare.** The key is
`po-items/<po>/<item id>/…`, so the item id is not a detail — it is the address,
and a line that has never been saved has none. It says "Save this line first,
then attach photos to it." A rail that is simply absent is exactly what sent the
owner looking for it.

**Not done, and it is the gap against the SO:** `SoLineCard` STAGES files on a
brand-new line (`pendingPhotoFiles`) and drains them after save. The PO does not,
so a photo on a not-yet-saved line needs one extra save. Worth doing; not done
here, and not claimed.

**Ref.** feat/the-po-edit-card-can-attach-photos, 2026-08-28.
