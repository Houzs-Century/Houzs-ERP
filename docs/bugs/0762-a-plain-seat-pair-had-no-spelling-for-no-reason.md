## A plain-seat pair had no spelling for no reason [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Seventeen sofa builds cannot be written to AutoCount. Two of them
are refused for nothing but a plain-seat run:

```
HC-SO-003189  cannot spell [1S, 2S] in the AutoCount Desc2 grammar
HC-SO-001445  cannot spell [2S]
```

**Root cause.** `tokenFor` spelled `1S` and `2S` only when the build had exactly
ONE compartment — `solo ? '1S' : null`. Measured 2026-09-09 over the ten models
these refusals name and both mechanism settings, `1S (28")`, `2S (28")` and
`1S + 2S (28")` all decode back to exactly themselves, **20 of 20 each**. The
guard was turning away builds the decoder has always understood.

**Fix.** Drop the `solo` guard on `1S` and `2S`. Nothing else moved.

**WHAT DID NOT CHANGE, and the mistake that nearly changed it.** The same pass
first removed the `3S` refusal too, on a measurement that said `3S` decodes to
`['3S']`. It does — **without a size**. Real builds carry one, and `3S (28")`
decodes to the TWO-piece build `[2A(LHF), 1A(RHF)]`: wrong on all twenty
combinations, and anything containing it goes the same way
(`3S + 1S + 2S (28")` → `[2A(LHF), 1A(RHF), 1S, 2S]`). The file's own note said
so and was right; the draft measured a shape no document has.

`autocount-sofa-collapse.test.ts` caught it — *"refuses a solo 3S rather than
emitting text that decodes to two pieces"*, asserting `3S (28")` with the size
attached. **A test that encodes a measurement is worth more than the sentence
that reports it.**

**Why proposing a spelling is safe at all.** `composeSofaDesc2` hands every
composed string to `decodesTo`, and a build whose text does not decode back to
exactly itself is REFUSED rather than written. A wrong proposal costs a refusal;
a missing one costs a document. That is what makes `tokenFor` the right place to
be liberal and the wrong place to be clever.

**Verified.**

* `sofaPlainSeatSpelling.test.ts` — **5 tests**, all in the shape a real build
  has (with the size): the plain-seat pair is spelled; anything containing `3S`
  is still refused; every spelling round-trips through `decodesTo` on all ten
  models; a solo `CNR` is still refused; and the armed-end spellings — the
  measured corrections that took the inverse from 86.2% to 98.7% — are
  unchanged.
* `src/services` + `src/scm/shared` — **952 passed**, 62 files, including the
  existing 3S test.
* `npm --prefix backend run typecheck` clean.

**HOW MUCH THIS ACTUALLY UNBLOCKS: at most two documents of the seventeen**, and
UNMEASURED until they are re-sent. `HC-SO-001472` [3S, 1S, 2S] and
`HC-SO-001640` [3S] stay refused, correctly. The rest are refused for other
shapes — a solo `CNR`, a solo armed end, a chaise whose handedness contradicts
its position — and those need the decoder to learn a notation, not the writer to
stop guarding.

**Ref.** fix/a-plain-seat-build-has-a-spelling-after-all, 2026-09-09.
