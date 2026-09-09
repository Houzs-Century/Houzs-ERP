## The undecided-height rule was fixed in one of the three files that carry it [medium]

**Symptom.** `docs/bugs/0732-an-undecided-divan-height-was-counted-as-zero-so-the-bed-got.md`
closed with a scope table naming its own incompleteness:

| file | what it feeds | fixed? |
| --- | --- | --- |
| `backend/scripts/lib/parse-bedframe.mjs` (`bedframeVariants`) | what the two importers and the two top-ups WRITE | **yes** |
| `backend/scripts/lib/variant-merge.mjs:120` | the AutoCount re-parse sweeps | no |
| `backend/scripts/lib/variant-reconcile.mjs:314` | the BOOK side of the reconcile's variant axis | no |

So a bedframe whose Desc2 reads `Divan: TBC / Gap: 12"` still came back from the
sweeps' patch builder and from the reconcile's book side with a total height of
`12"`. Nobody knows how tall that bed is: the divan under it has not been
picked.

**Root cause (traced).** Both remaining files carry the same expression:

```js
const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
```

`Number(undefined) || 0` is `0`, so a component the book wrote TBC/KIV was
summed as zero rather than making the sum unknown. `parseBedframe` has recorded
`divanPending` / `gapPending` / `legPending` since 0732 — set only by an
EXPLICIT marker against that keyword — and neither of these two readers looked
at them.

**Why no comparison could catch it, restated because it is the point.** The
reconcile derives the BOOK's expected total with the same expression the writer
uses. Both sides produce `12"` and the axis reports agreement. A test written as
"book side equals ERP side" passes on a broken reader and proves nothing.

**Fix.** Both files now read the same three flags `parse-bedframe.mjs` already
sets, and neither re-decides the rule.
`backend/tests/bedframePendingHeightAllReaders.test.ts` asserts the INTENDED
value, written out by hand from the owner's model, for all three components
(the book cut writes the divan TBC/KIV on 55 lines, the mattress gap on 38 and
the leg on 20) against BOTH readers.

**Proved RED first.** Run against the two unfixed modules:
`6 failed | 4 passed (10)`. The 4 that passed are the ABSENT controls — a divan
with no leg mentioned still means no leg (0), per the owner's model, and a fix
that blurred UNDECIDED into ABSENT would have turned them red. After the fix:
`30 passed (30)` across this file, `tests/bedframePendingHeight.test.ts` and
`tests/bedframeVariantsBlock.test.ts`.

**What it does to the verdict, and it is not a new difference.** `verdictOf`
returns `BOOK_BLANK` — not `DIFFER` — when the book states nothing and the ERP
holds a value. An affected line therefore moves from AGREE to BOOK_BLANK: "the
ERP carries a value the book never stated", which is what the book genuinely
does here. It locks nothing, it is already an accepted class, and it stops the
axis asserting agreement on a height nobody chose. This is option **2** of the
three 0732 put to the owner, which is the one 0732 itself recommended.

**Scope: a READER, and nothing else.** No stored row changes. Option 3 — nulling
the fabricated `variants.totalHeight` on the 45 rows that were given a height
out of nothing — is a write to live documents, is still the owner's to decide,
and is deliberately NOT done here.

**It does NOT close `HC-SO-009735`, and here is why, measured.** That order was
the reason this entry was picked up. Its book line reads
`Col:TBC/divan:8inch TBC/gap:12inch` (`SO-009735` DtlKey 661220, from the
committed cut `data/ac-reconcile-truth.json.gz`). Run locally,
`parseBedframe` returns `{divan: 8, gap: 12, leg: 0, divanPending: false}` — the
`TBC` sits after the VALUE, and the pending patterns deliberately allow only
separators between the keyword and the marker so that `DIVAN: 8" (LEG) KIV`
marks the LEG and not the divan. So nothing on that line is pending, the total
stays `20"`, and the order goes on differing from our `21"` on two axes:

- `leg height` — the book mentions no leg at all and `parseBedframe` answers
  `0` for silence; we hold `1"`;
- `T.Heights` — 8 + 12 + 0 = `20"` against our `21"`.

Closing it needs one of two things this lane may not do:

1. deciding that silence about a leg means "the book states nothing" rather than
   `0`. That reverses a rule written down as the owner's model in 0732 and
   pinned by `variant-reconcile.mjs`'s own `SELF_TEST`
   (`'Col: /Div:8"/M.GAP:14"'` -> `totalHeight: 22`). It is a judgement, not a
   provable defect, and CLAUDE.md says a judgement gets asked;
2. nulling the `1"` leg on the live row — option 3 above, the owner's open
   decision.

`HC-SO-009735` therefore stays in DIFFER, named, with what would move it.

**Ref.** fix/so-tally-zero, 2026-09-09.
