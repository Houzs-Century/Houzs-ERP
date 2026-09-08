## An undecided divan height was counted as zero, so the bed got a total height nobody had chosen [medium]

**Symptom.** A bedframe line whose build text reads `Divan: TBC / Gap: 12"` comes
back from `bedframeVariants` with `divanHeight: null` — correct, the divan has
not been picked — and `totalHeight: '12"'`, which states the bed is twelve
inches tall. Nobody knows how tall it is. The salesperson has not chosen the
divan yet, and the ERP is quoting a height for it anyway.

**Root cause (traced).** `scripts/lib/parse-bedframe.mjs`, in the shared
variants block:

```js
const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
```

`Number(undefined) || 0` is `0`, so an undecided component was summed as zero
rather than making the sum unknown. The parser had no way to say otherwise: none
of the divan patterns match `TBC`, so `o.divan` stayed unset and an **absent**
divan and an **undecided** one were the same value.

The same function's COLOUR arm one line above already honoured the owner's rule
that TBC/KIV means not-chosen-yet (`isPendingColour`,
`scripts/lib/fabric-colour-match.mjs`; the module header states the rule
outright — *"TBC/KIV means the colour is not chosen yet"*). One function, two
answers to the same question about the same line of text.

**Why no check caught it, and why that matters more than the bug.** The
AutoCount-vs-ERP reconcile derives the book's expected value with **this same
expression**. Both sides call `bedframeVariants`, both produce `'12"'`, and the
variant axis reports agreement. A comparison cannot see a defect that lives in
the reader both of its sides share — so a test written as "book side equals ERP
side" would have passed on a broken reader and proved nothing.

**Measured on the committed book cut** (`ac-reconcile-truth.json.gz`, 83,610
Desc2 lines): the divan is written TBC/KIV on **55** lines, and **45** of those
were given a total height. The mattress gap is written that way on **38** lines
and the leg on **20** — so the defect is about an undecided COMPONENT, not about
the divan, and the fix reads all three.

**Fix.** `parseBedframe` now records `divanPending` / `gapPending` / `legPending`
as their own facts, set only by an EXPLICIT TBC/KIV against that keyword, and
`bedframeVariants` returns `totalHeight: null` when any of them is set. Both
orders are read, because staff write the marker before the word as often as
after it (`TBC"legs`, `(legs KIV)`), and no word boundary is required after the
keyword because `LegTBC` is a single token to a regex engine — requiring one
missed the book's own `Divan:8"+TBC"legs`.

A component that is merely **absent** is untouched: `Gap: 12"` on a line that
never mentions a divan still totals `12"`, and a divan with no leg mentioned
still means no leg (0), per the owner's model.

**Proved RED first.** `tests/bedframePendingHeight.test.ts` asserts the INTENDED
value — written out by hand from the owner's model, never against the other side
of a comparison — and was run against the unfixed module: **5 failed | 3 passed
(8)**. The 3 that passed are the controls that pin what must not change. After
the fix: **8 passed (8)**.

`tests/bedframeVariantsBlock.test.ts` pins the shared block against the
expression the three importers each carried. Its `LITERAL_BLOCK` now carries one
DELIBERATE divergence on `totalHeight`, recorded in that file's header, because
the transcribed original is the thing that was wrong. Its own fixture
`Clr:TBC/Divan:8"+TBC"legs/Gap:14"` moved from `'22"'` to `null`, which is the
whole point.

**Scope.** This changes a READER. It rewrites no stored row, moves no stock and
no money — the owner's 「库存先不看」 is not engaged. Documents already imported
keep whatever they were given; this is what the parser answers from now on, and
what every diagnostic that recomputes a variant block will now see.

**Ref.** fix/bedframe-pending-height, 2026-09-09.
