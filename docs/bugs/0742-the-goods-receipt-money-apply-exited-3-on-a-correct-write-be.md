## The goods-receipt money apply exited 3 on a correct write, because its verify still asserted the pre-grouping shape [medium]

**Symptom.** Run
[34307013844](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34307013844),
`repair-gr-money-from-book.mjs MODE=apply`, wrote all 77 receipts and then:

```
APPLIED, BUT THE VERIFY FAILED on 24 assertion(s):
   HC-GR-000815: line 5527-1A(RHF) holds RM 0.00/RM 0.00, the book states RM 3373.45/RM 2867.43
   HC-GR-000815: line 5527-1A(LHF) holds RM 0.00/RM 0.00, the book states RM 3373.45/RM 2867.43
   HC-GR-005045: line 9058-CNR holds RM 0.00/RM 0.00, the book states RM 2540.00/RM 2540.00
   ...
```

exit code 3.

**Root cause. The write was right and the assertion was wrong.** Every one of
the 24 is a NON-LEAD compartment row correctly holding RM 0.00 — the shape
`docs/bugs/0738` had just introduced, where a sofa's price rides the lead piece
and every sibling is zeroed. The verify block still asserted the rule from
before that fix, that *every* line equals the book's `SubTotal` for its own key,
and it was never updated with the plan. Not one header assertion failed, which
was the signal: every header equalled its lines throughout.

**Proved on a fresh connection, a different way.** Re-planning immediately
afterwards — run
[34307484738](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34307484738)
— answered:

```
agree already 368 · would change 0
money: RM 0.00 -> RM 0.00  (RM 0.00)
```

291 already agreeing plus the 77 written = 368. The data landed exactly as
planned, and the repair is idempotent.

**Why this is worth an entry rather than a one-line edit.** An apply that exits
non-zero on a correct write is worse than one that exits zero on a wrong one, in
one specific way: it teaches its next reader that the exit code does not mean
anything. This repo's whole release discipline rests on the fourth gate — a
fresh-connection SHAPE assertion — being trusted, and a shape assertion that
disagrees with its own writer trains people out of reading it.

**Fix.** The verify groups by the book's line key and asserts the shape the
write actually makes: within one book line the LEAD row carries the book's
`UnitPrice` and `SubTotal`, every sibling is zero in all three money columns,
and the header equals the sum over DISTINCT book lines. The sibling assertion is
the tighter half — it fails on the multiplication of `docs/bugs/0738` as well as
on a missing write.

**The lesson.** `docs/bugs/0738` changed the write and its unit tests in one
change and left the verify behind, because the verify lives in the runnable
script and the tests live in `lib/`. **When a repair's RULE moves, the shape
assertion is part of the rule, not part of the plumbing.**

**Ref.** fix/ac-align-so-po-gr, 2026-09-09. The repair is `docs/bugs/0737`; the
grouping it was left behind by is `docs/bugs/0738`.
