## A migrated delivery note paired two sofa colours by position, because the book carries no line key there [high]

**Symptom.** `DO-011505` and `DO-011478` each carry two lines of one sofa model
in two fabrics, and on both notes the two colours are EXACT SWAPS of what the
account book says — `DO-011505` DtlKey 920097 book `PC151-01` / ERP `PC151-17`
and 920099 book `PC151-17` / ERP `PC151-01` (reconcile run 34130727594). A
perfect swap on two separate documents is not two colour errors; it is
positional pairing. `docs/bugs/0672` records it as instance 2 and names the
writer as site 6, unfixed, because *"fixing it means deciding what to do when
the book carries no line-level key to settle it, which is a design call, not a
guard."* This entry is that decision, implemented.

**Root cause, traced.** `backend/scripts/lib/migrated-do-writer.mjs`
`buildMigratedDoPlan` buckets candidate sales-order lines on `(AutoCount SO
number, ERP item code)` — `indexSoLines`, `soByKey` — and then consumes them BY
POSITION:

```js
const ck = `${r.DoNo}|${r.SoNo}|${norm(erp)}`;
const used = taken.get(ck) ?? 0;
taken.set(ck, used + 1);
targets = [cands[used]];
```

`cands` is in the ERP's own `line_no` order and the book's rows are in the
book's. Colour is in neither the bucket key nor the tie-break. And the writer
then copies `variants` off whichever line it picked (`variants: t.variants ??
null`), so a mispair does not merely mis-link — it stamps the OTHER customer's
colour onto the delivery note, which is what the factory and the customer see.

**Why no key can settle it, PROVEN on the re-cut.** `backend/scripts/data/ac-reconcile-truth.json.gz`,
`exported_at 2026-09-08T00:03:44Z`: `fromSoDtlKey` is populated on **10,792 of
18,890 purchase-order lines and 0 of 48,772 delivery-order lines**. The book's
DO row carries no line key and no colour field at all — the row shape is
`{ DoNo, DoDate, SoNo, ItemCode, LineDesc, Qty, DebtorCode, DebtorName }`. So
there is nothing in the book to choose with, and position is a coin flip.

**Fix — the standing rule, implemented.** Pair on model + colour; where colour
does not resolve it, write NO link and list it for a person. Positional
consumption now happens only while the candidates are INDISTINGUISHABLE: if the
candidate lines carry more than one distinct `variantIdentity`, the row is
refused into the delivery note's own `dropped` list with a reason that says
which document and which code, and `stats.ambiguousColour` counts it.

`variantIdentity` (`scripts/lib/do-so-item-pairing.mjs`) is the repo's existing
colour signature — `pwpCode`, then `colourId`, then the summary, then
`description2`. Refusing on it rather than restating the rule is deliberate:
0672's own lesson is that a rule written a fifth time is a rule that drifts.

Both callers were updated in the same change, because a refusal nobody counts is
a silent drop: `sync-ac-delta.mjs` adds it to the ALL-OR-NOTHING `dropped` total
so an ambiguous line refuses the whole note rather than writing a partial one,
and `create-migrated-documents.mjs` prints a `colour-guard:` line beside its
existing `duplicate-guard:` one.

**A missing link is visible and recoverable. A wrong one is neither** — it puts
the wrong colour in front of a customer and reads as correct to every check we
have.

**The false negative this nearly produced, recorded because it is the point.**
`tests/migratedDoWriter.test.mjs` builds every fixture line with `variants:
null`, so all 22 of its tests pass IDENTICALLY with this rule and without it —
the guard is unreachable from that suite. Measured: with the guard disabled,
those 22 still pass and only the 4 new colour assertions fail. New fixtures live
in `tests/migratedDoColourPairing.test.mjs` and every one gives the candidates
DIFFERENT colours. This is the same shape as `planRepoint`'s short-circuit trap
in `docs/bugs/0684`, one module over.

**Proved RED first.** 4 failed of the 7 new assertions with the guard removed, 0
with it; 29 passed across both files after; the existing 22 unchanged either way.

**Ref.** fix/cutover-wrong-links, 2026-09-08.
