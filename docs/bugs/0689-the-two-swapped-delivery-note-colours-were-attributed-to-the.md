## The two swapped delivery-note colours were attributed to the wrong writer, and the book carried the colour all along [high]

**Symptom, unchanged and still OPEN.** `DO-011505` and `DO-011478` each carry two
lines whose fabric colour is an exact swap of what the account book says
(reconcile run 34130727594). Nothing here fixes those rows; this entry corrects
what CAUSED them, because the recorded cause is wrong and a wrong cause is worse
than none — it sends the next person to a file that cannot have done it.

**What was recorded.** `docs/bugs/0672` lists them as instance 2 of the
key-without-identity class and names **site 6, `scripts/lib/migrated-do-writer.mjs`**,
as *"the writer that produces that shape"* — its `(SO number, item code)` bucket
consumed positionally, so two lines of one code in two colours pair by sequence.
`docs/bugs/0688` repeated it.

**What the book says — REFUTED.** Read against the re-cut
(`backend/scripts/data/ac-reconcile-truth.json.gz`, `exported_at
2026-09-08T00:03:44Z`), the swapped lines do not share an item code on either
document, and the mapping sheet keeps them apart in the ERP too:

```
DO-011505  DtlKey 920097  HOK-1003 (A) (K)  Desc2 PC151-01/Gap:12inch/...   -> HILTON (A)-(K)
           DtlKey 920099  HOK-1007 (Q)      Desc2 PC151-17/Gap:12inch/...   -> CODY-(Q)
DO-011478  DtlKey 917532  HOK-1007 (Q)      Desc2 COLOR:PC151-13/DIVAN:...  -> CODY-(Q)
           DtlKey 917534  HOK-1005 (Q)      Desc2 COLOR:PC151-06/DIVAN:...  -> FENRIR-(Q)
```

`autocount-erp-mapping-1561.csv` maps the three AutoCount codes to three
DIFFERENT ERP codes. So the two rows on each note **never land in one `soByKey`
bucket**, no positional choice is ever made between them, and site 6 cannot be
the mechanism. The colour-pairing guard added in `docs/bugs/0688` provably cannot
fire on either document. They are also bedframes, not sofas.

**Two facts that should have been enough to doubt the attribution earlier, and
that point at where to look next:**

1. **The book states the colour on the line itself.** All four rows carry it in
   `Desc2` — `PC151-01`, `PC151-17`, `PC151-13`, `PC151-06`. This is not a case
   of the book being silent, which is what the site-6 story rests on. Something
   read that Desc2 and put the answer on the wrong row, or did not read it.
2. **A perfect swap between two DIFFERENT products is a stronger signal, not a
   weaker one.** Two rows of one code swapping is ordinary positional drift; two
   rows of different codes swapping means whatever assigned the colour was not
   keyed on the product at all.

**Where a reader should start.** The fabric matcher and the Desc2 decoder, not
the delivery-order writer: `scripts/lib/fabric-colour-match.mjs`,
`scripts/lib/parse-sofa.mjs`, and whichever import path wrote `variants` onto
these bedframe lines. `docs/bugs/0672` site 16 already records that the matcher
resolves a BARE NUMBER with the series assumed to be `PC` — and every colour
above is a `PC151-NN`, which is exactly the shape that guess would collide on.
That is a lead, **not a finding**: it has not been checked against these four
rows and must not be written up as the cause until it has been.

**Fix.** NONE HERE, deliberately. This entry changes the attribution in
`docs/bugs/0688`, the module guide and the source comment in
`migrated-do-writer.mjs`, so no reader is sent to a file that cannot have done
it. **The two documents' rows are untouched and are still wrong.** The
mechanism is UNKNOWN.

**Lesson.** `docs/bugs/0672` reached site 6 by reading the writer and finding a
shape that COULD produce a swap, then matching it to a swap that existed. That is
the guess CLAUDE.md forbids, wearing the clothes of a trace: the refutation cost
one lookup of the two documents in an export that was already in the tree. **A
mechanism that could produce the symptom is a hypothesis until you check that it
did.**

**Ref.** fix/do-colour-guard-attribution, 2026-09-08.
