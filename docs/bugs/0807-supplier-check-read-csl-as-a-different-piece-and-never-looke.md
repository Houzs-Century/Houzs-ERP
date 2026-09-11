## Supplier check read CSL as a different piece, an inch mark as a different height, and never looked the other way [medium]

**Symptom.** Three separate ways the supplier-vs-us comparison told the owner
something untrue on 2026-09-11, all on the same run (34563471672, production,
taken AFTER the compartment corrections of run 34557669854 had landed and
verified):

1. **Two sofas that agree were reported as DIFFERENT PIECES** — the "costs money"
   bucket. `HC-PO-009986` (supplier `1A(LHF)+1NA+CSL+1A(RHF)`, ours
   `1A(LHF)+1A(RHF)+CONSOLE+1NA`) and `HC-PO-010145`. PR #3613 had already
   settled that the supplier's `CSL` is our `CONSOLE` (owner 2026-09-11), but it
   rewrote the CSL spellings sitting in the three correction FILES; nothing
   taught the READER that meets the supplier's own export at run time. The
   handoff duly predicted "resolved by the re-apply" — the re-apply could not
   resolve it, because the data was never the problem.
2. **Two documents were reported as DIFFERENT VARIANTS on the inch mark alone** —
   `HC-PO-009652` and `HC-PO-010146`, `leg height: supplier "1" vs ours "1""`.
   The bedframe side of this was fixed in PR #3614 (compare div/gap/leg as
   NUMBERS, not strings); the sofa side kept comparing strings.
3. **A purchase order of OURS that the supplier does not hold was invisible.**
   The owner found `HC-SO-013503` / `HC-PO-2609-053` by hand — raised 2026-09-10,
   three 8030 compartments, absent from an export taken 2026-09-11 — and asked
   why it was missed. Because the check only ever walked the SUPPLIER's
   documents asking whether we hold them. Nothing looked the other way.

**Why it matters beyond the counts.** The owner reads this report to decide
whether he can do a goods receipt. Bucket (1) says "the supplier built something
else" about a sofa that is right, which stops a GR that should proceed; (3)
silently drops documents the supplier has not keyed in, which is exactly the case
where what arrives cannot match what we ordered.

**Root cause.**
- `suffix()` in `check-supplier-listing-vs-erp.mjs` cut the model off the item
  code and compared the rest verbatim, with no piece-name fold.
- the variant comparison read every axis through `norm()` (trim + upper-case), so
  `1` and `1"` were two values.
- there was no reverse pass at all.
- (fourth, smaller) the not-found bucket printed a TEXT min/max over mixed
  document shapes (`HC-PO-2609-001` sorts before `PO-000254`) and called it a
  floor. Read as one, it wrote off 20 references that sit INSIDE our range. Our
  AutoCount numbers are sparse — 574 of the 9,917 between the lowest and the
  highest — because the cutover's scope was OUTSTANDING documents, not a cut-off
  number.

**Fix.** `SOFA_PIECE_ALIAS` and `pieceSuffix` now live in `lib/parse-sofa.mjs` —
the module that owns the piece grammar — so the checker and the leg backfill
cannot disagree about what a piece is. Heights compare through a numeric reader
that falls back to the string when there is no digit (so `Default` is still a
word). The bridge tries a third shape, our own number with the `HC-` prefix the
supplier's Customer PO column sometimes drops (`PO-2609-051` → `HC-PO-2609-051`).
The not-found bucket is classified against the numbers we actually hold. And a
new section walks OUR purchase orders per supplier: a supplier this listing does
not cover at all is named as out of scope, one it covers partly gets a chase
list.

**Measured, same production data, before → after:** different pieces 4 → 4 (the
two CSL documents left, two genuinely-different ones arrived with the fuller
export), different order 13 → 15, our PO not found 80 → 79, and the chase list
now names `HC-PO-2609-053` alongside 8 other Hookka orders and 1 Ohana one.

**Ref.** fix/sofa-supplier-align, 2026-09-11. Tests:
`backend/tests/supplierSofaLegPlan.test.mjs` (piece fold + the leg-fill gate).
