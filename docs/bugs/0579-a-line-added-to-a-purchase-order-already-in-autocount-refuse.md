## A line added to a purchase order already in AutoCount refused the whole document [medium]

**Symptom.** Owner, 2026-08-31: 「add line、delete line 还有调整 SKU 的 line 等等
这些操作都不行」, and he asked for the write-back to be given add-a-line and
remove-a-line. Adding a line to a purchase order the account book already held
produced no error in front of the operator and no change in AutoCount — the
whole document's edit was refused and left as a `skipped` outbox row nobody was
looking at.

**Root cause (traced).** Not missing capability — missing WIRING, on one of the
two document types. A new line carries no AutoCount key, and a keyless line
means two opposite things (just added, or never backfilled), so `composeEdit`
refuses the document rather than guess. The escape hatch already existed at both
ends: the route declares the rows it inserted (`newLineIds`), `composeEdit`
marks them `IsNewLine`, and `AcSyncService` turns that into `AddDetail()`. The
sales order was wired to it on 2026-08-11; the purchase order never was —
`queueAcPoEdit` had no parameter for it and `enqueueEdit` passed `newLineIds` to
`composeSoState` only. `mfg-purchase-orders.ts` even said so in a comment:
*"That refusal is correct until IsNewLine is implemented."* It was implemented;
that half of the sentence had gone stale.

Two things this was NOT, both checked before changing anything:

* **not the sales order.** HC-SO-013393, the order the owner was editing, was
  probed on production (run 33368777505, read-only): status CONFIRMED, in
  AutoCount, all 9 lines carrying a key, and **10 of 10 outbox rows `sent`, 0
  failed, 0 skipped**. His line delete and bedframe add did reach the book.
* **not remove-a-line.** Retirement (`Qty = 0`, `Transferable = false`,
  `[ERP-CANCELLED]` on Desc2) has been live on all six document types since
  2026-08-11; every DELETE handler calls `retiredLineOf`.

**Fix.** `newLineIds` threaded through the purchase-order path — `queueAcPoEdit`
→ `enqueueEdit` → `composePoState` → `composeEdit` — and passed by the two
routes that insert PO lines (`POST /:id/items`, `POST /:id/convert-from-so`).
The guard is unchanged and still does the work: an undeclared keyless line
refuses the document exactly as before.

A new line also needs a stock location, and that needed a NEW option rather than
the existing `defaultLocation`: that one applies to every line, and on an edit an
existing line with no location must keep omitting the key so the book keeps the
value it owns. `newLineLocation` reaches the declared-new lines only, and the
purchase order's own warehouse fills it.

**What was deliberately not done.** The first version of this change also
REFUSED a declared-new line that ended up with no location at all, reasoning from
`MissingLocationError`'s live-book evidence. That evidence is from the CREATE
path, which assigns `Location` unconditionally so an absent one arrives as `""`
and dies on `FK_SODTL_Location`; the edit path is `ContainsKey`-gated, so an
omitted key leaves AutoCount to apply its own default — a different mechanism.
The refusal turned the existing sales-order add-line test RED, which is how the
borrowed evidence was caught. Whether AutoCount defaults a new detail's location
from the header is **UNKNOWN**; until it is measured, the key is omitted and a
real failure would arrive loudly as a `failed` row naming the foreign key.

**Tests.** Five, beside the sales order's three: declared goes as `IsNewLine`;
undeclared still refuses; a new line inherits the document's warehouse; with no
warehouse anywhere the key is omitted; and — the regression that would otherwise
be invisible — an EXISTING line with no location still sends no `Location` key,
so the stand-in cannot silently relocate somebody else's stock.

**Still not wired:** add-a-line on DO / GR / IV / PI. Those documents are built
by conversion from a parent, so a line with no parent line is a different
question, not a missing wire.

**Ref.** feat/ac-writeback-add-line, 2026-08-31.
