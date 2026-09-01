## A line added to a sales order made every later edit of that order impossible [high]

**Symptom.** Owner, 2026-08-31, from the write-back screen: one document HELD
BACK, *"The ERP cannot tell which lines AutoCount already has"*, and "Send again"
could not clear it. He had deleted a line and added one on HC-SO-013394.

**Root cause (traced).** Add-a-line worked. Learning the added line's IDENTITY
did not, and nothing had ever needed it before.

The route declares the row it inserted (`newLineIds`), `composeEdit` marks it
`IsNewLine`, and `AcSyncService` appends it with `AddDetail()`. **AutoCount then
assigns the DtlKey — and nothing carried it back.** The ERP row keeps
`linked_ac_dtlkey = NULL`, and because the declaration is per-REQUEST, the NEXT
edit of that document (a header change, a photo, a variant) does not declare
anything, so it hits the keyless-line guard and the whole document is refused.

Measured on production, read-only probe run 33383015421: HC-SO-013394 carries
**8 lines, 7 keyed, 1 not**; two edits SENT at 07:06:05 and 07:06:07, then two
SKIPPED at 07:06:23 and 07:06:44, both `keyless_line`.

`backfill-ac-line-keys.mjs` cannot repair it either — it matches against the
committed AutoCount EXPORT, and a line created in the book today is not in it.

**The owner's own hypothesis was different and it was REFUTED, with a test rather
than an argument.** He asked whether deleting a line and adding one in the same
document was the cause. It is not: `deleting one line and adding another in the
same document: both travel` (`autocount-outbox.test.ts`) passes — the `Retire`
and the `IsNewLine` are computed on different paths and both land correctly.

**Fix, in two halves that are safe in either order.**

*The service* (`scripts/autocount-service/AcSyncService.cs`): `/edit` now answers
with the document's line keys **when it added at least one line**, reusing the
same `CreatedLines()` SQL read-back the CREATE path has used since 2026-08-11 —
whose own comment says why it exists: *"Without them a document the ERP creates
has NULL DtlKeys forever, and the very next edit of it hits the keyless-line
refusal in Edit()."* The same sentence was true of an edit and nobody had said so.
An edit that added nothing answers exactly as before.

*The ERP* (`persistNewLineKeys` in `scm/lib/autocount-line-keys.ts`): stores those
keys — and does NOT reuse the create path's by-position zip, which would be
wrong here. The book orders by DtlKey (the document's original insertion order);
the payload is in ERP line order, so an added line can sit anywhere in ours and is
always last in the book's. It reasons on the DIFFERENCE instead: a key the payload
did not already carry is one this edit created, the Nth such key belongs to the
Nth declared line (AddDetail runs in payload order, AutoCount hands out ascending
keys), and the ItemCode is re-checked before anything is written.

`composeEdit` names the ERP rows behind each declared-new line (`ErpLineIds`, a
LIST because a sofa build is several rows behind one book line). AcSyncService
applies only the keys it knows, so that one is inert there.

**Fails closed, and no-ops on the old exe.** Any disagreement — count, ItemCode, a
declared line with no ids — stores nothing, and the line stays keyless, which the
next edit refuses loudly. A service built before this change answers with no line
list at all, which is a no-op: exactly today's behaviour.

**Tests** (`autocount-drain.test.ts`), the first RED before the fix
(`expected null to be 5099`):

- an edit that added a line stores the key AutoCount gave it;
- an edit answered by a service that reports no lines stores nothing and still succeeds;
- an edit whose new-line count disagrees with the book stores nothing.

**NOT LIVE UNTIL THE HOST IS REDEPLOYED.** The ERP half ships with this PR and is
inert on its own; the service half needs `deploy-on-host.ps1` on the AutoCount
machine. Until then the behaviour is unchanged, and the documents already stuck
stay stuck — those need a fresh AutoCount export plus `backfill-ac-line-keys`,
which is a stopgap and does not stop the next added line from repeating it.

**Ref.** feat/ac-learn-new-line-keys, 2026-08-31.
