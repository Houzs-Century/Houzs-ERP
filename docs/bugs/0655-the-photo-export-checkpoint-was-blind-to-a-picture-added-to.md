## The photo export checkpoint was blind to a picture added to an older line [high]

<!-- area: AutoCount migration -->

**Symptom.** On go-live day the AutoCount line-photo export was re-run to top up
the 2026-08-31 snapshot. It reported new images only from the tail of the book.
A read-only census of the live book taken the same hour disagreed: **38 SO lines
and 17 PO lines carried a picture that the manifest did not have**, and four of
the SO ones sat at DtlKey 802568, 824817, 858533 and 873097 — far *below* the
917,140 checkpoint the resume starts from. A plain re-run would have printed
`new: 0` for them and been believed.

**Root cause (traced).** `export_side()` in
`backend/scripts/export-ac-line-photos.py` resumes with
`WHERE ... AND d.DtlKey > ? ORDER BY d.DtlKey`, and `load_done()` feeds it
`.state.json`'s `last_dtlkey`. DtlKey is the identity of the *line*, not of the
*picture*: staff attach a photograph to an order that already exists, so the
line keeps its old, low DtlKey and the picture is new. The resume predicate can
therefore only ever find photographs on lines CREATED since the last run. It is
structurally incapable of finding one added to an older line, and it says
nothing while failing — the same shape as the silent-failure class in 0654.

`FORCE=1` does find them, by re-reading every line from the top. That is the
wrong instrument here and the reason this needed a third mode rather than a
note in the runbook: it re-downloads thousands of `FurtherDescription` LOBs
(one measured line is 458,878 bytes) from the same SQL instance the ERP's
AutoCount write-back uses. Earlier the same day an unbounded scan of exactly
that column ran while the write-back was live, and
`SalesOrder.InternalSave()` failed with
`System.ComponentModel.Win32Exception: The wait operation timed out`. With the
scan stopped the identical write test passed 40/43. So on this book "just use
FORCE" trades a silent data gap for an outage.

**Fix.** `DTLKEY_FILE` names a file of DtlKeys — `<side> <key>` rows, or bare
keys — and the export reads exactly those, in parameterised `IN` chunks of
`BATCH`, instead of walking from the checkpoint. It is strictly NARROWER than
the normal query: it can only ever read fewer rows, so it is safe to run
against the live book while the write-back is up. The keys come from a
read-only census that selects DocNo, DtlKey and a picture COUNT and never the
picture bytes, in windows carrying an explicit
`DtlKey > @last AND DtlKey <= @last + @w` range predicate.

Two things the mode must not do, both guarded: it never advances (or regresses)
`.state.json`, because it visits keys below the checkpoint on purpose and a
lower checkpoint would make the next normal run re-scan covered ground; and a
key list that resolves to nothing for a side SAYS so rather than printing
`new: 0`, which is the very reading this bug exists to stop.

Proved on the live book, not by reading: the targeted run read 38 SO and 20 PO
lines and wrote **38 + 22 images, 0 failed** (the PO side yielding more images
than lines is the multi-picture case working). The PO manifest afterwards is
2,587 images over 2,409 lines with 152 multi-picture lines and a maximum of 5 —
which is the census's own count of the live book exactly.

**Ref.** feat/ac-photos-finish-2026-09-07, 2026-09-07.
