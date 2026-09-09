## The sofa ruling lookup prefers the OLDEST ruling, so a build the owner re-ruled keeps reporting as unreadable [high]

**Symptom.** `HC-SO-012929` reported as `CANNOT BE COMPARED — your drawing decides
these` on every run of `check-so-tally.mjs`, although the owner had ruled that
build on **2026-09-04 and again on 2026-09-05** and the ERP had been moved to his
answer. On 2026-09-08 he was handed a report of 45 such documents and said
**「45张那么多？你确定？我解析了那么多 你学不会？…为什么一直靠我？」**, and
earlier the same day **「这个很多我刚刚都给过你答案了啊」**. He was right: the
report was asking him for an answer he had already given twice.

**Root cause (traced).** `scripts/lib/sofa-rulings.mjs`, the candidate pick:

```js
const hit = cands.find((c) => c.desc2Match && desc2Contains(text, c.desc2Match));
```

`cands` is in `loadCorrections` load order — `2026-08`, `2026-09`,
`book-aligned`, `drawings` — and **both** dated files carry an entry for this
document whose needle matches the same book text:

| file | `desc2Match` | pieces |
| --- | --- | --- |
| `…-2026-08.json` | `Size:26”/Col:Modenza 02 Barley/Bottom wr` | `1S`, `1A(LHF)`, `2A(RHF)` |
| `…-2026-09.json` | `Size:26”/Col:Modenza 02 Barley` | `1A(LHF)`, `2A(RHF)` |

The September entry is his correction: its own `why` records that the August
reading carried a **surplus `1S`** and that he removed it. `.find()` returns the
first match, August loads first, so the reader asserted the superseded
three-piece build. The ERP holds the two-piece one. They never matched, so the
compartment cell stayed unreadable **by construction** — re-ruling the document a
third time could not have fixed it.

Not the first plausible story, and the one that was checked first was wrong: the
needles are written with a typographic `”` while the book writes a straight `"`,
which looks like the bug. It is not — `normaliseDesc2` folds smart quotes
(`sofa-desc2-match.mjs:67`), and both needles match. The defect is the precedence,
not the quoting.

**Fix.** The newest ruling is the ruling: take the **last** match, not the first
(`findLast`), files loading oldest first with his drawing last, because the
drawing is the final word on a build. Pinned by
`scripts/lib/sofa-rulings.test.mjs` — *"a LATER ruling supersedes an earlier one
on the same build"* — **proved RED on the unfixed tree** (`actual
['1S','1A(LHF)','2A(RHF)']`, expected `['1A(LHF)','2A(RHF)']`) and green after;
193/193 `scripts/lib` tests pass.

Blast radius **measured before changing anything**: exactly **one** document in
the live corrections data is ruled in more than one file, so this moves
`HC-SO-012929` and nothing else. Confirmed on production by dispatching the
read-only tally before and after and diffing the two lists by document:
`45 → 44` cannot-compare, `HC-SO-012929` left, **nothing entered**, `differ`
unchanged at 6, identical `2775 → 2776` (runs `34233946082` → `34236125304`).

**The general lesson.** When the owner corrects an earlier answer, the correction
must WIN. Code that prefers the older ruling silently turns his re-reading into
wasted work, and the only symptom is that he is asked the same question again.

**Ref.** `fix/sofa-read-45`, 2026-09-08.
