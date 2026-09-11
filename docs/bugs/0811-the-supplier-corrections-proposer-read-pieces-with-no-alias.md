## The supplier corrections proposer read pieces with no alias fold and could not reach our own prefixless PO number [medium]

**Symptom.** Two ways the proposer that turns the supplier's listing into
correction entries would have written the wrong thing, both found while
regenerating it from the owner's 2026-09-11 export:

1. On `HC-PO-009986` and `HC-PO-010145` the supplier writes `CSL` where our
   catalogue mints `CONSOLE`. The proposer compares our pieces against the
   supplier's verbatim, so those two builds read as a piece DIFFERENCE and the
   entry it would emit names the supplier's spelling — a correction that renames
   our `CONSOLE` line to `8030-CSL`, a SKU the owner's own ruling says must not
   exist (「CSL 就是 console」, 2026-09-11). The applier already refuses an
   unminted piece SKU, so the visible outcome was six `piece SKU not minted`
   refusals on the 2026-09-10 round rather than a bad write — but the refusal is
   the last line of defence, not the intended one.
2. A supplier reference of `PO-2609-051` found no purchase order and was counted
   in the 80 "already delivered, do not chase" — while `HC-PO-2609-051` is right
   there. The Customer PO column writes our own number with the company prefix
   dropped, and the lookup tried only `linked_ac_docno` and `po_number` verbatim.

**Root cause (traced).** `propose-supplier-sofa-corrections.mjs` carried its own
`suffix()` — a local copy of "what piece is this line" that knows no aliases —
and its PO lookup had two shapes where the data has three. Both are the same
defect as `docs/bugs/0807` in the checker, in the file that FEEDS the applier:
the piece grammar lived in `lib/parse-sofa.mjs`, and every reader that re-spells
it drifts from it.

**Fix.** The proposer reads through `pieceSuffix` (the parse-sofa export added in
0807, which folds `CSL` onto `CONSOLE`), and tries a third lookup —
`HC-` + the reference — guarded to our own `PO-YYMM-NNN` shape so it can never
invent a match for an AutoCount number we do not hold. Proved on production:
not-found went 80 → 79, and `HC-PO-2609-051` now resolves (it lands in "build not
identified by one key", because an ERP-native order carries no AutoCount DtlKey
to address a build by — a separate gap, handled by the owner-directed
corrections file). Pinned by `backend/tests/supplierSofaLegPlan.test.mjs`'s
`pieceSuffix` cases, which fail on the unfolded reader.

**Ref.** fix/sofa-supplier-round2, 2026-09-11. Follows `docs/bugs/0807`.
