## The SO list said a document had NO purchase order while its own Relationship Map named one — the fix for the last version of this bug created this one [high]

**Symptom** - live production, `/scm/sales-orders`, company Houzs Century:
`HC-SO-011733` renders `—` in the PO No. column. The same document's
Relationship Map shows `PURCHASE ORDER HC-PO-008783` linked, and
`GRN HC-GR-004863` after it. Every row on the first page showed `—`.

**Root cause (traced, not guessed)** - not a missing join. The column reads
`source_po_union`, and that union is `soLineShippedSources` ∪
`soLineReadySourcePos` — **both arms require EXECUTION**. The shipped arm needs
a Delivery Order line carrying the `so_item_id`; the READY arm needs the line to
be READY *and* its bucket to hold an open lot that still resolves to a PO.
`HC-SO-011733` is CONFIRMED, all eight lines `stock_status='PENDING'`, zero DO
lines — and four of its lines DO carry `purchase_order_items.so_item_id` →
`HC-PO-008783` (status RECEIVED). That link was the old `converted_po_nos`
content, which the 2026-08-02 fix demoted to a **tooltip on the em-dash**.

Measured on production 2026-08-11 over the 2,723 Houzs Century sales orders:
at most **53** can light either source arm (23 have any linked DO line; 30 have
a READY line whose bucket holds a PO-resolvable open lot — 2,263 of the 2,366
open lots are migrated with neither `batch_no` nor a GRN, so they resolve to
nothing), while **277** carry a real non-cancelled PO on the line link. The
column was therefore blank for **~91%** of the orders that have a purchase
order. This is the SAME defect as the 2026-08-02 entry below, from the opposite
side: that fix replaced one incomplete arm with two other incomplete arms.

**Fix** - the cell renders the UNION of all three, with two chip identities that
are never conflated: SOLID = goods source (`source_po_union`), MUTED = raised PO
(`converted_po_nos`, filtered against the source set so a PO is never chipped
twice), each carrying its own tooltip. `—` now means "no purchase order of any
kind". Many-POs-to-one-SO is handled explicitly — the list cell caps at 3 and
appends a `+N` chip whose title lists every PO (12 Houzs SOs carry 2, one
carries 3), instead of rendering the first and staying silent. Before/after on
production: **53 → 295** sales orders show a PO number, a gain of 242. One pure
derivation (`frontend/src/lib/soPoChips.ts`) feeds desktop (`SoListPoCell` in
`components/SoSourceChips.tsx`) and mobile (`SourcePosRowMobile`'s new `raised`
slot), so the two surfaces cannot disagree about WHICH POs an order has. No
backend change: `converted_po_nos` was already on the list payload.

**The class, for next time** - a tooltip is not an answer. When a fix moves
information OUT of a cell because the cell's new meaning is narrower, check
what the cell now renders for the documents the new meaning cannot reach — here
that was the entire un-shipped migrated corpus, i.e. the go-live corpus. And
"the column is empty for every row on page one" is a population question, not a
row question: measure the arms against production before theorising.

**Ref** - 2026-08-11, `fix/so-list-po-and-specials-display`. Render tests for
both surfaces in `frontend/src/components/SoListPoCell.test.tsx`.
