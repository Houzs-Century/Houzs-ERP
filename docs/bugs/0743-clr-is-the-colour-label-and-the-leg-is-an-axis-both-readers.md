## `Clr` is the colour label and the leg is an axis — both readers fixed, all six document types re-measured [medium]

The two defects `docs/bugs/0740` and `docs/bugs/0741` recorded, measured and
deliberately left. Both are cases where **the ERP is right and our reader of the
account book was wrong**, so both fixes are in the READER and neither touches a
row of ERP data.

They were held because each moves figures on ALL SIX document types and the lane
that found them was scoped to sales orders. This entry is the lane that owns all
six.

---

### 1. `Clr:` is a colour label (owner, 2026-09-09: 「CLR 应该是colour」)

**Symptom.** `HC-SO-007293`'s whole build text is `2S+L Clr: B0315-21 Pearl`.
The ERP holds `9028-2A(LHF)` + `9028-L(RHF)` — a two-seater and a chaise, which
is what that says — and the report claimed the book asked for something else.

**Root cause.** `scripts/lib/parse-sofa.mjs` matched the label as
`col(?:our|or)?` in FOUR places. An unmatched label is not skipped: it stays in
the text and the structure pass glues it to the token in FRONT of it, so the
chaise `L` was eaten and re-emerged as an invented special `LCLR`.

**Fix.** One `COLOUR_LABEL` constant, used by all four regexes, so a fifth
spelling is added in one place rather than three-quarters of the time.

**Censused, not guessed.** Every alphabetic token sitting in front of a `:`,
`：` or `-` was counted across all 9,029 sofa Desc2 on all six document types —
the TOKEN, not the spellings we expected, because an earlier census "proved" a
piece type did not exist by searching for the wrong string. The book's entire
colour vocabulary is:

| spelling | rows | known before |
| --- | --- | --- |
| `COL` | 5,613 | yes |
| `COLOUR` | 705 | yes |
| `COLOR` | 153 | yes |
| `CLR` | 59 | **no** |

`CIL:` appears on ONE document (SO-003646, 2 rows) and is a typo of `COL`, not a
spelling the floor uses; it is deliberately left alone — one row is not a
vocabulary, and `unlabelledColour` already has a path to that code. The compound
tokens the census also printed — `L CLR`, `S CLR`, `ER COL`, `RR COL` — are not
other labels. They are THIS defect: the piece in front of the label showing up
glued to it.

### 2. The three regressions the naive fix caused, and what closed them

`0740` measured that teaching the four regexes `Clr` moves 113 rows and **three
get worse**. Reproduced here exactly, then fixed:

| document | what went wrong | what closed it |
| --- | --- | --- |
| `SO-013475` (×2) | colour became `HR805-30 -Wrap bottom to nylon` — an INSTRUCTION inside the shade name | a ` -` that opens an instruction ends the colour |
| `SO-006807` | seat size `44` -> `null`, the tail swallowed by the colour | a trailing seat size ends the colour |
| `SO-003951` | pieces `[]` (honest) -> `["2S"]` (wrong) | `docs/bugs/0742` — `1EL/T` is the chaise |

**The cut stays POSITIVE, and BOTH new arms had to be narrowed after
measurement**, which is the part worth keeping:

- **the dash arm fires only when a LETTER follows the dash immediately.** A
  shade CONTINUES after its own dash with a space or a digit — `ninja -
  02,03,07,09`, `ZL -20- Black`, `M2402 -18 LIGHT GREY`, `GD2502#22 - INK`,
  `Cove -03`. Testing the whole tail let an instruction further along it
  authorise a cut at the shade's own dash: five shades lost their number, and
  `M2402 -18 LIGHT GREY` also took its three correct pieces down to none.
- **the size arm refuses a size with a `+` still to come**, because that is a
  PER-PIECE size inside a build. Without it, `B0315-2 1EL (24") +CNR+2ER (30")`
  lost its `1EL`, and `…Total 170cm+-` moved the seat size from the book's own
  26" onto a 170cm total LENGTH.

`SIZE_TAIL` itself is untouched — its trailing `\b` cannot fire after a quote
mark, which is why `44" per seat` was never seen, but that regex is the
double-space arm's test and widening it there would move rows this change was
never asked about. The single-space arm has its own `SIZE_HEAD`.

### 3. The sofa leg is a real axis, and the reader had none

**Symptom.** `HC-SO-010284`, a PROCEEDED order: the book says `LEG 1"`, the ERP
holds `legHeight: "1\""` on all three compartment rows with `specials: []`, and
the report said the book asked for a special the line does not tick.

**Root cause.** `decodeBook`'s bedframe branch sets `out.leg`; its sofa branch
did not, and `AXES` listed `leg` as `groups: ["bedframe"]`. `parseSofa` had
nowhere to put a leg, so `LEG 1"` fell through to `specials`.

**It IS a sofa axis**, which is what makes this a defect and not a design
choice: `src/scm/shared/so-variant-rule.ts` gives the sofa group a Leg Height
picker (aliases `legHeight` / `sofaLegHeight`), and
`scripts/backfill-sofa-leg-default.mjs` fills it — skipping, on purpose, exactly
the lines whose own text names a leg so a human could pick those. Those skipped
lines are this population.

**Fix.** `parseSofa` answers `o.leg` where the book states a height, the axis
covers `["bedframe","sofa"]`, and it reads `sofaLegHeight` beside `legHeight`
because the POS configurator spells it the other way.

**THE THREE-PLACES CHECK, run rather than assumed** (`docs/bugs/0732` fixed the
divan rule in three files and named the third only after it bit). The sofa leg
was stated in three places and all three are now consistent:

1. `scripts/lib/parse-sofa.mjs` — filed the leg as a special. Fixed.
2. `scripts/lib/variant-reconcile.mjs` — no sofa leg axis. Fixed.
3. `scripts/lib/variant-merge.mjs` — `OWNED_SOFA_KEYS`, whose comment asserted
   *"a sofa has no divan, leg or gap"*. The leg third of that is FALSE and is
   what a reader would have believed. **The comment is corrected; the behaviour
   is not** — that module is the fabric-library sweep, a leg is not its
   business, and this lane writes nothing.

**WHAT IT WILL NOT TOUCH, and this is the guard:**

- `BACKCUSHION+LEG 8030` — 8030 is a MODEL number. The UNIT is the whole test: a
  number with no unit beside the word `leg` is not a height.
- `USE IRON LEG`, `LEG REFER PHOTOS`, `*LEG MUST USE 5527*` — no number, no
  answer. An instruction is not a measurement.
- the phrase itself, unless it is ONLY the height statement. `3"LEG (WITHOUT
  RECLINER)` answers the axis AND keeps the request. Dropping an instruction is
  the expensive direction — a sofa built wrong — and this rule cannot do it.
- **a bare `NO LEG`. MEASURED AND LEFT**: 46 rows in the committed cut over 13
  distinct texts (SO 13, PO 8, GR 7, DO 6, IV 5, PI 7), and almost every one
  sits inside a COVERING instruction (`fully cover to floor`, `extend wood to
  floor`) whose leg is a consequence rather than a pick. Reading it as 0
  would state a leg on lines the leg-default backfill deliberately left for a
  human. `inches()` already reads the ERP's own `No Leg` as 0 (`docs/bugs/0741`,
  first half), so the two halves would meet if a later lane decides to; it is
  not decided here.

**Measured: 64 rows, 17 distinct book texts, on all six types** — SO 15, PO 10,
GR 10, DO 10, IV 9, PI 10. 24 of those rows also lose a special that was only
ever the leg; the other 40 keep every instruction they carried.
`0741` predicted 54 on a narrower definition of the population; this rule also
answers the axis where the height sits INSIDE a longer instruction, which is why
it is more. Every one of the 17 texts is printed in the PR.

### What all four changes do to the corpus

Over all 9,029 sofa Desc2 in the committed cut
(`ac-reconcile-truth.json.gz`, `2026-09-09T00:18:49Z`), under BOTH extreme
colour oracles — recognise every code-shaped token, and recognise none — so a
row that moves identically under both is provably not an artefact of which
fabric rows happen to exist:

| what reached the row | rows | SO | PO | GR | DO | IV | PI | texts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| the `Clr:` label | 113 | 22 | 19 | 19 | 19 | 15 | 19 | 26 |
| `1EL/T` (`docs/bugs/0742`) | 42 | 8 | 6 | 6 | 8 | 8 | 6 | 10 |
| the leg axis | 64 | 15 | 10 | 10 | 10 | 9 | 10 | 17 |
| where a labelled colour ends | 68 | 12 | 11 | 11 | 12 | 11 | 11 | 14 |
| **total** | **287** | **57** | **46** | **46** | **49** | **43** | **46** | **67** |

The 113 is the same 113 `0740` measured, to the row and to the per-type split —
the harness was proved against that number before it was trusted for anything
else.

**Proved RED first.** `backend/tests/parseSofaClrAndLeg.test.ts` ran
**`13 failed | 4 passed (17)`** against the reader as it stands on the merge
base. Every expectation is the value the BOOK states, never "whatever the ERP
holds" — the shape that let the TBC-divan bug read 12" on both sides and pass —
and the failures printed the production defects themselves:
`expected [] to deeply equal [ '2A(LHF)', 'L(RHF)' ]` (the eaten chaise) and
`expected undefined to be 1` (the leg axis that did not exist). **The 4 that
PASSED are the control**: the shade-continues-after-its-dash case, the
per-piece-size case, `1ER/T`, and the bare-`CLR` case were already right and had
to stay right, so the suite cannot be passing by making everything move.

**Ref.** fix/sofa-clr-leg-reader, 2026-09-09. Fixes `docs/bugs/0740` and
`docs/bugs/0741`; found `docs/bugs/0742`.
