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

---

## What was WRITTEN, and what was not — `fix/apply-sofa-rulings`, 2026-09-08

Two of the three are in production. The third is parked with his answer intact.

| document | his ruling | ERP now holds | run |
| --- | --- | --- | --- |
| `HC-SO-013327` | `1AL + 2AR + 1BR` | **`1A(LHF)+2A(RHF)+1B(RHF)`** | apply `34221548817` |
| `HC-PO-010081` (its purchase order) | same build | **`1A(LHF)+2A(RHF)+1B(RHF)`** | carried in the same run; re-run `34221653216` confirms all three pieces `keep` |
| `HC-SO-010209` | `1AL + 1NA + 1L(R)` | **`1A(LHF)+1NA+L(RHF)`** | apply `34221462031` |
| `HC-SO-011099` | `2S` | `1A(LHF)+1A(RHF)` — **NOT written** | held, see below |

Each apply re-read its document on a fresh connection and asserted the piece
multiset and BOTH money columns; money did not move on any of them
(`460000/460000`, `388800/388800`, `0/0`).

### `1BR` resolved, and it did NOT need him again

The open question this page raised — *"`1BR` is the one that is not obvious ...
if it still does not resolve, ASK HIM"* — was answered without a second
interruption:

- **His own words settle the piece.** Asked what `1BR` meant he answered
  **`1B（RHF）`**.
- **`B` is the decoder's own vocabulary, not an invented code.**
  `scripts/lib/parse-sofa.mjs:609` emits `nB(LHF|RHF)` for the `B` token, and
  `8069-1B(LHF)` is already the lead piece of `HC-SO-013329` in the same
  corrections file.
- **`8069-1B(RHF)` EXISTS as a product.** Proven by the apply itself: the
  piece-SKU gate refuses a build whose target is not minted, and the run planned
  and wrote this one (`piece SKU not minted 0`).

### `1L(R)` is the chaise, written `L(RHF)` with NO count prefix

His slip shorthand carries a count (`1L`); the ERP's code for the chaise does
not. `parse-sofa.mjs:602` emits `L(LHF)`/`L(RHF)`, and `:545`/`:557` fold a `1L`
standing beside other pieces into ONE chaise. So `1L(R)` is `L(RHF)`, and a
minted `1L(RHF)` was never invented to match the spelling.

### `HC-SO-011099` is NOT written, and his ruling is not in doubt

The build collapses two rows into one, and the sales order's dropped row is the
dedication target of a line on `HC-PO-009882`, so the write is refused. Writing
only the purchase-order half WOULD have succeeded and is exactly why it must not
run: the factory's document would say `2S` while the customer's still said
`1A(LHF)+1A(RHF)`. The ruling now sits in the corrections file's `_held` list,
printed on every run so it cannot be mistaken for done. Full trace and what a fix
must do: `docs/bugs/0717`.

### The two in production, and what the factory holds

`HC-SO-013327` and `HC-SO-011099` are `IN_PRODUCTION`; `HC-SO-010209` is already
delivered. Inside the ERP the sales order and its purchase order now state the
SAME build for `HC-SO-013327` — they were corrected together and the chain audit
did not move. What the ERP cannot fix is the paper already at the factory: that
purchase order was raised before the ruling, so it states the old build. That is
a separate action for the owner and it is named in the PR rather than buried.

### These were corrected READINGS, not regressions

`HC-SO-010209` and `HC-SO-011099` were decided from the same drawings in August.
The ERP's value never drifted — he re-read his own slips and changed his answer.
Every `why` in the corrections files says so, so nobody logs a fault that never
happened.

### The report can no longer show him a question he has answered

`docs/bugs/0714` is fixed in the same PR: the reconcile now reads these
corrections files and reports a written ruling as **`RULED`**, its own column,
never folded into `AGREE`. A ruling that has NOT been written stays `DIFFER` and
names the answer it is failing to match.
