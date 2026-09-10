## A sofa listed from the other end was counted as a different build [high]

**Symptom.** `check-supplier-listing-vs-erp` reported **24 documents** as "same
pieces, DIFFERENT ORDER — direction" (production run 34453751607), and the
corrections proposer raised `HC-PO-009587` as a conflict needing the owner's
judgement:

```
the owner, 2026-09-08, re-reading his own slip:  1A(LHF)+1NA+L(RHF)
the supplier's listing:                          L(RHF)+1NA+1A(LHF)
```

That was put to him as two readings that disagree. His answer:

> 一样的东西啊 只是LHF 在第一个item而已

**He is right, and the whole bucket is suspect.** Reverse the supplier's list and
the hands do not move: `L(RHF)+1NA+1A(LHF)` reversed is `1A(LHF)+1NA+L(RHF)`,
which is his reading exactly. It is one sofa written from the other end.

**Root cause.** The comparison treated the piece SEQUENCE as significant on its
own:

```js
const sameSeq = theirs.join('+') === mine.join('+');
```

A compartment's hand is INTRINSIC — `1A(LHF)` is a left-hand-facing arm wherever
it is written — so listing a run from the other end produces a different string
for the same product. The check had no notion of that and reported every such
row as a direction problem.

**The distinction it was missing, and it is the whole point.**

| relation | what it is |
|---|---|
| identical | the same sofa |
| **plain REVERSAL, hands untouched** | **the same sofa, written from the other end** |
| reverse AND swap every hand (a MIRROR) | a DIFFERENT sofa — and it shows up as a MULTISET difference, where it belongs |
| a genuine re-ordering (`1NA+CNR` becomes `CNR+1NA`) | a DIFFERENT sofa — the run turns at another point |

So the mirror case was never in this bucket to begin with; what was in it is a
mixture of real re-orderings and sofas that simply agree.

**Fix.** `sameSofa(a, b)` — identical or exact reverse — replaces the string
comparison in both the check and the proposer, with the four relations above
asserted:

```
L(RHF)+1NA+1A(LHF)      vs 1A(LHF)+1NA+L(RHF)       -> same     (the owner's case)
1A(RHF)+1NA+1A(LHF)     vs 1A(LHF)+1NA+1A(RHF)      -> same     (reversal)
1A(LHF)+1NA+CNR+1A(RHF) vs 1A(LHF)+CNR+1NA+1A(RHF)  -> DIFFERENT (corner moved)
```

**What this cost, and it is not only a count.** The proposer had grown a special
case — "an owner-read drawing keeps its order against the supplier" — built to
resolve `HC-PO-009587`. That entire branch existed to arbitrate a conflict that
was never a conflict. It is kept only in the narrow form it is now honestly for:
not re-stating an already-answered document in the opposite direction.

**Lesson.** The number was reported to the owner as 24 documents needing a
direction decision. He found the error by reading ONE of them. A bucket built on
a comparison nobody had stated the semantics of will look like work, and the
cheapest check is to ask what two members of it actually mean — which is what he
did and I had not.

**Ref.** feat/apply-supplier-sofa-corrections, 2026-09-10.
