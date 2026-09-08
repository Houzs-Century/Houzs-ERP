## The owner's own model decision was still counted as a difference against the book [medium]

**Symptom.** The sales-order verdict (run 34254777347) reported HC-SO-011657 in
`DIFFER ON THEIR CONTENT, AND IT IS WORK` on the `item code` axis:

```
SO-011657 DtlKey 803494: AutoCount "TNS-9838 DB" vs ERP "8030-STOOL"
  (ERP HC-SO-011657; the book's sofa is model 9838; ours says 8030)
```

That difference is the owner's own decision. Asked on 2026-09-08 what to do
about a book daybed whose stool SKU is not minted, he answered
「那就放8030 daybed把」, and PR #3312 wrote the build with a `modelOverride`
declaring the book model it overrides and who decided it. So the verdict was
handing him back a question he had already closed — the same shape as
`docs/bugs/0714`, on a different axis.

**Root cause (traced).** The declaration was read by exactly one reader.
`lib/sofa-corrections-book-grade.mjs:123` consults `b.modelOverride` and can
reach an `OWNER-OVERRIDE` verdict, and that is the CORRECTIONS grader — a
separate lane, run by `check-sofa-corrections-vs-book.mjs`. The reconcile's
item-code axis
(`backend/scripts/check-ac-erp-reconcile.mjs`, the `classifyItemCode` branch)
consults nothing of the kind: it calls `lib/item-code-class.mjs`, which
correctly answers `different` — `the book's sofa is model 9838; ours says 8030`
— and has no way to know a person decided it. The finding was then recorded with
`VERDICT.record(t, ac, d.erp_no, "item code", line)` and nothing downstream
could move it.

Observed, not inferred: the finding text above is the reconcile's own output on
run 34254777347, and the declaration is in
`backend/scripts/data/sofa-compartment-corrections-2026-09.json` under
`"docs": ["HC-SO-011657"]` with `"modelOverride": {"book": "9838 DB", "by":
"owner", "on": "2026-09-08"}`.

**Fix.** A declared override now moves the finding out of the locking channel
into its own declared bucket, `owner-model-override`, which prints the decision,
its owner and its date. It is NOT folded into `identical`: the line really does
differ from the book, and that difference is the only signal that would ever
catch a decision applied to the wrong document.

Two guards, both re-checked every run, and they are what separates this from the
hand-typed model of `docs/bugs/0693` (three documents held wrong against the
book for a month):

1. **it expires by itself.** The declaration names the book model it overrides,
   and the override only applies while the book still says that. Refresh the
   cut, let the book change, and the line goes back to DIFFER with nobody
   editing anything — nobody has decided what the line reads NOW.
2. **it names who decided it.** An entry with no `by`, or with no `book`, is an
   ordinary typed model and is graded as one; `makeModelOverrideIndex` refuses
   to index it at all.

Both models are compared through `modelOf` from `lib/item-code-class.mjs` — the
same fold that decided the finding — so an override cannot bless a pair the
classifier would have called something else, and a null model on either side is
never a match.

New: `backend/scripts/lib/ac-model-override.mjs` (pure, self-tested) and
`backend/scripts/lib/ac-model-override-apply.mjs` (the read and the print,
split for the 2,000-line ceiling on the reconcile).
`owner-model-override` is declared in `lib/so-verdict-derive.mjs`'s
`NOTE_CLASSES` and labelled in `lib/so-tally-verdict.mjs`'s `DECLARED_LABEL`, so
the verdict enumerates what it excluded and under whose ruling.

**Proved RED on the unfixed tree.** With the book-model guard
(`if (declBook !== bookNow) return false;`) removed from `overrideCovers`,
`backend/tests/acModelOverride.test.mjs` failed 3 of 8 — the expiry case moved a
finding whose book model had changed. Restored: 8 passed.

**Ref.** `diag/so-po-counter-causes`, 2026-09-08.
