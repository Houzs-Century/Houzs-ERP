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
must do: `docs/bugs/0719`.

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

`docs/bugs/0714-the-reconcile-reports-a-sofa-the-owner-has-already-ruled-on.md` is fixed in the same PR: the reconcile now reads these
corrections files and reports a written ruling as **`RULED`**, its own column,
never folded into `AGREE`. A ruling that has NOT been written stays `DIFFER` and
names the answer it is failing to match.

---

# HOW TO READ A SLIP DRAWING — the decision procedure, 2026-09-08

Written because he said **「你去学习我做的 然后用我的方法 和优化你的prompt啊」** after a
lane handed him back 45 documents. Every rule below is read off an answer HE gave,
and the document that proves it is named. **A lane that follows this page does not
need to ask him again for anything this page covers.**

## The procedure

1. **Count the boxes along each run. Each box is one piece.** (`010121`: three
   boxes → `1AL+1NA+1AR`, and he ignored the slip's own `1ER`/`2EL` sub-labels.)
2. **The two extreme ends of the whole sofa carry the ARMS** — `A(LHF)` left,
   `A(RHF)` right. A **hatched bar drawn inside the end of a box IS that arm**;
   it is a marking, not a piece of its own. (`010121`, `011158`, `011447`,
   `011454`, `012026`)
3. **Interior boxes are `NA`.** (`008683`, `012026`)
4. **The box at the ELBOW of an L is `CNR`.** 「第一个是corner 你也应该懂的」
   (`011601`, `011158`, `011447`, `011454`, `011455`, `012026`, and `011733`
   where he wrote the word `CNR` on the slip.)
5. **Two boxes inside ONE outline are ONE piece; boxes drawn separately are one
   piece each.** (`012947`: `[28][28]` sharing an outline → a single `2A(RHF)`.
   `010121`: three separate boxes → three pieces.)

## Which box is the chaise — the rule that costs the most when guessed

A deeper or taller box is **not** automatically a chaise. Three of his own
rulings separate the cases, and they must be applied in this order:

| what the slip draws | his ruling | proof |
|---|---|---|
| a box with an **arrow `→`** drawn off its outer edge | **chaise** `L(RHF)` | `012108` — box 3 is normal height and carries the arrow; he ruled `1AL+1NA+LR` |
| a block extending **perpendicular** past the run, forming an L footprint, with no arm bar | **chaise** | `012947` — the deep left block; he ruled `L(LHF)+2A(RHF)` |
| a box that is merely **deeper/taller** but carries an **arm bar** | **arm**, not a chaise | `011268` — the deeper right box; he ruled `1AR`. Also `012108` box 1, which is the TALLEST box on that slip and is still `1AL` |

So: **arrow or perpendicular footprint ⇒ chaise. Depth alone ⇒ arm.**
`012108` is the calibration case that proves depth alone is not enough, because
its tallest box and its chaise are two *different* boxes on one slip.

## Numbers written in the boxes

A number in a box may be a **seat depth** or a **width**. Seat depths in this
book run ~22–36"; anything much larger is a width.
`008683` writes `70"`/`53"` in the boxes and he ruled the seat **30"**.
`010121` writes `32` in every box and he ruled **32"** — **overriding the book's
own `31 inch`**, because the drawing wins on the build.

## What is NOT a reason to hand a document back

Every one of these was raised as a blocker and he answered anyway:

- no arm drawn anywhere → still put arms at the ends (`011158`)
- no hatching at all → decides nothing (`011455`)
- no seat size on the slip or in the book → still read the build (`011158`, `011447`, `012026`)
- the book's words disagree with the drawing → **the drawing wins on compartments** (`004709`: book `3S(35")`, he ruled `2S`)
- `arm rest take off` → a note about the arm REST, not about whether the piece is an arm piece (`011454`)
- `backrest change to <model>` → **not** a model change (`012108` stays 8030, `012947` stays 9058)
- `tbc side` written on the slip → the drawing still says which side (`012947`)
- a notation the decoder does not know (`2G1F`, `3S`, `B`, `R`) → a decoder gap, fix the decoder
- the slip's model differs from the book's item code → **SKU follows the book** (`011434`)
- no sofa drawn at all → it may not BE a sofa (`011657` is a **STOOL**)

## Before trusting any reader on a new batch: CALIBRATE IT

Feed it his own answered slips first and count how many it reproduces. Measured
2026-09-08 on this method, reading the R2 drawings at their native 240px:
**7 of 7 reproduced** — `008683`, `010121`, `011158`, `011268`, `012026`,
`012947`, and `012929` (whose owner-approved answer was reproduced from the
drawing alone, without reading the corrections file first).

## Desc2 is a source, but it is NOT the source for THIS population

He asked 「然后description 2没有？」 and 「autocount没图片的或者那些你可以看
description2」. Both are right in general — and **measured on the 45, Desc2 closes
none of them**, because those 45 were selected by the decoder failing on their
Desc2 in the first place. Of his own 15 answered sofa documents, **13 have no
build text in Desc2 at all** — "tbc", "colour tbc", "bottom wrap to Nilon". He
read them from the drawing. So:

- **photo present → the drawing is the source**, Desc2 cross-checks it;
- **no photo AND no build text in Desc2 → genuinely nobody's to read but his.**

Also measured, so nobody re-runs the census: **`parse-sofa.mjs` already emits
`B`, `R`, `CNR`, `STOOL`, `Console`, `L` and the `E`-side tokens.**
`1B+1B` → `1B(LHF)+1B(RHF)` at high confidence; `1R+2R+3R`, `1B+C+2R`, `2G1F`,
`L+2A` and `2S+CONSOLE` all decode. A claim that the decoder "emits only
`A`/`NA`/`L`/`CNR`" is false — check it with a two-line script before acting on it.

## The drawings live in R2 and a lane can fetch them without asking anyone

Key shape: `so-items/<ERP doc no>/<ERP row id>/ac-<AutoCount DtlKey>-<n>.jpg`.
**The DtlKey in the filename ties the picture to the exact book line.** List them
with the Cloudflare API (token: `C:\Users\User\Desktop\.r2-token.txt`, by FILE
PATH only, account `816e457307d7fa0491c2a08a72ad5dcd`, bucket `houzs-erp`):

    GET https://api.cloudflare.com/client/v4/accounts/<acct>/r2/buckets/houzs-erp/objects?prefix=so-items/<doc>/

240px **is the original** — the exporter does not downscale, so "the image is
small" is the medium, not a finding. They are legible: upscale 4x with LANCZOS,
autocontrast, then unsharp-mask, and crop to one run at a time.

---

# THE 45, MEASURED — what they actually are (run `34233946082`, 2026-09-08)

`check-so-tally.mjs` on `main`: **2,882 sales orders, 6 differ, 45 cannot be
compared.** The 45 is not one backlog. Measured, not estimated:

| what it is | docs |
|---|---|
| he ALREADY answered it tonight — being written by `fix/apply-sofa-rulings` | **15** |
| already carries a written ruling in `sofa-compartment-corrections-*.json` | **5** |
| no ruling, but the slip drawing is in R2 and readable | **5** |
| no drawing AND no build text in the book — only his slip can answer | **20** |

**Only 8 of the 45 are `[PROCEEDED]`** — orders the factory has actually started:
`011733 012025 012108 012929 013384 013495 013497 013503`. The other 37 are not
yet started, and his standing rule 「那些未开工的 你看能对齐就对齐把 对不齐的就算了」
plus 「blank is OK until an order is proceeded」 means a blank build on those is
not a gap. **The real backlog is the 8, and 7 of them are answerable now.**

The mechanical arm is **zero**: the report says `0 of these can be made
comparable WITHOUT you (stamp the line key)`. Every one is a build question.

## `HC-SO-012929` — he answered it twice and the code threw the answer away

He ruled this build on **2026-09-04 and again on 2026-09-05**, removing a surplus
`1S` to leave `1A(LHF)+2A(RHF)`. The ERP was moved to his answer. It still
reported as "CANNOT BE COMPARED" on every run.

`lib/sofa-rulings.mjs` took the **first** matching entry, and both the August and
the September file carry a needle that matches this line's Desc2. August loads
first. So the reader asserted August's superseded three-piece build, it did not
match the ERP, and the cell stayed unreadable — **for ever, by construction.**

Fixed: **the newest ruling is the ruling** (last match wins, oldest file first,
his drawing last). Proven RED before the fix and green after
(`scripts/lib/sofa-rulings.test.mjs`). Measured blast radius: **exactly one
document is ruled in more than one file**, so nothing else moves.

The general lesson, and it is the one that made him repeat himself: **when he
corrects an earlier answer, the correction must WIN. Code that prefers the older
ruling turns his re-reading into wasted work.**

## Readings taken from the drawings — labelled, with the evidence

Each is a per-document override, money-neutral (price rides the FIRST piece).
**Confident** = the motif is one he has already ruled on; **likely** = read by the
method but carrying a named ambiguity he can overrule in one line.

| document | proceeded | reading | seat | confidence | evidence |
|---|---|---|---|---|---|
| `HC-SO-013502` | no | `1A(LHF)+1NA+1A(RHF)` | — | **confident** | one outline split into three compartments, hatch bar inside each outer end — the `010121` motif exactly |
| `HC-SO-013503` | **yes** | `1A(LHF)+1NA+1A(RHF)` | 35" | **confident** | three boxes, hatch bar at both outer ends. Box 1 is the tallest but carries an arm bar and there is no arrow — `012108`, same model and seat, has that same tall box and he ruled it `1AL` |
| `HC-SO-013501` | no | `1A(LHF)+1NA+L(RHF)` | 28" | likely | box 3 extends perpendicular past the run — the `012947` chaise footprint. Ambiguity: it carries no arrow, and `012108` shows a deep box that is still an arm |
| `HC-SO-013497` | **yes** | `1A(LHF)+1NA+CNR+1A(RHF)` | 30" | likely | run of two boxes (hatch at the left end) into a stepped corner, plus a detached box hatched on its far edge as the other extreme end. Ambiguity: the slip draws TWO objects against ONE book line, so the detached box could be a separate stool |

## Returned, and why — one line each, none of them on the banned list

- `HC-SO-013499` **[proceeded: no]** — the attachment is a phone photo of a finished sofa, not a slip drawing; no build is stated anywhere.
- `HC-SO-013495` **[proceeded: yes]** — no drawing in R2 and the book says only `8030 back rest / Nilon bottom / Col : tbc`. **This is the one started order nothing can answer but him.**
- `HC-SO-011994` — the book DOES state a build (`C TABLE+1+C+2(28'INCH)`) and it decodes on its own; the segment guard trips on the trailing note `C TABLE NOT CUP HOLDER`. Loosening that guard risks writing half-parsed builds, which is the incident it exists to prevent (`HC-SO-000814`), and this order is not proceeded — so it is left, deliberately, as a named decoder gap rather than a silent widening.
- `HC-SO-012008` — `DSL-8050 SOFA` at RM600 whose whole Desc2 is `ARMREST`: a part, not a build. Same class as `011657` being a STOOL; needs his one-word confirmation that it is an accessory line.
- The remaining **16** — no drawing in R2, and the book states only colour/size/care notes (`tbc`, `KIV`, `wrap bottom to Nilon`). None is proceeded. There is no source for the build but his slip.

