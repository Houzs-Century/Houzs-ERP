## A Special Order note that only repeats the line's colour printed it twice once fabricCode was filled [medium]

**Symptom.** After the 2026-09-15 Sofa Accessory data run wrote `variants.fabricCode`
onto pillow / cushion / stool lines whose colour was already typed in the Special
Order note, the printed Sales Order for HC-SO-013503 read
`COVE-13 / SPECIAL: Col : cove 13` (plus the `Remark: 账本原文: Col : cove 13` line),
HC-SO-2609-072's four lines read `COVE-11 / SPECIAL: COVE-11`,
`NICCA-01 / SPECIAL: NICCA-01` and so on, and the supplier's Purchase Order
HC-PO-2609-103 read `Fabric: COVE-08 / SPECIAL: COVE-08`.

**Root cause (traced).** Every document line, screen and the AutoCount Description 2
fallback compose the variant text through ONE function, `buildVariantSummary`
(`backend/src/scm/shared/variant-summary.ts`, byte-identical frontend copy). It
prints the fabric segment first and then pushes `variants.extraAddonNote` into the
`SPECIAL:` segment unconditionally; its only dedupe compared fabric keys with each
other (`fabricCode` / `colorCode` / `colourLabel`) and specials with each other
(`foldRedundantSpecials`), never the note with the fabric. Observed, not inferred:
the real generators were run over the 368 production Sofa Accessory lines that carry
`fabricCode` (read-only run 34965615433 — 150 SO, 110 PO, 58 GRN, 17 DO, 31 PI, 2 SI;
180 also carry a note). `renderSalesOrderInto` drew `COVE-13 / SPECIAL: Col : cove 13`
for HC-SO-013503; `purchaseOrderPdfBase64` drew the PO lines as above. 77 of the 368
composed texts repeated the colour and nothing else in the note.

Stored `description2` is a separate path: the data run did not rewrite it
(HC-SO-013503 still stores `Col : cove 13`), but POs converted afterwards stored the
composed repeat (HC-PO-2609-103 / -104 / -105 / -106 / -108 / -110 / -113 and others,
at least 24 lines), and `composeDescription2` sends a stored value to AutoCount
verbatim. No line reached the 100-character limit: longest stored text sent is 61,
longest composed (labelled) 65 before and 73 across all lines.

**Fix.** `buildVariantSummary` drops the note only when every word of it — ignoring
colour labels (`Col`, `Colour`, `Fabric`, ...), punctuation, case, letter/digit
boundaries and leading zeros — already appears in the fabric segment, and the
add-on carries no charge. A note with any other word prints whole: a colour name
(`MODENZA-04 (MUSTARD)`), a quantity (`BO315-28 SKY x2`) or a typed code that
disagrees with the fabric (`CH151-5 (PEARL)` beside `CH141-05`), so the supplier
never loses an instruction and a mismatch stays visible. On the 368 production lines
this changes exactly the 77 pure repeats. Tests, RED on the unfixed tree (5 of 10
and 2 of 3 failed) and GREEN after:
`backend/src/scm/shared/variantSummaryNoteRestatesColour.test.ts` (the production
variants, the labelled supplier form, `composeDescription2`),
`frontend/src/vendor/scm/lib/pdf-note-restating-colour-prints-once.test.ts` (what the
real SO and PO PDF generators paint). `po-convert-line.sofa-accessory.test.ts` had
pinned the repeat as correct and now pins the single print.

Not changed: a stored `description2` that already holds the repeat is echoed to
AutoCount until the line's variants are next saved; the separate `Remark:` line
(the `账本原文:` book copy on migrated SO lines, `notes` on PO lines) still prints.

**Ref.** fix/accessory-colour-printed-twice, 2026-09-15.
