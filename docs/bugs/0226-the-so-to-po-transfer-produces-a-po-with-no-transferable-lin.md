## The SO-to-PO transfer produces a PO with no transferable lines, and only half a Transfer link [high]

<!-- area: AutoCount sync + write-back -->

**Two symptoms, one document, found once `/so-to-po` stopped failing outright.**
Measured on the live book 2026-08-15, run `ZZQA-SO-20260815-233528` ->
`ZZQA-PO-20260815-233528`:

1. **The link is half written.** `/doc-read` on the PO's lines reports
   `FromDocNo = 'ZZQA-SO-20260815-233528'` and `FromDocType = ''`. The document
   number came across; the TYPE did not. Every other conversion writes both —
   `DO<-SO` and `IV<-DO` both carry `FromDocType` and `FromDocNo` on every line.
2. **The PO has nothing to transfer onward.** `/po-to-gr` refused with our own
   guard: `no transferable lines on PO ZZQA-PO-20260815-233528`. That guard
   reads AutoCount's own outstanding predicate,
   `Qty - ISNULL(TransferedQty, 0) > 0`, so the PO's line is either zero-qty or
   already counted as transferred the moment it was created.

**Why they are probably one fault.** The four ordinary conversions go through
`AddPartialTransferDetail(fromType, keys, transferMaster)`, which is handed the
source TYPE explicitly. `SO->PO` is the odd one: the SDK offers only
`AddSOToPOTransferDetail(Int64)` — one key at a time and **no type argument** —
so whatever that method does with provenance and outstanding quantity, it does
alone. Both symptoms are consistent with the PO line being created in a state
the rest of the system reads as "already dealt with".

**NOT yet traced, and deliberately not guessed at.** The PO was cancelled in
teardown before its lines could be read a second time. The next run must call
`/doc-read` on the PO **immediately** and record `Qty`, `TransferedQty`,
`Transferable` and `FullTransferFromDocList` per line — those four settle it.

**Consequence while it stands:** a purchase order raised from a sales order
reaches AutoCount, but AutoCount does not consider it convertible, so `PO->GR`
and `GR->PI` cannot run from it at all. The two purchase-side conversions remain
unproven end to end.

**Ref:** this PR, 2026-08-15.
