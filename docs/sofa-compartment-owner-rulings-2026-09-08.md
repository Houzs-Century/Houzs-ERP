# Sofa compartment rulings — the owner, 2026-09-08

**These are the owner's OWN words on his OWN drawings, given while reviewing the
one-page report of sofas whose book text does not settle the build.** They are
the authority. Nothing here was inferred from the text, and nothing here may be
"corrected" by a later parser run: when the book's words and the owner's drawing
disagree, `docs/staff-reported-flow-2026-09-08.md` records that **the drawing
wins**, per his ruling on `SO-013475` this morning.

Each row is a PER-DOCUMENT override. The decoder's rules are NOT changed by any
of them.

| document | model | what the book's words say | what the ERP held | **THE OWNER'S RULING** |
|---|---|---|---|---|
| `HC-SO-013327` | `DSL-8069` | `Size:24"/Col:BO315-7 Peach/Bottom wrap nylon/Seater depth +1"` — no build stated | `1A(LHF)` + `2A(RHF)` + `1NA` | **`1AL + 2AR + 1BR`** |
| `HC-SO-011099` | `HOK-5530` (aliases to 9028) | `2S / colour :BO315-4` | `1A(LHF)` + `1A(RHF)` | **`2S`** |
| `HC-SO-010209` | `9058` | words decode to `2A(LHF)` + `L(RHF)` | `1A(LHF)` + `1NA` + `1A(RHF)` | **`1AL + 1NA + 1L(R)`** |

## How to read his notation, and what to do when it is not obvious

He writes in the shorthand of the order slip, not in ERP piece codes. `1AL` is
the one-seat arm on the LEFT, `2AR` the two-seat arm on the RIGHT, `1L(R)` the
one-seat chaise L on the right. **`1BR` on `HC-SO-013327` is the one that is not
obvious** — it is not a piece code this repo already emits, and the ERP held
`1NA` in that position. **Resolve it against the drawing and the model's own
compartment catalogue before writing anything, and if it still does not resolve,
ASK HIM — do not map it to the nearest-looking code.** Writing the wrong piece is
the failure this whole page exists to prevent.

## Two of these are NOT new defects, and the distinction matters

`HC-SO-011099` and `HC-SO-010209` were both decided from the same drawings in
August, and `HC-SO-010209` **is already delivered**. So the ERP's value did not
drift — it was read off the slip once, and he is now reading the same slip again
and correcting it. Treat these as a corrected reading, not as a regression, and
say so wherever the change is recorded.

## Standing rules these sit under

- 「一律跟账本。除了sofa compartment而已啊」 — the book decides everything EXCEPT
  the sofa build, which is his.
- 「都要跟Autocount一样」 (2026-09-08) — every other axis matches the book.
- The drawing beats the book's words when they disagree (`SO-013475`, this
  morning) — and it is a per-document override, never a change to the rule.

**More rulings are expected: he is going through the report card by card.**
Append them here as they arrive, with his words quoted exactly.

## THIS PAGE IS THE WORDS. THE MACHINE READS THE DATA FILE — put the ruling in BOTH

Since 2026-09-08 (`fix/verdict-sees-rulings`, `docs/bugs/0717`) the AutoCount
reconcile CONSULTS the owner's rulings, so that a sofa he has settled is no
longer reported as a difference and no longer LOCKED by the per-document verdict.

**It reads `backend/scripts/data/sofa-compartment-corrections-2026-08.json` and
`-2026-09.json`, not this page.** That is deliberate and it is not a slight on
this page: those files are already what `apply-sofa-compartment-corrections.mjs`
WRITES the builds from, so the checker and the applier read one set of rows and
cannot come to different conclusions about what he ruled. This page is where his
WORDS are, and his words are the slip's shorthand (`1AL`, `2AR`, `1BR`) — not ERP
piece codes, and not something a parser should be trusted to translate.

**So a ruling that lands only here is a ruling the reconcile cannot see, and the
order it settles stays shut.** `backend/tests/sofaRulingIndex.test.mjs` fails if
any document ruled on in the table above carries no entry in the corrections
JSON. It deliberately does NOT compare the PIECES: the shorthand-to-piece-code
translation is a judgement about a drawing, which is exactly what the section
above says to bring to him rather than guess. The pieces are checked the only way
they can be — against the ERP itself, on every reconcile run.

**And the exemption is a CHECK, not a blank cheque.** The reconcile asserts the
ERP against his stated pieces. A ruled build that still matches him is reported
as `RULED`, naming his value and the file it lives in, and never locks. A ruled
build that has been edited to something else is reported LOUDER than an ordinary
difference, on its own axis (`sofa build differs from the owner ruling`), and
does lock — because his decision has been overwritten and he needs to know.
