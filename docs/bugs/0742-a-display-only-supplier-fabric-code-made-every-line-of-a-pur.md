## A display-only supplier fabric code made every line of a purchase order cry SO drift [medium]

**Symptom.** Owner, 2026-09-09, on `2990-PO-2608-020`: "after update the supplier
date 2 & save then will prompt out like this (red color) ... if update supplier
delivery date dont need re-send PO to supplier, only item details amend need to
re-send to supplier". All three lines carried the red drift note and the header
banner "3 lines source SO changed after this PO was raised — check the red notes
below, sync the specs, then **re-send to the supplier**". Nobody had re-specced
anything; the sales order was untouched since it was raised.

**Root cause (traced).** The two variant snapshots differ by ONE key, and it is a
DISPLAY key. Against production (Supabase `anogrigyjbduyzclzjgn`):

```
poi.variants: {... "colourLabel": "EZ-010 Silver", "seatHeight": "30",
               "legHeight": "2\"", "fabricSupplierCode": "M2402-17"}
soi.variants: {... "colourLabel": "EZ-010 Silver", "seatHeight": "30",
               "legHeight": "2\""}                      -- no supplier code
```

so the stored Description 2 of the two sides reads
`EZ-010 Silver (M2402-17) / SEAT 30 / LEG 2"` against
`EZ-010 Silver / SEAT 30 / LEG 2"`.

`fabricSupplierCode` is the supplier's own code for our fabric. It is stamped at
READ time by `enrichLinesWithFabricSupplierCode`, whose own header says it "never
mutates stored data" — but the PO editor seeds its line drafts from that enriched
read and sends `variants` straight back on Save, so the enrichment lands in the
row. `computeSoDrift` compared `buildVariantSummary` of the two raw snapshots, so
the parenthesised code alone read as a spec change on every line.

That the write happened at the reported save is visible in the row versions: the
header audit row for the supplier-date change is `xmin` 468024, and the three PO
lines and their three SO lines were written straight after it at 468026 / 468029
/ 468030 / 468033 / 468034 / 468037 — the per-line PATCH plus its
`recomputeSoPicked`, interleaved. The PO was raised on 2026-08-21 in transaction
357495. The stamp is also NOT what a conversion writes: only 45 of 160 `2990-PO`
fabric lines carry the key (42 of 244 on the SO side) — it arrives with an edit.

Seven POs were showing the phantom, five of them live: `2990-PO-2608-020` (3
lines), `-2608-035` (2), `-2609-002` (4), `-2609-013` (1), `-2609-014` (2), plus
received `-2606-012` and `-2608-001`.

**Fix.** `computeSoDrift` strips `DISPLAY_ONLY_VARIANT_KEYS` from BOTH sides
before building either summary, so the compare — and the message it prints — is
about the spec and nothing else. No data migration: the fix reads correctly over
every row already stamped. `so-po-drift.test.ts` pins the production shape (same
spec, supplier code on one side only, expect `null`) and that a real spec change
still reports with the code out of both messages; both were proved RED on the
unfixed tree (2 failed / 4 passed) and green with the fix.

`fabricSupplierCode` is still round-tripped into storage by the editors — nothing
else compares stored variants for equality (`computeVariantKey` reads an
allow-list, so bucket identity was never affected), but the write-side strip is
the follow-up this entry hands on.

**Ref.** fix/po-so-drift-supplier-code, 2026-09-09.
