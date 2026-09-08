## A migrated delivery note paired two lines of one code by position, with colour in neither the bucket nor the tie-break [high]

> **CORRECTED the same day, before this entry was a day old.** The first version
> of this heading said "two sofa colours" and opened by naming `DO-011505` and
> `DO-011478` as the production instance. **The book refutes that attribution**
> and the correction is kept in place rather than quietly rewritten, because the
> wrong half is the more useful half to record. See the box below.

**Symptom.** `buildMigratedDoPlan` pairs an AutoCount delivery line to one of the
order's lines on `(AutoCount SO number, ERP item code)` and then takes the
candidates BY POSITION. Where one order carries two lines of one code in
different colours, the choice is a coin flip, and the writer copies `variants`
off whichever line it picked -- so the delivery note states the other line's
colour. **MEASURED on production, probe run 34180583537 (2026-09-08 10:35
local): 26 book delivery lines across 17 delivery notes are in that position
today, out of the 810 that pair at all** (784 paired + 26 ambiguous; the other
47,867 of 48,677 do not reach the ERP at all -- 46,609 have no ERP line because
the ERP holds only company 1's outstanding orders, and 1,255 are unmapped).

### What the book REFUTED, and it was my own opening sentence

`docs/bugs/0672` records `DO-011505` and `DO-011478` as instance 2 of the
key-without-identity class and names **site 6, this writer**, as "the writer that
produces that shape". This entry repeated it. Checked against the re-cut
(`ac-reconcile-truth.json.gz`, `exported_at 2026-09-08T00:03:44Z`), it is wrong
on both documents:

```
DO-011505  DtlKey 920097  HOK-1003 (A) (K)  Desc2 PC151-01   -> ERP HILTON (A)-(K)
           DtlKey 920099  HOK-1007 (Q)      Desc2 PC151-17   -> ERP CODY-(Q)
DO-011478  DtlKey 917532  HOK-1007 (Q)      Desc2 PC151-13   -> ERP CODY-(Q)
           DtlKey 917534  HOK-1005 (Q)      Desc2 PC151-06   -> ERP FENRIR-(Q)
```

The two swapped lines on each note carry **different AutoCount item codes that
map to different ERP codes** (`autocount-erp-mapping-1561.csv`). They therefore
never land in one `soByKey` bucket, no positional choice is ever made between
them, and **this guard cannot fire on either document.** They are also
bedframes, not sofas, which is why the heading changed too.

**So their colour came from somewhere else and is still unattributed.** The book
carries it plainly in the line's own `Desc2` on all four rows, so it was
available and was not used. That is `docs/bugs/0689`, open, and it is NOT closed
by this entry. Two documents that look like one mechanism are two findings until
someone shows they are one -- and the tidy story is what made this the wrong
answer the first time.

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
have. The 26 it now lists are pillows, storage, bedframes and DISPOSE lines, not
sofas; the sofa build takes the `soByModel` branch, which consumes every
compartment at once and makes no positional choice, so it is untouched by this
rule and untested by it.

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
