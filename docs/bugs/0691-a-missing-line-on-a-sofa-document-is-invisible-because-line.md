## A decomposed sofa's extra rows can make the line count agree while a real line is missing [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-SO-012128` is short four `SQUARE PILLOW`s and no reconcile column
says so. What the checker reported instead was one item-code difference and one
quantity difference, both on the same AutoCount line key:

```
SO-012128 DtlKey 924549: AutoCount "HOK-SQUARE PILLOW" vs ERP "9028-1A(RHF)"
SO-012128 DtlKey 924549: AutoCount qty 4 vs ERP qty 1
```

Neither is real. `9028-1A(RHF)` is a compartment of the sofa on the line ABOVE it.

**Root cause (traced).** The book holds two lines:

```
SO-012128 seq=16  key=833309  HOK-5530 SOFA     qty 1  desc2 "(1EL+1ER)28inch/Col:BO315-2 ..."
SO-012128 seq=32  key=924549  HOK-SQUARE PILLOW qty 4  desc2 "FOR CONPESSANTION WRONG ITEM DELIVERY"
```

`HOK-5530 SOFA` folds through `SOFA_MODEL_ALIAS` to model `9028` and its Desc2
`1EL+1ER` decomposes into TWO compartments, so the ERP holds two rows for that one
book line. The pillow line was never imported. **The ERP therefore holds two lines
and the book holds two lines, and the counts agree** — proved by this document
appearing in neither `unmatchedAc` nor `unmatchedErp` in run `34182710620`, whose
`SHOW` was large enough to print both lists whole (26 and 126 entries).

With the counts equal, `F.lineCount` never fires. The pairing then matches the
book's sofa line to the first compartment row by DtlKey, and has nowhere to put
the book's pillow line except the SECOND compartment row — so a missing line is
reported on the item-code and quantity axes, where it is not a defect and cannot
be repaired.

The document-level sofa declaration is the same blind spot from the other side:

```js
const sofa = splitSeen || erpLines.some((l) => l.line_suffix) || acLines.some((l) => isSofaCode(l.itemKey));
if (acLines.length !== erpLines.length) { if (sofa) D.lineCount++; else F.lineCount.push(msg); }
```

That declaration is per DOCUMENT, not per line — correct for the sofa lines,
wrong for the ordinary lines beside them on a MIXED document. 495 sales orders and
152 purchase orders are sofa-decomposed, so that is the size of the blind spot,
not one document. Same shape as `docs/bugs/0682`: a per-LINE rule applied to a
whole document is a clean exclusion on a pure document and a silent hole on a
mixed one.

**Fix.** NOT FIXED HERE — named, sized and handed over rather than patched
mid-go-live, because the fix changes a number the owner is currently reconciling
against. What it needs: count the DISTINCT AutoCount line keys the ERP claims
rather than the ERP rows, so a decomposition contributes one either way, and
compare that against the book's line count. On `SO-012128` that reads 1 against 2
and the missing pillow line becomes a finding, while all 495 sofa documents that
are actually complete stay silent.

`HC-SO-012128` itself needs its four `SQUARE PILLOW`s added from the book. That is
a line ADDITION, which no item-code correction may do.

**Ref.** fix/so-sofa-model-escalation, 2026-09-08. See also
`docs/sofa-model-disagreement-2026-09-08.md`.
