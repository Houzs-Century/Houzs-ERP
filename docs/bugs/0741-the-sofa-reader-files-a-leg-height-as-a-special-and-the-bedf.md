## The sofa reader files a leg height as a special, and the bedframe reader cannot read the ERP's own "No Leg" [medium]

Two of the nineteen sales orders on the tally are the same shape: **the two
systems agree about the leg and only our reader cannot see it.** One is fixed
here; the other is measured and deliberately left, and the reason is the
difference between them.

Both sides come from read-only run
[34305393684](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34305393684)
(`scripts/probe-so-differ-provenance.mjs`, book cut `2026-09-09T00:18:49Z`).

### FIXED — `inches()` could not read a value the ERP itself treats as canonical

**Symptom.** `HC-SO-2609-005` differs on `leg height`, on a PROCEEDED order.

```
BOOK  dtl 927503  HOK-1005 (Q)
      "PC151-10 / DIVAN 10\" + NO LEG / GAP 10\" / T.Heights 20\""
ERP   dtl 927503  FENRIR-(Q)  group bedframe
      {"gap":"10\"", "divanHeight":"10\"", "legHeight":"No Leg",
       "totalHeight":"20\"", "colourId":"PC151-10"}
```

Every value on that line matches. Divan 10, gap 10, total 20, colour PC151-10.
The two systems say the same thing about the leg as well — the book says `NO
LEG` and the ERP says `No Leg`.

**Root cause (traced).** `parseBedframe` reads the book's `NO LEG` as `0`.
`inches()` in `scripts/lib/variant-reconcile.mjs` read the ERP's `No Leg` as
`null`, because it only ever looked for a leading digit. `verdictOf(0, null)` is
`ERP_BLANK` — *"the book states the axis and the ERP carries nothing"*, the one
verdict that IS a gap — so the axis reported a hole on a line that matched.

**"No Leg" is not a typo to tolerate; it is the ERP's own word.** It is a
first-class choice on the bedframe form and is stored as that literal string:
`src/scm/shared/variant-summary.ts:227` tests `/^NO\s*LEG$/` when it composes the
Desc2 (*"No Leg reads as-is without the redundant prefix (Loo, 2026-06-03)"*),
and `normalizeInchValue('No Leg')` returns it unchanged. Our own write-back is
what turned it into the `NO LEG` in the book.

**Why it had not been seen, which is the part worth keeping.** The MIGRATION
writer never produces the string: `bedframeVariants` writes `bf.leg + '"'`
(`scripts/lib/parse-bedframe.mjs:279`), so a migrated zero leg is stored as `0"`
and has always read fine. Only a line entered or EDITED through the ERP's own
form carries `No Leg` — which today is the orders the ERP itself raised, and
tomorrow is every order the staff touch. The defect was arriving, not historical.

**Fix.** `inches()` answers `0` for `no leg` / `no legs`, in any case and with
any spacing. **ABSENT IS STILL NOT ZERO** — `TBC`, `KIV`, `""` and `null` keep
answering `null`, because a component nobody has picked stays unknown
(`docs/bugs/0732`). This reads a DECISION that was made, not a silence.

**Proved RED first.** `backend/tests/variantInchesNoLeg.test.ts` ran
**`2 failed | 2 passed (4)`** against the reader as it stood, and the failure it
printed was the production verdict itself — `expected 'ERP_BLANK' to be
'AGREE'`. The two that passed are the control: the three height spellings the
reader already knew still answer the same, so the fix did not simply make
everything zero. After: **`4 passed (4)`**, and `9 passed (9) · 101 tests` across
`variant-reconcile.test.mjs`, the three bedframe suites, the two variant-axes
suites, `variantReport`, `variantGuessedPairing`, `soTallyVerdict` and
`soReconcileVerdict`.

**Direction of effect, stated because it touches every document type.** The
change can only turn `ERP_BLANK` into `AGREE` on a pair that already agreed — it
gives the reader a value where it previously had none. It cannot manufacture a
difference. Any other type's count it moves, it moves DOWN.

### MEASURED AND LEFT — the sofa reader has no leg axis, so a leg becomes a special

**Symptom.** `HC-SO-010284` differs on `specials`, on a PROCEEDED order.

```
BOOK  dtl 701052  DSL-9058 SOFA
      "1ER + 1NA + 1EL (35\") / COL: M2402-04 SAND / LEG 1\""
ERP   dtl 701052  9058-1A(LHF) / 9058-1A(RHF) / 9058-1NA   group sofa
      {"legHeight":"1\"", "seatHeight":"35", "colourId":"M2402-04",
       "colourLabel":"M2402-04 SAND", "specials":[]}
```

**The ERP holds the leg** — `legHeight: "1\""`, on all three compartment rows,
exactly what the book asks for. Its `specials` list is correctly empty.

**Root cause (traced).** `decodeBook`'s bedframe branch sets `out.leg`; its SOFA
branch does not. `parseSofa` has no leg axis, so `LEG 1"` falls through to
`specials`:

```
parseSofa('1ER + 1NA + 1EL (35") / COL: M2402-04 SAND / LEG 1"', 9058)
  -> {size: "35", pieces: ["1A(RHF)","1NA","1A(LHF)"], specials: ['LEG 1"']}
```

So the report says the book asks for a special the line does not tick, while the
ERP has recorded the leg on the axis that exists for it. The ERP is right.

**Why it is not fixed here.** The repair is symmetric with the bedframe branch —
lift a leg phrase out of `specials` into `out.leg` and let the same `inches()`
compare it. Measured over the committed cut, **54 Desc2 rows across all six
document types** file a leg phrase as a special, on 10 sales orders. Unlike the
`No Leg` fix above, this one moves a finding from one axis to ANOTHER, so it can
change a count in either direction, and this lane was scoped to sales orders
under an explicit constraint that no other document type's figures may move.

It belongs with `docs/bugs/0740` — the other `parse-sofa` reader defect found
the same day — in one PR that re-measures all six tallies.

**`HC-SO-010284` therefore stays in DIFFER, named, with the ERP recorded as the
correct side.**

**Ref.** fix/so-reader-leg-axis, 2026-09-09.
