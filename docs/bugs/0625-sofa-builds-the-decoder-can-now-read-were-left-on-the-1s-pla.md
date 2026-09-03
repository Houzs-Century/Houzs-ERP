## Sofa builds the decoder can now read were left on the -1S placeholder [medium]

**Symptom.** 119 sofa lines on 115 Houzs Century documents still sit on a bare
`{model}-1S` line with `SOFA UNPARSED` in the remark — one line where the order
is really a four- or five-compartment build. The line shows no compartments, so
its pieces cannot be allocated, received or picked, and the completeness audit
has counted them ever since the cutover without ever saying WHY each one is
there. "119 lines need a person with the photograph" and "119 lines the decoder
could read if it knew one more spelling" are the same number until somebody
looks.

**Root cause (traced).** Not a defect in the importer: when `parseSofa` could
not read a build out of AutoCount's Desc2, `import-ac-outstanding-so.mjs:301`
deliberately refused to guess and opened the placeholder instead
(`// never guess pieces — placeholder on the base SKU, human completes`). The
defect is that the placeholder is a SNAPSHOT of what the decoder knew ON THE DAY
THE ROW WAS WRITTEN, and nothing ever re-asks. The 2026-08-30 sweep taught the
grammar `1EFL`, `1Console`, `L2L(...)`, `1R(P)` and `1B/S seater`, and #1998
taught it to read an unlabelled fabric code the live library can confirm — so a
subset of those rows decode cleanly today from the text they already hold.

Observed, not reasoned: `backend/scripts/probe-sofa-placeholder-desc2.mjs` (a
read-only prod run, `workflow_dispatch` 33661069021, 2026-09-02) re-runs the
REAL decoder with `scm.fabric_colours` wired in as `knownColour` exactly as the
importer does, and buckets all 119. **14 of them decode cleanly today** (9 sales
order + 5 purchase order); 102 carry no build in the text at all and only the
photograph can answer those; 3 are a rejected token or the split guard.

**Fix.** `backend/scripts/redecode-collapsed-sofa-lines.mjs` — re-derives the
build from AutoCount's own words at RUN TIME (no curated list, unlike
`split-collapsed-sofa-lines.mjs`, which applies piece lists a person read off
photographs), re-codes the existing row as the first piece and inserts the rest
beside it. Match-and-UPDATE, never drop-and-reinsert, so the row id keeps the
`purchase_order_items.so_item_id` dedication bound-mode readiness reads. The SO
and the PO move in ONE transaction and a build whose two sides decode
differently is refused rather than reconciled. Money cannot move: the UPDATE
writes no money column at all and every inserted piece is 0 in every `%_sen`
column, and the document total is summed before and after inside the same
transaction. Any goods-receipt line or any delivery-order line against the row
refuses the build — stricter than "a GRN line or a posted DO", and the log says
which kind each refusal was so the cost of the wider rule is visible.

Pinned by `backend/tests/redecodeSofaPlan.test.mjs` (23 tests over the pure
half, `scripts/lib/redecode-sofa-plan.mjs`). Three of them are this repository's
own scars re-armed: every column is copied unless the code names a reason not to
(the `warehouse_id` omission that put seven prod lines at PENDING forever), every
`%_sen` column is 0 on an inserted piece, and a jsonb parameter is
`$n::text::jsonb` and never a bare `$n::jsonb`
(`docs/jsonb-double-encoding-coe.md`).

**Ref.** `fix/redecode-collapsed-sofa-lines`, 2026-09-02. Probe run
33661069021. The repair has been DRY-RUN against production only; it has never
been applied. The apply is the owner's.
