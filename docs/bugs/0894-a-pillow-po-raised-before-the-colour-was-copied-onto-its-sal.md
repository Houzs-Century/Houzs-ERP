## A pillow PO raised before the colour was copied onto its sales order says no colour to the supplier [medium]

**Symptom.** Owner, 2026-09-14: 「有一张枕头采购单没写颜色，找不出吗」. The custom
pillow probe (run 34836022321) listed HC-PO-2609-056 line 1 `SQUARE PILLOW` with
PO colour `""` while its sales-order line HC-SO-012826 line 2 reads `nicca 02`.

**Root cause (traced).** A purchase-order line copies its sales-order line's
`variants` when it is raised and stamps `description2` from
`buildVariantSummary` (`backend/src/scm/lib/po-convert-line.ts`); nothing
refreshes that copy afterwards. HC-PO-2609-056 was raised from the MRP page at
2026-09-10 03:20:26Z. The colour reached the sales-order line's
`variants.extraAddonNote` through the #3526 backfill, merged 14:50Z the same
day. Observed with a read-only query 2026-09-14: the PO line holds
`variants = {}`, `description2 = NULL`, `so_item_id` = HC-SO-012826 line 2,
whose `variants.extraAddonNote = "nicca 02"`.

Not quite "no colour anywhere": purchasing typed `COL: nicca 02 ` into the PO
line's REMARK (`notes`) at 2026-09-10 04:03Z (entity_audit_log), and the PO PDF
prints that as `Remark: COL: nicca 02`. What was missing is the Special note —
the field the PDF's spec line, the probe, and the SO-to-PO drift check read, so
the PO page also flagged "SO spec now: SPECIAL: nicca 02 (this PO still: -)".

**Fix.** Data repair, one line: `backend/scripts/fill-po-line-colour-from-so-line.mjs`
(+ `fill-po-line-colour-from-so-line.yml`) copies the sales-order line's note
into the named PO line's `variants.extraAddonNote` and recomputes
`description2` the way the PO line editor does, with an audit row. Scoped by
required PO numbers and an exact expected row count. HC-PO-2609-058 / 059 / 060
have the same gap and are deliberately NOT touched — they are duplicates the
owner is having cancelled.

Not fixed in code: a PO raised before a later sales-order spec change still
keeps the old copy. That is by design (the drift redline is the signal to
re-sync and re-send), not a new defect.

**Ref.** fix/po-2609-056-pillow-colour, 2026-09-14.
