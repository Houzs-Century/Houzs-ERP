## The sofa reader knows three spellings of the colour label, and `Clr` eats the piece in front of it [medium]

**Symptom.** `HC-SO-007293` has sat on the sales-order tally's
`sofa compartments` axis for days. The book's build text is four words long:

```
2S+L Clr: B0315-21 Pearl
```

The ERP holds `9028-2A(LHF)` + `9028-L(RHF)` — a two-seater and a chaise, which
is what that says. The report claims the book asks for something else.

**Root cause (traced, and reproduced locally).** `scripts/lib/parse-sofa.mjs`
matches the colour label with `col(?:our|or)?` in four places — `COL:`,
`COLOUR:`, `COLOR:`. **`Clr:` is a fourth spelling the floor uses and the reader
has never known.** An unmatched label is not skipped; it stays in the text, and
the structure pass then glues it to the token in front of it. Run against the
committed cut with the live colour oracle:

```
parseSofa("2S+L Clr: B0315-21 Pearl", 9028)
  -> pieces: ["2S"], specials: ["LCLR"], conf: "medium"
```

The chaise `L` was eaten by the label and re-emerged as an invented special
`LCLR`. So the compartment axis compares a one-piece book build against our
correct two-piece one and reports a difference, and **the ERP is right while the
report is wrong.** (The phantom `LCLR` does not also show as a specials
difference only because `HC-SO-007293` is not proceeded, so its specials blank is
excused by 「还没proceed还没确认的就可以直接放空的」.)

**Not shipped, and the measurement is why.** Two fixes were written and both were
measured over **every sofa Desc2 in the committed cut — 9,029 rows across all six
document types** — by running `parseSofa` before and after under two colour
oracles (recognise every code-shaped token, and recognise none), so a row
identical under both is provably unaffected.

**Option A — teach the four `COL:` regexes to accept `Clr`.** Fixes
`HC-SO-007293`. Moves **113 rows**: SO 22, PO 19, DO 19, GR 19, PI 19, IV 15; the
piece list moves on 89 of them. Most are corrections — eighteen sales-order rows
gain a colour, gain a correct piece list, or shed a phantom `CLR` special. **Three
get worse**, and they get worse in the direction this file's own header calls the
expensive one:

| document | before | after |
| --- | --- | --- |
| `SO-013475` (×2 lines) | the whole Desc2 as one special | colour `HR805-30 -Wrap bottom to nylon` — an INSTRUCTION swallowed into the shade name |
| `SO-006807` | seat size `44` | seat size `null`, `44" per seat including handle` swallowed into the colour |
| `SO-003951` | no piece list (unreadable, honest) | pieces `["2S"]` from `1EL/T(35")+ 2ER(35")`, which is not what that says |

The cause is `splitColourValue`: a labelled colour runs to the end of its
segment and the cut is deliberately POSITIVE — it ends only where what follows
identifies itself as a build, a size or a known instruction — so a
single-space-separated tail rides into the shade name. Teaching the label to
match reaches three strings whose tails that rule cannot cut.

**Option B — remove the bare `Clr` label before the structure pass, without
promoting it to a colour reader.** Narrower and loses nothing: **43 rows** move
(SO 10), every one a correction, and the three regressions above do not occur.
**But it does not fix `HC-SO-007293`** — with the label gone the text reads
`2S+L  B0315-21 Pearl`, and the `L` is still swallowed, now by the shade code
instead of by the label. Measured, not assumed: `pieces: ["2S"]` after the change.

**So the fix that works is A, and A moves five other document types.** This lane
was scoped to sales orders under an explicit constraint that no other document
type's figures may move, and A moves PO, GR, DO, IV and PI by 19, 19, 19, 15 and
19 rows. Shipping it here would have been trading a known 1-document win for an
unmeasured effect on five other tallies the owner is also reading.

**What is owed, and it is small.** Option A plus a positive cut for the two tail
shapes it newly reaches — a ` -` that begins a known instruction, and a trailing
seat size — after which all three regressions go away and the change is
corrections only. That is a `parse-sofa.mjs` job with all six document tallies
re-measured in the same PR, not a sales-order job.

**`HC-SO-007293` therefore stays in DIFFER, named, with the ERP recorded as the
correct side.** It is NOT proceeded, so by the owner's own rule it is the least
urgent of the nineteen.

**Ref.** fix/so-differ-zero, 2026-09-09. Related: `docs/bugs/0722`.
