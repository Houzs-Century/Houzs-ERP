# Sofa compartment readings from the book's own sketches — batch A, 2026-08-31

These are **PROPOSALS for a human to tick**, read off the hand-drawn sketches the book itself stores in
`SODTL.FurtherDescription`. **Nothing was written to any document, order, product or table** — this file is the
entire output, and every row still needs an owner/salesperson sign-off before it is applied anywhere.

---

## What this covers

`node backend/scripts/diag-placeholder-photos.mjs` against **production** (run
[33362005864](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/33362005864), read-only `SELECT`, 2026-08-31)
returns **148 company-1 sofa placeholder lines (`<model>-1S`), of which 101 now carry a photo**. Batch A is the
**first 51** of those 101 sorted by SO number — `HC-SO-002861` through `HC-SO-011450`. Batch B is the other 50,
`HC-SO-011453` onward.

> **The split boundary is not where the brief said it would be.** The brief guessed batch A would run to roughly
> `HC-SO-0128xx`; an even 51/50 count split actually lands at **`HC-SO-011450` / `HC-SO-011453`**. Batch A here is the
> count split, which is what "first half" means. If the batch-B agent split on the doc-number guess instead, the
> range **`HC-SO-011453` … `HC-SO-012752` is the gap to re-check** — it belongs to nobody under the two readings
> combined.

Four lines here (`SO-002861`, `SO-008942`, `SO-011008`, and `SO-012025`'s family) were also read in the earlier
`docs/sofa-photo-reading-2026-08-31.md` pass. They were re-read independently; where the two passes differ, the note
says so.

## How to read the table

- **Compartments are suffixes only.** The model prefix comes from the ERP item code, never from this document — row 1
  means `2379-1A(LHF) + 2379-1NA + 2379-1A(RHF)`.
- **"not shown"** means the sketch genuinely does not contain it. Nothing here is inferred from what a sofa
  "usually" is.
- `R` = recliner, `P` = power. A bare `1S`/`2S`/`3S` is a **standalone whole sofa**, not a run.
- Colour and seat size come from the book's Desc2 text where it has them, otherwise from writing inside the sketch.
  Where the two disagree the row says so with a ⚠.

## Three caveats that apply to the whole table

1. **Resolution ceiling.** The book stores each sketch at **240 px** on its long side. Everything below is a 5x
   LANCZOS upscale with autocontrast — there is **no sharper original to go back to**. Where a digit or a hatch mark
   is called uncertain, that is the ceiling talking, not a missing step.
2. **L-shape handedness is an open convention question.** For a straight run, "left/right as you face the sofa" is
   unambiguous. For an **L-shape** one leg runs perpendicular to the viewer; the run was traversed end-to-end and the
   first end as drawn was labelled `LHF`. **The owner should confirm that convention** — if he reads the
   perpendicular leg the other way, `LHF`/`RHF` on every L-shape row flips as a pair. Piece *counts* and *types* are
   unaffected either way.
3. **Two photos in the ERP, one picture in the book.** Most of these lines report `pics=2` in `photo_urls` while the
   book holds a single embedded image. That looks like the known duplicate (`prune-duplicate-sofa-photos.mjs`), not a
   second sketch — no row below is missing a second drawing.

---

## Readings — high confidence

| SO | ERP item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| HC-SO-003100 | 2379-1S | 3 seat boxes "60cm", square arm block at each end | `1A(LHF) + 1NA + 1A(RHF)` | 60cm | TBC | high | Desc2 `3S(60cm)` states the same thing the drawing shows. |
| HC-SO-003189 | 2379-1S | a 2-seat box "60cm\|60cm" with arms at both ends, and **below it a separate 1-seat box** "60cm" with arms at both ends | `2S` **+** `1S` — two standalone sofas | 60cm | 2S: Armani J9226-4 · 1S: Armani J9226-3 | high | Desc2 `2s+1s`, with a **different colour for each**. One ERP line is carrying two products; this probably needs two lines, not one compartment split. |
| HC-SO-003295 | 2379-1S | 2 seats, **both** marked "R", arms at both ends | `1A(R)(LHF) + 1A(R)(RHF)` | 60cm | Guardian - 05 | high | Desc2 `2R(60cm)`. |
| HC-SO-003772 | 7179-1S | header "7179 (3S) (66cm)"; 3 seats "66cm", arm block at each end | `1A(LHF) + 1NA + 1A(RHF)` | 66cm | KIV | high | Desc2 `3S(66cm)`. TV arrow below the run. |
| HC-SO-003939 (dtl 266659) | 2379-1S | header "(3RR) (60cm)"; 3 seats, arms both ends, a footrest squiggle under seats 1 and 3 | `1A(R)(LHF) + 1NA + 1A(R)(RHF)` | 60cm | Armani J9226-1 Sand | high | Sketch header says **3RR**, Desc2 says **3R** — the sketch is the more specific of the two and the two footrest marks agree with it. |
| HC-SO-003939 (dtl 266660) | 2379-1S | header "(1R) (60cm)"; one box, arms both ends, footrest squiggle | `1S(R)` | 60cm | Armani J9226-1 Sand | high | Desc2 `1R/60cm`. The companion single recliner to the row above, on the same SO. |
| HC-SO-004281 | 2379-1S | 2 seat boxes, hatched arms at both ends | `1A(LHF) + 1A(RHF)` | 60cm | KIV | high | Desc2 `2S (60cm)`. The sketch writes the number with an inch tick; Desc2 says cm. |
| HC-SO-004692 | 2379-1S | header "2379 (3 Seater)"; 3 boxes "60cm", hatched arms both ends, TV arrow | `1A(LHF) + 1NA + 1A(RHF)` | 60cm | J9226-3 Moccasin | high | Desc2 `3s(60cm)`. |
| HC-SO-004709 | R819-1S | one box containing "1R" and "30″", hatched arms at **both** ends | `1S(R)` | 30″ | 03-Straw | high | "1R" is written inside the box; one box + two arms = one standalone recliner. |
| HC-SO-004718 | 2379-1S | 2 seats, both marked "R", hatched arms both ends | `1A(R)(LHF) + 1A(R)(RHF)` | 60cm | J9226-10 Navy | high | Desc2 `2RR` — two seats, both reclining. |
| HC-SO-004751 | 2379-1S | header "2379 60cm 3RR" with an earlier **"2S" struck out**; 3 seats, "R" under seats 1 and 3 | `1A(R)(LHF) + 1NA + 1A(R)(RHF)` | 60cm | Armani J9226-1 Sand | high | The crossed-out "2S" is a superseded earlier spec — do not read it as a second product. |
| HC-SO-005013 | 2379-1S | 3 seats "60cm"; arrows point at seats 1 and 3, each labelled "R" | `1A(R)(LHF) + 1NA + 1A(R)(RHF)` | 60cm | TBC | high | Desc2 `60cm 3RR`. Arms are not hatched here; placed at the two ends by the rule and by the text. |
| HC-SO-005082 (dtl 358016) | 2379-1S | header "2379 60cm 3S"; 3 seats, arm block each end | `1A(LHF) + 1NA + 1A(RHF)` | 60cm | Coating Armani J9226-2 Buttercream | high | An earlier "Coating 3 - Moccasin" is struck out on the page. |
| HC-SO-005082 (dtl 358017) | 2379-1S | header "2379 60cm 2S"; 2 seats, arm block each end | `1A(LHF) + 1A(RHF)` | 60cm | Coating Armani J9226-2 Buttercream | high | The companion 2-seater to the row above, same SO, same fabric. |
| HC-SO-005862 | 2379-1S | header "(3RR)"; 3 seats, arms both ends, "R" in seats 1 and 3, "60cm" below | `1A(R)(LHF) + 1NA + 1A(R)(RHF)` | 60cm | TBC | high | Desc2 `3RR/60cm`. |
| HC-SO-002961 | 2379-1S | 3 seats "60cm", rounded arms at both ends, **"R" written in the third seat** | `1A(LHF) + 1NA + 1A(R)(RHF)` | 60cm (sketch) | Armani J9226-1 SAND | high | Desc2 spells out `* 1 s = R` — exactly one recliner — and the sketch says **which** seat. ⚠ **Size conflict:** Desc2 says `3s(18")`, the sketch says 60cm per seat. |
| HC-SO-008821 | 2379-1S | 3 seats with heavy dividers, arms both ends, **"R" in the first seat only** | `1A(R)(LHF) + 1NA + 1A(RHF)` | 60cm | TBC | high | Desc2 `60cm/3R`. One R in the text, one R in the drawing, and the drawing says which end. |
| HC-SO-006941 | 7223-1S | a 2-seat piece "70cm\|70cm" with an arm on the far **left only**, `+`, a 1-seat piece "70cm" with an arm on the far **right only** | `2A(LHF) + 1A(RHF)` | 70cm | J9047-1 Brunette | high | Two arms in the whole drawing, at the two ends — so it is **one run**, not two sofas. Desc2's `2+1S` reads like two standalone units; the drawing refutes that. |
| HC-SO-007949 (dtl 551732) | 2379-1S | 3 seats at 75cm, arms at both ends, "R" under the first and the last | `1A(R)(LHF) + 1NA + 1A(R)(RHF)` | 75cm | not shown | high | Desc2 `3RR/75cm`. Drawn as a 2-group plus a 1-group, but the arms sit only at the outer ends. |
| HC-SO-007949 (dtl 551733) | 2379-1S | one box "R / 60cm", arms both ends | `1S(R)` | 60cm | not shown | high | Desc2 `1R/60cm`. **Note the two lines on this SO have different seat sizes** — 75cm and 60cm. |
| HC-SO-008403 | 7223-1S | [arm \| 28″] [28″] [a much deeper box marked **"L"** \| arm], TV below | `1A(LHF) + 1NA + L(RHF)` | 28″ | J9226-11 LAVA | high | The chaise is literally labelled "L" in the drawing and Desc2 says `L shape(28")`. |
| HC-SO-008794 | 2379-1S | one box "60cm (R)", hatched arms both ends | `1S(R)` | 60cm | Ninja 06 | high | Desc2 `1R(60cm) Col: Ninja 06`; the sketch writes "TBC (Ninja 06)". |
| HC-SO-009599 | 8051-1S | [hatched arm][24 inch][24 inch][hatched arm], captioned "(2 seater)"; arrows label each arm "12 inch" | `1A(LHF) + 1A(RHF)` | 24″ | TBC | high | The header lists the size menu "24, 26, 28, 30, 32" with an arrow to the chosen 24. Arms are 12″ each. Also "Free Pillow (Random)". |
| HC-SO-009602 | 8051-1S | [hatched arm][32][32][hatched arm], captioned "(2 seater)" | `1A(LHF) + 1A(RHF)` | 32″ | TBC | high | **An earlier version of the drawing is crossed out above it** — read only the bottom one. "change bottom to nilon". |
| HC-SO-009915 | 8038-1S | [hatched arm][**P** / 32 inch] `+` [a narrow box with an arrow reading "conso table"] `+` [**P** / 32 inch][hatched arm] | `1A(P)(LHF) + Console + 1A(P)(RHF)` | 32″ | CH141-12 Metal | high | "P" = power, corroborated by the page note **"change power control to more in front"**. The console is labelled by its own arrow, so this is not the ambiguous "C". |
| HC-SO-010015 | 9028-1S | header "9028 (L shape)"; [box with a left arm] `+` [box] `+` [a visibly deeper box] | `1A(LHF) + 1NA + L(RHF)` | 26″/28″ (as written) | KIV | high | **Desc2 already states the build: `1+1NA+L(26/28' Inch)`.** The importer had the answer in text and still wrote a placeholder. Item 2 on the page is a separate square pillow. |
| HC-SO-010417 | 9058-1S | [hatched arm \| 32″] `+` [32″ \| hatched arm] | `1A(LHF) + 1A(RHF)` | 32″ | B0315-10 Silver | high | The photo is stored rotated 90° in the book. "7.3, 7.5" is the overall size in feet. Item 2 is a random pillow. |
| HC-SO-010457 | 9028-1S | header "9028 3S"; [28″ with an arm on its left] `+` [28″\|28″ with an arm on its right]; **item 2 is a separate box labelled "Stool"** | `1A(LHF) + 2A(RHF)` | 28″ | B0315-1 Pearl | high | **Desc2 states `1+2(28'Inch)`.** This is the same "3S drawn as 1+2" pattern the earlier pass found on SO-012929. The stool is a different line, not a compartment. |
| HC-SO-010324 | 9050-1S | a box marked **"C"** with a curved edge at the top-left, one square to its right, two squares stacked below it; "Both side adjustable arm rest" | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 32″ | HR805-30 | high | **Desc2 states `1+C+2`.** `parse-sofa.mjs:221` records this exact string as a known parser miss ("came out as 1S + 2S with no corner, no placeholder, no flag"). Handedness per caveat 2. |
| HC-SO-011450 | 9058-1S | [hatched arm \| 32] `+` [32 \| hatched arm] | `1A(LHF) + 1A(RHF)` | 32″ | GD2502 #18 Grey | high | Same drawing grammar as SO-010417. |
| HC-SO-006890 | 2379-1S | **three separate units**, each with arms at both ends: a 2-seater "R\|R", a 1-seater "R", and a 3-seater with "R" in its last seat | 2S: `1A(R)(LHF) + 1A(R)(RHF)` · 1S: `1S(R)` · 3S: `1A(LHF) + 1NA + 1A(R)(RHF)` | 60cm | KIV | high (inventory) | **Desc2 states `1+2+3(60cm)`.** One placeholder line is standing for a **three-piece suite**. The inventory is certain; which seats recline is read off the sketch and is the softer half. |
| HC-SO-011268 | 9028-1S | header "Sofa 9028 L shape / Size: 28″"; [28″\|28″ sharing one outline] `+` [a tall box 28″] | `2A(LHF) + L(RHF)` | 28″ | TBC | high | The first two seats share a single outer outline (so one 2-seat piece) and the `+` separates the chaise. "Bottom wrap to umbrella fabric". |

## Readings — medium confidence

| SO | ERP item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| HC-SO-002861 | 8060-1S | a **wrapped** row: [box, arm tick on its left][box][**narrow** box "C"][wide box with a dotted centre line], then on the next line [box with a heavy bar labelled **"Wooden Arm"**] | `1A(LHF) + 1NA + Console + 2NA + 1A(RHF)` | 28″ | Modenza 01 - Houston Cream | medium | Inventory is solid — 5 seats + 1 console (the dotted line splits the wide box into two). What is **inferred** is the order and handedness: the `+` sits under the first box, so the list is read as wrapping. A photo of the finished cream sectional is pasted on the same page and is consistent. Agrees with the earlier pass. |
| HC-SO-008214 | 9058-1S | L: [arm \| 30″][30″][30″ with a chamfered corner] and, below the last one, [30″ with an arm at its bottom] | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30″ | TBC | medium | **The judgement call:** the piece at the turn carries a "30″" seat label like the others, which argues it is a SEAT, not a corner — in which case the answer is `1A(LHF) + 1NA + 1NA + 1A(RHF)`. Its chamfered outer corner is what argues for `CNR`. Desc2 also asks for "add on legs (TBC)". |
| HC-SO-008942 | 9058-1S | L, **photo cropped at both side edges**: [leg piece with a hatched arm on its top] → a diagonal step → [wide box][box][box + hatched arm] | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30″ | MODENZA 05 Dark Olive | medium | The corner is drawn as a **diagonal step, not a separate box**, so "distinct CNR unit vs. a deeper first seat" is a real owner call. Both arm ends sit on the frame boundary — nothing extending past them can be ruled out. Same reading as the earlier pass. |
| HC-SO-011008 | 9058-1S | L: [hatched arm][box][box] → a large box with a curved inner corner → [box][box with hatching on its bottom] | `1A(LHF) + 1NA + CNR + 1NA + 1A(RHF)` | 30″ (sketch: "* 30 inch") | **TBC** | medium | Compartments match the earlier pass exactly. **The colour does not:** that pass recorded "MODENZA 01 Houston Cream", while Desc2 for dtl 760787 reads only `colour tbc / wrap bottom to Nilon` and no colour name is visible in the picture. Treat the colour as unset until someone checks the page. |
| HC-SO-010120 | 9058-1S | L: [hatched arm on top \| 30] → a wide box with a curved inner edge → [30][30][hatched arm] | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30″ | B0315-22 | medium | The wide box at the turn is drawn both wide and deep with a curved inner edge — corner. Desc2 also says "no stitching on sitting area". A second colour "B0315-29" appears lower on the page and belongs to another item, not this run. |
| HC-SO-010123 | 9028-1S | [hatched arm \| a box "30" drawn visibly **taller**] then [30][30][hatched arm] | `L(LHF) + 1NA + 1A(RHF)` | 30″ (sketch) | TBC | medium | ⚠ **Size conflict:** Desc2 says "32 inch per seat", the sketch says 30 on all three boxes. If the taller box is only a deeper seat and not a chaise, the answer is `1A(LHF) + 1NA + 1A(RHF)`. |
| HC-SO-010415 | 9058-1S | [arm \| 30][30][a large box with a notched inner corner]; below it, [30 with hatching along its bottom] | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30″ | TBC | medium | The bottom box's hatching is on its far edge, which is what fixes it as the outer end of the vertical leg. |
| HC-SO-010416 | 9058-1S | [hatched \| 30] `+` [30] `+` [a stepped corner box]; below, [30] with hatching under it | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30″ | Ninja 02, 03, 07, 09 | medium | Photo stored rotated 90°. Room is marked 10 feet x 8 feet with a door. A later heavy-pen note **"1 NA = 3.5 feet"** independently corroborates a middle armless seat. **Four ninja colours are listed and the sketch does not say which piece gets which** — that is an owner question, not a reading. |
| HC-SO-011002 | 9058-1S | [hatched arm \| 24][24][24, drawn deeper \| hatched arm] | `1A(LHF) + 1NA + L(RHF)` | 24″ | TBC | medium | The third box's outline sits above the other two, i.e. deeper — read as a chaise. If it is only a deeper seat, `1A(LHF) + 1NA + 1A(RHF)`. |
| HC-SO-011007 | 9058-1S | [large box with a curved inner corner][box][box + hatched arm]; below-left, [30 with hatching along its bottom] | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30″ | TBC | medium | Same drawing family as SO-011008 but with one fewer seat on the horizontal leg. |
| HC-SO-011158 | 9050-1S | [large curved corner box][box][box]; below-left, one small box. **No hatching anywhere on the page** | `1A(LHF) + CNR + 1NA + 1A(RHF)` | **not shown** | TBC | medium | Piece count and the corner are clear. **The arms are not drawn at all** — they are placed at the two ends by the rule, not by the picture. No seat size is written anywhere. Page notes "Sliding Door". |
| HC-SO-011159 | 9058-1S | [small box with hatching on its top] then [curved corner box][box][box][hatched arm] | `1A(LHF) + CNR + 1NA + 1A(RHF)` | **not shown** | TBC | medium | The two hatched ends fix the direction of the run. No seat size on the page; Desc2 carries only "wrap bottom to Nilon". |
| HC-SO-011160 | 9058-1S | [hatched arm \| box][box][box drawn **much** deeper \| hatched arm]; room marked 8-10 feet, depth 6 feet | `1A(LHF) + 1NA + L(RHF)` | 28″ | HR805-90 | medium | The depth difference on the third piece is unmistakable at this zoom, which is what makes it a chaise rather than a seat. A "9 feet" note is circled beside a struck-out figure. |
| HC-SO-011446 | 9058-1S | L: [hatched arm \| box][box] → corner with a curved inner edge → [box] → [box with hatching on its top] | `1A(LHF) + 1NA + CNR + 1NA + 1A(RHF)` | 30″ | CH141-1 | medium | 4 seats + corner. **Whether there is one box or two between the corner and the top arm piece is right at the 240 px limit** — compare with SO-011447 below, same drawer, which has one fewer. Desc2 also says "headrest change to 8030". |
| HC-SO-011447 | 9058-1S | same drawing family as SO-011446 but with a single box on the vertical leg | `1A(LHF) + 1NA + CNR + 1A(RHF)` | **not shown** | TBC | medium | Room 10 feet x 8 feet, the top piece marked 4 feet wide, sliding door on the right. Those are room dimensions, not seat sizes — no seat size is given anywhere. |
| HC-SO-006448 | 7179-1S | L: a **deep** box "18" on the left with an arm bracket on its outer left; along the top "28" then "18″"; arm bracket at the far right | `L(LHF) + 1NA + 1A(RHF)` | Desc2 says 28″; the sketch writes **18 / 28 / 18** | **not shown** | medium | Desc2 is `Lshape (28”) / colour:` — **the colour field was left blank in the book**. The three numbers on the drawing do not reduce to the single 28″ in the text; someone should say whether 18 is an arm width or a seat. |
| HC-SO-008683 | 7233-1S | L: [arm \| 70″][70″] → [a square crossed by a **diagonal** = corner] → [a seat] → [a detached box "50″"] | `1A(LHF) + 1NA + CNR + 1A(RHF)` **+ a separate STOOL** | 70″ on the top pair (units as written) | ⚠ **conflict** — sketch says "Ninja 03", Desc2 says "CH141-1" | medium | Reads the header shorthand **"2G1F"** as 2 seats + corner + 1 seat + Footstool, which is exactly what the drawing lays out; the detached "50″" box at the end is the footstool, not a compartment. Desc2 also requires "Must add stopper on legs". **The colour must be resolved before this is used.** |

## Readings — low confidence

| SO | ERP item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| HC-SO-010121 | 8051-1S | [hatched arm \| 32] labelled **"1SR"**; then [32][a **narrow hatched strip**][32][hatched arm] labelled **"2EL"** | `1A(LHF) + 2A(RHF)` — proposal only | 32″ (sketch) | TBC | low | Two things unresolved. (a) The narrow hatched strip sits **between** the two seats of the right-hand group, which the arms-only-at-the-two-ends rule forbids — a Console is the other candidate, and the drawn shape does not settle it. (b) The two labels cannot be read at 240 px; "1SR"/"2EL" is a best guess and the letters change the answer. ⚠ Desc2 says **31 inch**, the sketch says **32**. |
| HC-SO-008166 | 9058-1S | a photograph of the page at an angle with ink showing through from the reverse; a row of 4 boxes with an arm bracket at each end, plus two down-extensions | `2A(LHF) + CNR + L(RHF)` — **from the Desc2 text only** | not readable | TBC | low | Desc2 states `Corner/2R+C+1L`, which is a 3-piece composition, but the drawing appears to show **4 seat boxes plus two down-extensions**, and the two do not reconcile at this resolution. The page also carries a modification — "The L shape unit to become chair / please prepare the brackets between the sofa and the sofa" — which may change the answer outright. Needs the original book page or the salesperson. |

---

## Counts

| confidence | rows |
|---|---|
| high | 32 |
| medium | 17 |
| low | 2 |
| **total** | **51** |

## Cross-cutting findings worth acting on

1. **13 of these 51 lines had the build written out in TEXT and still became a `-1S` placeholder.** `3S(60cm)`,
   `2s+1s`, `2R`, `2RR`, `3RR`, `1R`, `1+1NA+L`, `1+C+2`, `1+2`, `1+2+3`, `L shape`, `Corner/2R+C+1L`, `2+1S`. The
   parser does not know this shorthand — and `parse-sofa.mjs:221` already records `1+C+2` as a known miss that
   produced "1S + 2S with no corner, no placeholder, no flag". **Teaching the parser this vocabulary would resolve a
   large share of the remaining placeholders with no image work at all**, and would do it more reliably than reading
   a 240 px sketch. That is the single highest-value follow-up in this batch.
2. **A placeholder line is not always ONE sofa.** `SO-003189` is a 2-seater plus a 1-seater **in two different
   fabrics**; `SO-006890` is a three-piece suite (1 + 2 + 3); `SO-010457` and `SO-008683` each pair a run with a
   separate stool. `<model>-1S` silently asserts "one 1-seat compartment", which is wrong in a different way for each
   of these — they need a line split, not a better compartment guess.
3. **The recliner shorthand in Desc2 is ambiguous; the sketch is not.** `2R` (SO-003295) means two seats that both
   recline, while `3R` (SO-008821) means three seats of which **one** reclines, and `3R` vs `3RR` disagree between
   text and sketch on SO-003939. **The number is the seat count and the R count is not reliably encoded** — so where
   this file marks specific seats as `(R)`, that came from an R written inside a seat box in the drawing, never from
   the text.
4. **Four size or colour conflicts between the book's own text and its own sketch**, each needing a human:
   `SO-002961` (Desc2 18″ vs sketch 60cm), `SO-010121` (31″ vs 32″), `SO-010123` (32″ vs 30″), and `SO-008683`
   (colour Ninja 03 vs CH141-1).
5. **Six lines carry no seat size anywhere** — `SO-006448`, `SO-011158`, `SO-011159`, `SO-011447`, and the two
   `SO-007949` lines have it only in the sketch. Marked "not shown" rather than filled with a house default.
6. **One colour was recorded in the earlier pass that the book does not support.** `SO-011008` was written up as
   "MODENZA 01 Houston Cream"; its Desc2 is `colour tbc` and no colour appears in the picture. Flagged rather than
   silently corrected.
7. **The "C" overload is confirmed on this batch too** — `SO-002861` has a *narrow* "C" box that is a **console**,
   `SO-010324` has a *large curved* "C" box that is a **corner**. Anything automating this later must key off the
   drawn shape, never the letter. `SO-009915` shows the safe case: the console there is labelled by its own arrow
   ("conso table").
