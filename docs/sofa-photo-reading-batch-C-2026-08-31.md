# Sofa compartment readings from the book's own sketches — batch C, 2026-08-31

These are **PROPOSALS for a human to tick**, read off the hand-drawn sketches stored in the book's own
`SODTL.FurtherDescription`. **Nothing was written to any document, order, product or table** — this file is the entire
output, and every row still needs an owner/salesperson sign-off before it is applied anywhere.

---

## What this covers — the 35 lines nobody had read

`HC-SO-011453` … `HC-SO-013329`: **35 sales orders, 40 photo-carrying lines**.

> **Batch B did not read what its own header says it read.** Batch B covers `HC-SO-002861` … `HC-SO-011450` — the
> *same 48 orders as batch A*, re-read a second time. Batch A's own warning ("if the batch-B agent split on the
> doc-number guess instead, `HC-SO-011453` … `HC-SO-012752` is the gap") understated it: the real gap was everything
> from `HC-SO-011453` on. **This file closes that gap.** Nothing here overlaps batch A or B.

Source of truth for each line, all read read-only:

| What | Where |
|---|---|
| sketch JPEG | `backend/scripts/data/line-photos/so/<BookDocNo>__<DtlKey>_<n>.jpg` |
| ERP item code | `backend/scripts/data/ac-photo-manifest.json.gz` |
| line text | `SODTL.Desc2`, read live from `AED_HOUZS` (`SELECT` only, 2026-08-31) |

**All 40 sketches were read live from AutoCount, not from the 2026-08-11 `ac-line-desc2.json.gz` cache** — 9 of these
lines postdate that cache and are absent from it (`HC-SO-013226` onward plus `SO-012635`'s charge line).

## How to read the table

- **Compartments are suffixes only.** The model prefix comes from the ERP item code, never from this document — row 1
  means `DSL-9058-1A(LHF) + DSL-9058-1NA + DSL-9058-1A(RHF)`.
- **"not shown"** means the sketch genuinely does not contain it. Nothing here is inferred from what a sofa
  "usually" is.
- `P` = power, `R` = recliner, `CNR` = corner, `L` = chaise, `Console` = console table. A bare `1S` is a **standalone
  whole sofa**, not a run.
- Where Desc2 and the sketch disagree, the row carries a ⚠ and the conflict is listed again in
  [Photo vs Desc2](#photo-contradicts-desc2).

## Four caveats that apply to the whole table

1. **Resolution ceiling.** The book stores each sketch at **240 px** on its long side. Everything below is a 5–16x
   LANCZOS upscale with autocontrast — there is **no sharper original**. Where a piece count or a digit is called
   uncertain, that is the ceiling talking, not a missing step.
2. **Handedness is NOT yet ruled by the owner, and the book is inconsistent with itself.** Side tags below are stated
   in **drawn order, left-most piece first**. `HC-SO-012947` settles the question for that line by writing
   **"tbc side"** on the page — the salesperson did not know either. **L/R naming awaits the owner's convention;**
   if he reads a perpendicular leg the other way, `LHF`/`RHF` flip as a pair on every L-shape row. Piece *counts* and
   *types* are unaffected either way.
3. **These 40 sketches are all distinct.** Every one of the 40 files has a unique `sha256`, and none is shared with
   any other document in the manifest. Unlike batch A, **no row here is a duplicate photo** — each line carries its
   own drawing.
4. **Five of the 40 lines are not sofas.** They are listed in [Not a sofa](#not-a-sofa-lines) and carry no
   compartment proposal.

## Counts

| Confidence | Sofa lines |
|---|---|
| high | **19** |
| medium | **15** |
| low | **1** |
| **total sofa lines** | **35** |
| not a sofa (no proposal) | 5 |
| **total lines read** | **40** |

---

## Readings — high confidence

| SO | ERP item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| HC-SO-011453 | DSL-9058 SOFA | header `9058 / 9028`; three boxes "30", hatched arm block at each end, `→12` beside the right arm | `1A(LHF) + 1NA + 1A(RHF)` | 30" | HR805-10 / 20 | high | ⚠ Desc2 says `colour : tbc`; the **sketch names the colours** (two-tone, the "10" written over a struck-out digit). `→12` = 12" arm; 3×30+2×12 = 114" = 9.5 ft. |
| HC-SO-011455 | AMN-SF9050 SOFA | header `9050 Corner (30")`; page writes it as an equation: curved corner wedge "30" **+** a 2-seat box "30"/"30" with `→ adjustable arm rest` at its right **+** a 1-seat "30" drawn below as the perpendicular leg; `10 feet` | `CNR + 2A + 1A` | 30" | HR805-30 | high | Desc2 colour `HR805-30` matches. Listed in the page's own equation order; arms sit at the two outer ends (2-seat's right, leg's far end). |
| HC-SO-011530 | DSL-8051 SOFA | two boxes `32" Power`, narrow arm panel at each outer end, both marked "slide out"; TV between | `1A(P)(LHF) + 1A(P)(RHF)` | 32" | BO315-5 (FOSSIL) | high | **Desc2 already states the build**: `BO315-5 (FOSSIL)/32"/1R(P)+1R(P)` — text and drawing agree. Also on the page: umbrella-fabric bottom, seat firm, 1" legs. |
| HC-SO-011604 | DSL-8051 SOFA | header `8051`, `colour tbc`; two boxes "32", hatched arm at each end; TV below | `1A(LHF) + 1A(RHF)` | 32" | not shown (tbc) | high | Desc2 carries no build; the sketch is the only source. |
| HC-SO-012012 | DSL-8030 SOFA | one box `35"` with a narrow arm panel at **both** ends; TV below; "umbrella fabric cover" | `1S` | 35" | not shown (TBC) | high | **Desc2 already states it**: `TBC/35"/1S` — matches. |
| HC-SO-012108 | DSL-8030 SOFA | arm panel, then three boxes "35", then arm; `10.75 feet` spans the run; `→12` | `1A(LHF) + 1NA + 1A(RHF)` | 35" | not shown | high | Arithmetic confirms the piece count: 3×35 + 2×12 = 129" = 10.75 ft exactly. Page notes: backrest → 9058, bottom fully cover, sit area +1", nilon bottom. |
| HC-SO-012172 | DSL-9058 SOFA | header `9058 Corner`, qty 1; equation: 2-seat block with a narrow arm panel at its **left** **+** a **triangle with a diagonal** (the corner) **+** a square drawn below with a small tab on its far edge | `2A(LHF) + CNR + 1A(RHF)` | 30" (TBC) | not shown (TBC) | high | Desc2 `Size:30"(TBC)/Col:TBC/Bottom wrap nylon` agrees on size and colour. The triangle is the clearest corner glyph in this batch. Item 2 on the page: 4 random square pillows. |
| HC-SO-012276 | DSL-9058 SOFA | header `9058`, `col: tbc`; hatched arm, three boxes, hatched arm; `tbc` written beside the run | `1A(LHF) + 1NA + 1A(RHF)` | not shown (page writes "tbc") | not shown (tbc) | high | Piece count unambiguous at 16x. Item 2: pillow. |
| HC-SO-012633 | DSL-8030 SOFA | header `8030`; `[arm｜35] + [35｜arm]`; `Long →` ~7 ft, `Deep: 4` ft depth arrow | `1A(LHF) + 1A(RHF)` | 35" | not shown (tbc) | high | Desc2 carries the finish notes only (`replace the leg by fully cover`), no build. |
| HC-SO-012695 | DSL-8038 SOFA | header `8038 (1P+1C+1P)`; three labelled boxes: `Power Recliner` **+** `Console Table` **+** `Power Recliner`, arm tick at each outer end | `1A(P)(LHF) + Console + 1A(P)(RHF)` | 32" | ZL-11 orange | high | **Desc2 already states the build**: `(1P+1Console+1P)32inch/Col:ZL-11` + `2Power Incliner`. Text and drawing agree exactly. |
| HC-SO-013107 | DSL-8030 SOFA | header `8030`, `Col: HR805-20`; `[arm｜30] + [30｜arm]` | `1A(LHF) + 1A(RHF)` | 30" | HR805-20 | high | Colour matches Desc2. "wrap bottom to nilon, fully cover". |
| HC-SO-013110 | DSL-8030 SOFA | `Col: BO315-1 Pearl`; `[arm｜32] + [32] + [32｜arm]`, `→12` | `1A(LHF) + 1NA + 1A(RHF)` | 32" | BO315-1 Pearl | high | Desc2 `32 inch per seat` corroborates the digit. Items 2–3: square pillow, long pillow. |
| HC-SO-013121 | DSL-8051 SOFA | two boxes each `32"` with a `P` above, narrow arm panel at each outer end; TV below | `1A(P)(LHF) + 1A(P)(RHF)` | 32" | B0315-Pearl | high | **Desc2 already states the build**: `2S[P+P](32")B0315-Pearl` — matches. |
| HC-SO-013226 ①| DSL-8030 SOFA | equation on graph paper: curved wedge **+** large square **+** narrow box containing "C" **+** box with a tab; a further box with a tab drawn below; TV with facing arrow | `1A(LHF) + CNR + Console + 1NA + 1A(RHF)` | 28" | ZL-12 | high | **Desc2 already states the build**: `(1EL+1C+1Console+1NA+1ER)28inch/Col:ZL-12`. Five text pieces, five drawn elements — they agree. `EL`/`ER` are the book's end-left / end-right; rendered above in the owner's grammar. |
| HC-SO-013226 ②| DSL-8050 SOFA | `Power Recliner` heading; two boxes each marked `P`, arm shape at each outer end | `1A(P)(LHF) + 1A(P)(RHF)` | 32" | ZL-12 | high | **Desc2 already states the build**: `(1P+1P)32inch/Col:ZL-12`. This SO carries **two different sofas on two already-separate lines** — no split needed. |
| HC-SO-013286 | HOK-5540 SOFA | single box `35"` with a narrow arm panel at both ends; TV below; "*Bottom cover with umbrella fabric" | `1S` | 35" | BO315-21 pearl | high | **Desc2 already states it**: `BO315-21 pearl/35"/1S`. ⚠ **Line qty = 2** — two identical whole 1-seaters on one line; see [Two sofas on one line](#lines-that-are-really-two-sofas). |
| HC-SO-013321 | DSL-8030 SOFA | header `8030`, `col: tbc`; one outline hatched at **both** ends with a single divider in the middle → two seats | `1A(LHF) + 1A(RHF)` | not shown | not shown (tbc) | high | Desc2 `Col : tbc / book bottom` — no build, no size. |
| HC-SO-013322 | DSL-8030 SOFA | header `8030`; `[arm｜35] [35] [35｜arm]`; beside it the salesperson's own **seat→length table**: 35=10.75 ft, 32=10 ft, 30=9.5 ft, 28=9 ft, 26=8.5 ft, 24=8 ft | `1A(LHF) + 1NA + 1A(RHF)` | 35" | Protex | high | ⚠ Desc2 says `Col : tbc`; the **sketch names `col: Protex`**. The page's own table (35 = 10.75 ft) independently confirms 3 seats + 2 arms. |
| HC-SO-013327 | DSL-8069 SOFA | `[arm｜24"] + [24"｜24"]` with a narrow arm panel at the far right; separate depth diagram `48" + 1" = 49"` | `1A(LHF) + 2A(RHF)` | 24" | BO315-7 Peach | high | **Desc2 already states it**: `Size:24"/Col:BO315-7 Peach/Bottom wrap nylon/Seater depth +1"` — matches exactly, including the +1" foam. Two pieces, but arms sit only at the two outer ends → **one run**, not a 1+2 suite. |

## Readings — medium confidence

| SO | ERP item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| HC-SO-011601 | AMN-SF9050 SOFA | header `9050`; a box "32" **hatched along its top edge** (`→arm rest`) sitting above a large **unnumbered tapered shape**, then `[32]` and `[32｜hatch]` (`→arm rest`); `10 feet` spans the whole run | `1A(LHF) + L + 1NA + 1A(RHF)` | 32" | not shown (tbc) | medium | The taper carries **no seat number**, so it is a chaise or a corner — the 240 px ceiling cannot separate the two. Piece count and the two arm positions are firm. |
| HC-SO-012026 | DSL-9058 SOFA | a separate box hatched along its **top** edge (the perpendicular leg), then the run: unnumbered taper, three boxes, hatched arm at the right end | `1A(LHF) + L/CNR + 1NA + 1NA + 1A(RHF)` | not shown | not shown | medium | ⚠ Desc2 `arm rest replace to sit area` — the drawing shows two arms; see [Photo vs Desc2](#photo-contradicts-desc2). Page notes: backrest → 8030, bottom → nilon, no hole on sitting area. |
| HC-SO-012031 | DSL-9058 SOFA | **drawn sideways on the page**; `[hatch｜30]`, `[30]`, an unnumbered taper, then `[30｜hatch]` below it; `Sliding Door` with a dimension line | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30" | not shown | medium | Read after a −90° rotation. Same design family as `HC-SO-012109` (same model, same 30", same sliding-door plan). |
| HC-SO-012106 | DSL-9058 SOFA | header `9058 corner`, qty 1; box hatched along its **top** edge (leg) above the run: taper, three boxes, hatched arm at the right end | `1A(LHF) + L/CNR + 1NA + 1NA + 1A(RHF)` | not shown | not shown | medium | Header word "corner" confirms a corner piece exists but not which element it is. `handrest change to seat cushion (depend at cus)` — an open customer choice. Item 2: 5 pillows. |
| HC-SO-012109 | DSL-9058 SOFA | **drawn sideways**; `[hatch｜30]`, `[30]`, taper, then `[30｜hatch]` below; `Sliding Door` | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30" | not shown | medium | Read after a −90° rotation. Twin of `HC-SO-012031`. |
| HC-SO-012360 | DSL-8051 SOFA | header `8051`, `col: tbc`; `[hatch｜↔]`, `[ ]`, `[ ｜hatch]`; `(size tbc)` and the word `double.` written at the right end; `1 inch leg` | `1A(LHF) + 1NA + 1A(RHF)` | not shown (page writes "size tbc") | not shown (tbc) | medium | The word **`double.`** beside the right arm is unexplained by anything else on the page and is not in Desc2 (`tbc`). Needs the salesperson. |
| HC-SO-012635 | DSL-8030 SOFA | header `8030`, `colour: tbc`; `[hatch｜32] [32] [32｜hatch]`; an arrow points **at the right-hand arm** → `arm rest change to seat area`; `balcony` marked at the left | `1A(LHF) + 1NA + 1A(RHF)` | 32" | not shown (tbc) | medium | ⚠ The arrow converts the drawn right armrest into seat area — that may make the right piece `1NA` (or add a seat). **Judgement call, not decided here.** Also: fully cover replaces the leg. |
| HC-SO-012752 | AMN-SF9058 SOFA | header `9058`; `[hatch｜box]`, a **narrow box** the page arrows as `conso table with cup holder (8030)`, then further boxes, then an unnumbered taper rising to a box hatched along its **top** edge | `1A(LHF) + Console + 1NA + 1NA + CNR + 1A(RHF)` | not shown | not shown | medium | The console is certain (labelled). **The middle seat count is 2 or 3 — not resolvable at 240 px.** Desc2 carries no build (`Nilon bottom / backrest 8030 ( maybe )`). |
| HC-SO-012829 | DSL-9028 SOFA | header `9028`, `col: tbc`; the left box "30" is drawn **deeper than the rest** (its outline runs downward) and is hatched at its left; then `[30]`, `[30｜hatch]` | `L(LHF) + 1NA + 1A(RHF)` | 30" | not shown (tbc) | medium | Chaise-vs-plain-seat for the deep left piece is the only doubt; the extra depth is what a chaise looks like in these plans. Page: backrest 8030, 8030 leg, nilon fabric, no holes on sit area. |
| HC-SO-012947 | AMN-SF9058 SOFA | header `9058 sofa backrest change 9028`, `col: tbc`; a **deeper** piece at the left with an arm panel at its far edge, then a row `28｜28｜28` with an arm tab at the right end; `→ tbc side` | `L(LHF) + 1NA + 1A(RHF)` | 28" | not shown (tbc) | medium | ⚠ **The book itself writes "tbc side"** — the salesperson did not fix the handedness either. This line is the clearest evidence that the L/R convention has to come from the owner, not from the drawings. |
| HC-SO-013108 | DSL-9058 SOFA | header `9058`; four boxes — the first with a small solid block at its **left**, two plain, the fourth drawn with a **quarter-circle arc** (the corner) — and a fifth box below it with a solid block at its **bottom** | `1A(LHF) + 1NA + 1NA + CNR + 1A(RHF)` | not shown | not shown (tbc) | medium | Arms are drawn as small solid blocks here rather than hatching — same meaning, different pen. No sizes anywhere on the page or in Desc2. |
| HC-SO-013250 | DSL-8030 SOFA | header `8030`, `feet 11` spanning the run; `[hatch｜box]`, `[box]`, a **narrow box** arrowed `conso.`, then a **deeper** box hatched at its right | `1A(LHF) + 1NA + Console + L(RHF)` | not shown | not shown (tbc) | medium | Console is labelled and certain. Whether the deep final piece is a chaise or just a bigger seat is the doubt. 11 ft overall. |
| HC-SO-013254 | DSL-9028 SOFA | header `9028`, `col: tbc. (Modenza)`; the left "30" box is drawn **deep**, running down to a `Balcony (tbc)` arrow, hatched at its left; then `[30]`, `[30｜hatch]` | `L(LHF) + 1NA + 1A(RHF)` | 30" | not shown — sketch adds "(Modenza)" | medium | The sketch adds the fabric range **`(Modenza)`** that Desc2 omits. `Balcony (tbc)` marks where the deep end sits — a placement note, still open. |
| HC-SO-013262 | DSL-8030 SOFA | header `8030`; `[hatch｜box]`, `[box]`, a **taller** box, hatched arm at the right; `arm rest change. Seat cushion ←` points at the **left** arm | `1A(LHF) + 1NA + L(RHF)` | **28" or 26" — the page offers both** | not shown (tbc) | medium | ⚠ Desc2 says `customize follow the detail in photo` — **the photo is the spec for this line**, and the photo leaves the size open: `28/26 inch per seat`, `9 feet` / `8.5`. Also: after-push-back fully cover, leg replaced by fully cover. |
| HC-SO-013329 | DSL-8069 SOFA | header `8069 C`; equation: a **plain unnumbered square** **+** `[30"｜30"]` with a narrow arm panel at its right **+** a box below containing `26` arrowed `1B/S` | `CNR + 2A(RHF) + one 26" piece` | 30" (the extra piece 26") | BO315-4 SAND | medium | Desc2: `Size:30"/Col:BO315-4 Sand/Bottom wrap nylon/**1B/S seater 26"**`. The `C` in the header and the unnumbered square both point to a corner. **`1B/S` is the owner's shorthand — it needs him to say what it is** before the 26" piece can be typed; it may be a separate stool rather than the L's leg (see below). |

## Readings — low confidence

| SO | ERP item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| HC-SO-011454 | DSL-9058 SOFA | **this line's own photo is not a sketch** — it is a showroom **photograph** of an L-shaped sofa (a "Zanotti" display) | see note → `1A(LHF) + 1NA + 1NA + 1A(RHF)` | not shown | HR805-90 | low | ⚠ **The compartment sketch for this sofa is attached to the wrong line.** It sits on the *pillow* line (`DSL-SQUARE PILLOW`, DtlKey 790646) and shows three boxes in a row with a hatched arm at the right end, plus a perpendicular box below-left hatched at its outer end — four pieces, arms at the two ends. ⚠ Desc2 on the sofa line says `arm rest take off`, which contradicts the two drawn arms. Two conflicts on one line, so: low. |

## Not a sofa (lines)

Five of the 40 photo-carrying lines are not sofas and get no compartment proposal.

| SO | ERP item code | what the photo is | note |
|---|---|---|---|
| HC-SO-011657 | TNS-9838 DB | a **plain 6 ft × 3 ft rectangle**, "umbrella fabric cover" | Not a sofa run — no compartments exist to propose. Desc2 `TBC/DSL model/Default size`. |
| HC-SO-011454 | DSL-SQUARE PILLOW | **the SO's sofa compartment sketch** | The drawing belongs to the sofa line 790645; see the low-confidence row above. Pillow qty 4, colour HR805-31. |
| HC-SO-012633 | HOK-LONG PILLOW | close-up **photograph** of a sofa seat and leg | A finish reference for "replace the leg by fully cover", not a plan. Qty 3. |
| HC-SO-012635 | HOK-SQUARE PILLOW | **photograph** of a room (divan plus a grey chaise) | Reference photo, no plan. Qty 4. |
| HC-SO-012635 | TRANSPORTATION CHARGES | close-up **photograph** of a sofa arm | A **delivery-charge line carrying a sofa photo** — clearly misfiled. Desc2 is empty. |

---

## Photo contradicts Desc2

Six lines where the drawing and the text do not agree. **None of these were resolved here** — each needs the
salesperson or the owner.

| SO | Desc2 says | the sketch says | why it matters |
|---|---|---|---|
| HC-SO-011453 | `colour : tbc` | `Colour: HR805-10 / 20` (two-tone) | The colour was **decided on paper and never typed**. Anything reading Desc2 will order a TBC. |
| HC-SO-013322 | `Col : tbc` | `col: Protex` | Same shape of error: a decided colour left as tbc in the text. |
| HC-SO-013254 | `Col : tbc` | `col: tbc. (Modenza)` | The text drops the fabric range the sketch records. Less severe — both say tbc — but the range is real information. |
| HC-SO-011454 | `arm rest take off` | two hatched armrests drawn (on the sketch that sits on the pillow line) | Directly changes the compartments: armless pieces vs `1A` at both ends. |
| HC-SO-012026 | `arm rest replace to sit area` | two hatched armrests drawn | Same conflict. Is this a styling change, or does the end piece become `1NA`? |
| HC-SO-012635 | `arm change to seat area` | three seats with hatched arms at both ends, and an arrow pointing **at the right arm** | Same conflict, but the sketch localises it to **one specific arm** — the text does not. |

There is also one line where Desc2 **defers to the photo outright**:

- **HC-SO-013262** — `customize follow the detail in photo`. The photo is therefore the specification, and it leaves the
  seat size open at **28" or 26"** (9 ft or 8.5 ft). Reading Desc2 alone yields no build, no size and no colour.

## Lines that are really two sofas

Only these need a **line split** rather than a compartment list. Everything else in this batch is a single run
(verified by the rule that arms appear only at the two outer ends).

| SO | ERP item code | what it really is |
|---|---|---|
| HC-SO-013286 | HOK-5540 SOFA | **Line qty = 2** of a standalone `1S` (35", BO315-21 pearl). That is **two complete separate sofas** on one line, not one build. A compartment list cannot express it; the quantity has to. |
| HC-SO-013329 | DSL-8069 SOFA | The `26"` piece the page arrows as `1B/S` (Desc2: `1B/S seater 26"`) is drawn **detached** from the `CNR + 2-seat` run and has **no arm at its outer end**. It is either the L's leg or a **separate stool/bench**. `1B/S` is the owner's shorthand — he has to say which before this line can be typed. |

Two more that look like splits but are **not**:

- **HC-SO-013226** already carries its two sofas (`DSL-8030` L-shape and `DSL-8050` recliner pair) on **two separate
  ERP lines**. Nothing to do.
- **HC-SO-013327** draws `[24"] + [24"｜24"]`, which reads like a 1+2 suite — but the arm panels sit only at the far
  left of the first piece and the far right of the second, so the two pieces **join into one 3-seat run**.

## Open questions for the owner

1. **The L/R convention** (batch A raised it; this batch adds evidence). `HC-SO-012947` writes **"tbc side"** on the
   page itself — the book cannot settle handedness because the person drawing it did not. One ruling flips every
   `LHF`/`RHF` pair on the L-shape rows and changes nothing else.
2. **"arm rest change to seat area"** (`HC-SO-011454`, `HC-SO-012026`, `HC-SO-012635`). Does this make the end piece
   armless (`1NA`), or is it a styling change that leaves it an `1A`? Three lines hang on one answer.
3. **`1B/S`** on `HC-SO-013329` — what piece type is it, and is it part of the run or separate?
4. **`double.`** on `HC-SO-012360` — unexplained by anything else on that page.
5. **Chaise vs corner** for the unnumbered tapered shape that appears on `HC-SO-011601`, `HC-SO-012026`,
   `HC-SO-012106`, `HC-SO-012752`, `HC-SO-013250`. It carries no seat number, which is what distinguishes it from a
   seat — but not from the other. If the owner can say which one the taper glyph means, five medium rows become high.
