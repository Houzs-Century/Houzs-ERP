## A chaise on the side its position denies had no spelling [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Three sales orders cannot be written to AutoCount at all:

```
HC-SO-007399  cannot spell [2A(RHF), L(LHF)]
HC-SO-008460  cannot spell [L(RHF), 2A(LHF)]
HC-SO-007958  cannot spell [L(RHF), 1NA, 2A(LHF)]
```

**Root cause — two systems, two ways of saying which side a piece is on.**
AutoCount's Desc2 notation sides a chaise by its **position in the text**: the
first piece is the left one. The ERP records the side **explicitly**,
`L(LHF)` / `L(RHF)`. Where the two agree, `L` is written and everything works.
Where a build's chaise sits on the side its position denies, there is no string
that means it — writing `L + 2EL` decodes back as `L(LHF), 2A(RHF)`, the mirror
sofa. So `tokenFor` returned `null` and the caller refused, correctly: a wrong
build is worse than a refused one.

**Fix.** `LL` / `LR` — a chaise that says its own side, exactly as `1EL` / `1ER`
already do for an armed end. The decoder learned both tokens; `tokenFor` emits
them **only where the positional spelling would be wrong**, so every build that
composes today composes to the same text tomorrow.

**Why this could be done to a decoder the cutover importers depend on.**
`parse-sofa.mjs` is what both importers used to read the account book's own
15,950 Desc2 values. Changing it can silently re-read a document into meaning
something else. Two measurements made it safe, and neither is an argument:

1. **The book has never used `LL` or `LR`.** Across the committed snapshots —
   41,953 lines carrying a Desc2 — not one uses either as a token. A token
   nothing contains cannot change how anything reads.
2. **The corpus fingerprint is byte-identical.** All 15,950 SO values decoded
   before and after: `75e4b345d3cfad26…` both times. That guard shipped
   deliberately first, in `tests/sofaDecodeBaseline.test.ts`, precisely so this
   change could be judged rather than argued.

**Verified.**

* `sofaChaiseSaysItsSide.test.ts` — **4 tests**: the three builds now compose;
  the positional spelling is unchanged (`L + 2ER (28")`); all four round-trip
  through `decodesTo` on all ten models; and the shapes this does NOT reach are
  still refused.
* `src/services` + `src/scm` — **3,441 passed**, 245 files.
* `npm --prefix backend run typecheck` clean.

**WHAT IS STILL REFUSED, and why it is not the same change.** A solo armed end
decodes to a plain seat (`1EL (28")` → `1S`) and a solo corner decodes to a
three-piece build (`C (28")` → `2A(LHF), CNR, 1A(RHF)`) — measured on all twenty
model/mechanism combinations. Both would need the decoder to re-read text it
already reads, which the fingerprint forbids. Four documents stay refused:
`HC-SO-001255`, `HC-SO-001526`, `HC-SO-002315`, `HC-SO-004716`.

**UNTESTED against production** — the three documents have not been re-sent
under this build.

**Ref.** feat/a-chaise-can-say-which-side-it-is-on, 2026-09-09.
