# Sofa sketch reading — batch B (2026-08-31)

**These are PROPOSALS for a human to tick, read off the AutoCount book's own hand-drawn sketches.
Nothing was written to any document, order, or database — this file is the only artefact.**

Scope: rows 51–101 of `placeholder-with-photos.txt` (the lower doc numbers, HC-SO-011450 down to
HC-SO-002861) — 51 placeholder sofa lines, 48 distinct sales orders. Batch A (the higher doc
numbers) belongs to another reader.

Sources per row: the line's extracted sketch JPEG
(`backend/scripts/data/line-photos/so/<BookDocNo>__<DtlKey>_1.jpg`) plus the book's own
`SODTL.Desc2` text read live from AED_HOUZS (read-only SELECT).
Every line in this batch had exactly **one** stored sketch. The book stores sketches at ~240 px,
so a few digits are genuinely below the resolution ceiling — those are marked, not guessed.

Grammar used: `1A/2A(LHF|RHF)` = 1- or 2-seat piece with its arm at that end · `1NA/2NA` = armless
middle piece · `L(LHF|RHF)` = chaise · `CNR` = corner · `Console` = console table · `1S/2S/3S` =
a standalone whole sofa of that many seats · `R` = the book's recliner mark.

---

## High confidence (42 rows)

| SO | ERP item code | What the sketch shows | Proposed compartments | Seat size | Colour | Conf. | Note |
|---|---|---|---|---|---|---|---|
| HC-SO-011450 | 9058-1S | Two 1-seat boxes, `32` in each, hatched arm on the outer end of each, joined by `+` | `1A(LHF) + 1A(RHF)` | 32" | GD2502 #18 – Grey | high | Sketch also carries a stray "colour: tbc" written before the code. Wrap bottom to Nilon. |
| HC-SO-011446 | 9058-1S | L plan: arm-left box, plain box, large curved "C" corner, then one box up with a hatched top edge | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30" | CH141-1 | high | Headrest changed to 8030; bottom changed to Nilon. Same room template as HC-SO-011447. |
| HC-SO-011268 | 9028-1S | "Sofa 9028 L shape": two `28"` cells then a deep column `28"`, arm bar at each far end | `2A(LHF) + L(RHF)` | 28" | TBC | high | Bottom wrap to umbrella fabric. Desc2 agrees. |
| HC-SO-011160 | 9058-1S | Arm-left box, plain box, then a deep box with a hatched arm at its right; room dims 8/9/10 ft | `1A(LHF) + 1NA + L(RHF)` | 28" | HR805-90 | high | Seat size from Desc2 (not written in the boxes). Wrap bottom to Nilon. |
| HC-SO-011008 | 9058-1S | Arm-left box, plain box, large curved corner, plain box, then a box with a hatched bottom edge | `1A(LHF) + 1NA + CNR + 1NA + 1A(RHF)` | **unreadable** — sketch says "* 3? inch"; second digit is below the 240 px ceiling | MODENZA 01 – Houston Cream | high (shape) | 5 pieces. Desc2 carries no size, so the size must be re-read from the paper book. |
| HC-SO-010457 | 9028-1S | `[arm][28"]` + `[28"/28"]`; a second book line on the same SO is a Stool | `1A(LHF) + 2A(RHF)` | 28" | BO315-1 Pearl | high | Desc2 states the build: `1+2(28"Inch)`. |
| HC-SO-010417 | 9058-1S | Two 1-seat boxes, `32"` in each, hatched arm on each outer end | `1A(LHF) + 1A(RHF)` | 32" | BO315-10 Silver | high | Page is rotated 90° in the book. Wrap bottom to Nilon. |
| HC-SO-010416 | 9058-1S | Arm-left `30`, plain `30`, stepped corner box, then one `30` with a hatched bottom | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30" | ninja 02, 03, 07, 09 | high | Room 10 ft × 8 ft; "u 2 inch leg". **Bottom fabric contradicts Desc2 — see below.** |
| HC-SO-010415 | 9058-1S | Same layout as HC-SO-010416 | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30" | tbc | high | **Bottom fabric contradicts Desc2 — see below.** |
| HC-SO-010324 | 9050-1S | Corner box marked "C" with a curve, one square beside it, two squares below | `1A(LHF) + 1NA + CNR + 1A(RHF)` (book writes `1EFL+1NA+C+1EFR`) | 32" | HR805-90 | high | Desc2 states the build. Special: "Both side adjustable arm rest". **Bottom fabric contradicts Desc2.** |
| HC-SO-010123 | 9028-1S | `[arm][30]` + `[30][30][arm]` | `1A(LHF) + 2A(RHF)` | **30" in the sketch** (Desc2 says 32") | B0315-5 Fosil | high (shape) | **Two contradictions with Desc2 — see below.** |
| HC-SO-010121 | 8051-1S | `[arm][32]` labelled **1ER** + `[32][32][arm]` labelled **2EL** | `1A + 2A` (3 seats) | **32" in the sketch** (Desc2 says 31") | tbc | high (shape) | **Size + fabric contradict Desc2; the ER/EL labels are mirrored vs the drawing — see below.** |
| HC-SO-010120 | 9058-1S | Left leg: one `30` with a hatched top; wide stepped corner; then `30 / 30` + hatched arm right | `1A(LHF) + CNR + 2A(RHF)` | 30" | B0315-22 | high | Specials: no stitching on the seat area; headrest note. Desc2 size + colour both match. |
| HC-SO-010015 | 9028-1S | Three boxes, the third drawn taller (chaise); each labelled 26"/28" | `1A(LHF) + 1NA + L(RHF)` | 26"/28" | KIV (to be confirmed) | high | Desc2 states the build: `1+1NA+L(26/28"Inch)`. "Premium easy clean fabric". |
| HC-SO-009915 | 8038-1S | `[arm][P 32 inch]` + a **narrow box labelled "conso table"** + `[P 32 inch][arm]` | `1A(LHF) + Console + 1A(RHF)` | 32" | CH141-12 Metal | high | "P" = power seats. Specials: move the power control further forward; wrap bottom to nylon. |
| HC-SO-009602 | 8051-1S | An earlier `[arm][32] + [32][arm]` version is **crossed out**; the live drawing is one box `[arm]/32/32/[arm]` marked "(2 seater)" | `2S` | 32" | tbc | high | The struck-out version was labelled 1EL / 1ER. Change bottom to Nilon. |
| HC-SO-009599 | 8051-1S | One box `[arm]/24 inch/24 inch/[arm]`, marked "(2 seater)", arms called out at 12 inch | `2S` | 24" | tbc | high | Header lists the model's size menu (24, 26, 28, 30, 32); 24 is the one written in the cells. Free random pillow. |
| HC-SO-008821 | 2379-1S | 3-cell box with arms at both ends, "R" marked | `3S` | 60 cm | tbc | high | Desc2 `60cm/3R`. |
| HC-SO-008794 | 2379-1S | One cell "60cm (R)" with hatched arms both sides | `1S` | 60 cm | Ninja 06 | high | Desc2 `1R(60cm)`. |
| HC-SO-008403 | 7223-1S | `[arm][28"][28"]` then a deep column marked "L" with the arm bar at its far right | `2A(LHF) + L(RHF)` | 28" | J9226-11 – LAVA | high | Desc2 `L shape(28")`. |
| HC-SO-008214 | 9058-1S | Four boxes all marked `30"`: arm tab at the far left, a chamfered corner box, arm tab under the last | `1A(LHF) + 1NA + CNR + 1A(RHF)` | 30" | TBC | high | The corner box also carries `30"`. Sketch adds "seat cushion make softer"; Desc2 adds "request add on legs (TBC)". |
| HC-SO-008166 | 9058-1S | Four cells with **both** end pieces dropping down (double chaise) | `L(LHF) + 1NA + 1NA + L(RHF)` | not readable (a number is written in each cell but the photo is a low-res snap of a note) | CH141-2 Beige | high | Desc2 states the build: `L2L(L+1NA+1NA+L)`. Note on the sheet: "please prepare the brackets between the seats and the sofa". |
| HC-SO-007949 (dtl 551732) | 2379-1S | `[arm][75][75cm]` marked "R" + `[75cm][arm]` marked "R" | `2A(LHF) + 1A(RHF)` | 75 cm | not shown | high | Desc2 `3RR/75cm` — 3 seats delivered as a 2-seat + a 1-seat recliner unit; arms only at the two outer ends. |
| HC-SO-007949 (dtl 551733) | 2379-1S | One box "R / 60cm", arms both sides | `1S` | 60 cm | not shown | high | Desc2 `1R/60cm`. Second sofa line on the same SO. |
| HC-SO-006941 | 7223-1S | `[arm][70cm/70cm][arm]` + `[arm][70cm][arm]` | `2S + 1S` | 70 cm | J9047-1 – Brunette | high | Desc2 `2+1S(70cm)`. |
| HC-SO-006890 | 2379-1S | Three separate groups: a 2-cell "R/R", a 1-cell "R", and a 3-cell group | `1S + 2S + 3S` | 60 cm | kiv (to be confirmed) | high | Desc2 `1+2+3(60cm)`. Whiteboard photo, heavy reflections, but the three groups are countable. |
| HC-SO-005862 | 2379-1S | `[arm][ R / plain / R ][arm]`, "60cm" dimensioned below | `3S` | 60 cm | TBC | high | Desc2 `3RR/60cm` — the two outer seats recline. |
| HC-SO-005082 (dtl 358016) | 2379-1S | `[arm][60cm/60cm/60cm][arm]`, header "2379 60cm 3S" | `3S` | 60 cm | Coating Armani J9226-2 – Buttercream | high | "Coating 3 – Moccasin" is struck out on the sheet; Buttercream is the live colour. |
| HC-SO-005082 (dtl 358017) | 2379-1S | `[arm][60cm/60cm][arm]`, header "2379 60cm 2S" | `2S` | 60 cm | Coating Armani J9226-2 – Buttercream | high | Second sofa line on the same SO. |
| HC-SO-005013 | 2379-1S | Three cells "60cm", arrows marked "R" under cells 1 and 3 | `3S` | 60 cm | TBC | high | Desc2 `60cm 3RR`. The SO carries a second 2379 line (2S) that is not in this batch. |
| HC-SO-004751 | 2379-1S | `[arm][60cm ×3][arm]`, "R" under cells 1 and 3; header "2S" struck out and replaced by "3RR" | `3S` | 60 cm | ARMANI J9226-1 – Sand | high | The header change (2S → 3RR) is on the sheet; 3RR is final. |
| HC-SO-004718 | 2379-1S | `[hatched arm][R/R][hatched arm]` | `2S` | 60 cm (Desc2) | J9226-10 – NAVY | high | Desc2 `60cm/2RR` — both seats recline. |
| HC-SO-004709 | R819-1S | One box "1R 30"" with hatched arms both sides; "30"" repeated beside it | `1S` | 30" | 03 – Straw | high | The SO also carries an RDS-5527 3S line (dtl 335480) — a different line, not this row. |
| HC-SO-004692 | 2379-1S | `[hatched arm][60cm ×3][hatched arm]`, header "(3 seater)" | `3S` | 60 cm | J9226-3 – Moccasin | high | Desc2 `3s(60cm)`. |
| HC-SO-004281 | 2379-1S | `[hatched arm][60/60][hatched arm]` | `2S` | 60 (the sketch writes `60"`, Desc2 says 60 cm) | kiv (to be confirmed) | high | Whiteboard photo. |
| HC-SO-003939 (dtl 266659) | 2379-1S | 3 cells, arms both ends, "R" under cells 1 and 3; header "2379 (3RR)(60cm)" | `3S` | 60 cm | armani J9226-1 – sand | high | Desc2 writes `3R`, the sketch header writes `3RR` (two recliner marks are drawn). |
| HC-SO-003939 (dtl 266660) | 2379-1S | One cell "60cm" with arms both sides, "R" below; header "2379 (1R)(60cm)" | `1S` | 60 cm | armani J9226-1 – sand | high | Second sofa line on the same SO. |
| HC-SO-003772 | 7179-1S | `[arm][66cm ×3][arm]`, header "7179 (3S)(66cm)", arrow to TV | `3S` | 66 cm | kiv (to be confirmed) | high | Sheet dated 28 Nov 2024. |
| HC-SO-003295 | 2379-1S | `[arm][R/R][arm]`, header "2s (60cm)", "60 / 60" dimensioned below | `2S` | 60 cm | Guardian – 05 | high | Desc2 `2R(60cm)`. The SO also carries a "chg metal fram" service line. |
| HC-SO-003189 | 2379-1S | `[arm][60cm/60cm][arm]` and, below it, `[arm][60cm][arm]` headed "2379 (1S)" | `2S + 1S` | 60 cm | 2S = Armani J9226-4 · 1S = Armani J9226-3 | high | One book line covers both pieces, each in its own colour. Desc2 matches exactly. |
| HC-SO-003100 | 2379-1S | `[arm][60cm ×3][arm]` | `3S` | 60 cm | TBC | high | Desc2 `3S(60cm)`. |
| HC-SO-002961 | 2379-1S | Front view of a 3-seater, arms both ends, `60cm` in each cell, a single "R" above the right-hand cell | `3S` (right-hand seat = R) | **60 cm in the sketch** (Desc2 says 18") | Armani J9226-1 – SAND | high (shape) | Desc2's "* 1 s = R" matches the single R drawn. **Size contradicts Desc2 — see below.** |

## Medium confidence (8 rows)

| SO | ERP item code | What the sketch shows | Proposed compartments | Seat size | Colour | Conf. | Note |
|---|---|---|---|---|---|---|---|
| HC-SO-011447 | 9058-1S | Room plan: arm-left box, plain box, large curved "C" corner, then one box up with a hatched top edge; 10 ft / 8 ft / 4 ft, sliding door | `1A(LHF) + 1NA + CNR + 1A(RHF)` | not shown | tbc | medium | Same template as HC-SO-011446 (consecutive SOs). Desc2 is just "tbc", so nothing corroborates the shape. |
| HC-SO-011007 | 9058-1S | Large curved corner box at the left of the top leg, two boxes to its right ending in a hatched arm, and one box `30` below-left with a hatched bottom edge | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30" | tbc | medium | The `30` is only written in the down-leg box. Wrap bottom to Nilon. |
| HC-SO-011002 | 9058-1S | Three boxes each marked `24`, hatched arm at each outer end; the third box is drawn noticeably deeper | `1A(LHF) + 1NA + 1A(RHF)` | 24" | tbc | medium | If the deeper third box is meant as a chaise the last piece is `L(RHF)`, not `1A(RHF)`. Worth one look at the paper. |
| HC-SO-011159 | 9058-1S | A small box with a hatched top drawn **detached** above the run; then a curved corner, two boxes, and a hatched arm at the right | `1A + CNR + 1NA + 1A` | not shown | tbc | medium | The top piece's attachment to the corner is inferred from position — it is drawn with a gap. |
| HC-SO-011158 | 9050-1S | L plan: a wide box with a corner curve at the left of the top leg, two boxes to its right, one box below the corner; "sliding door", TV | `1A + CNR + 1NA + 1A` | not shown | tbc | medium | **No armrest hatching anywhere on this sketch** — the two end arms are inferred from the "arms only at the two ends" rule, not drawn. |
| HC-SO-008942 | 9058-1S | Box with a hatched top on the left leg, wide corner box, then two boxes ending in a hatched arm | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30" (Desc2 "30 inch per set") | MODENZA 05 – Dark Olive | medium | **The stored photo is cropped at both the left and right edges** — the outermost pieces are cut, so a piece could be missing at either end. |
| HC-SO-006448 | 7179-1S | L: a deep left leg marked `18"` with an arm bracket at its far left; top leg `28" / 28"` with an arm bracket at its far right | `L(LHF) + 1NA + 1A(RHF)` | 28" on the straight run; the chaise cell reads **18"** | not stated | medium | Desc2 says `Lshape (28")` and leaves the colour field empty ("colour:" with nothing after it). The 18" on the chaise may be a depth rather than a seat width. |
| HC-SO-002861 | 8060-1S | `[1 seat, arm bar at its left] + [1 seat] + [narrow box marked "C"] + [wide box with a dotted divider]`, and below the first, joined by `+`, a fifth 1-seat box with "Wooden Arm" called out on its outer edge | `1A + 1NA + Console + 2NA` **plus** `1A` (wooden arm) | 28" | Modenza 01 – Houston Cream | medium | The narrow "C" box is a **Console** (narrow, not curved). Five pieces are unambiguous; whether the fifth box turns the run into an L, and which end is LHF, is not. An inset photo of the real sectional is on the same sheet. |

## Low confidence (1 row)

| SO | ERP item code | What the sketch shows | Proposed compartments | Seat size | Colour | Conf. | Note |
|---|---|---|---|---|---|---|---|
| HC-SO-008683 | 7233-1S | L: an arm tab, two boxes each `(70")`, a square with a **diagonal** across it marked `(6?)` at the turn, then two boxes down the short leg, the last `(50")` | `1A + 1NA + CNR + 1NA + 1?` — 4 seats + corner as drawn | mixed: `70` on the long leg, `50` on the last piece, corner unreadable | **sketch says Ninja 03; Desc2 says CH141-1** | low | Desc2's build code `2G1F` is not in the owner's grammar and does not obviously match the 5 shapes drawn. Special: "Must add stopper on legs". This one needs the paper book. |

---

## Where the photo contradicts the book's own text

Seven rows. In each case the sketch and `SODTL.Desc2` disagree; both are quoted so a human can pick.

| SO | Field | Sketch says | Desc2 says |
|---|---|---|---|
| HC-SO-010123 | **seat size** | `30` written in all three cells | `32 inch per seat` |
| HC-SO-010121 | **seat size** | `32` written in all three cells | `31 inch` |
| HC-SO-002961 | **seat size** | `60cm` in all three cells | `3s(18")` |
| HC-SO-008683 | **colour** | `cl: Ninja 03` | `clr: CH141-1` |
| HC-SO-010123 | bottom fabric | "wrap bottom to nilon" | "wrap bottom to umbrella fabric" |
| HC-SO-010121 | bottom fabric | "wrap bottom to random fabric" | "wrap bottom to umbrella fabric" |
| HC-SO-010415 / HC-SO-010416 / HC-SO-010324 | bottom fabric | "wrap bottom to nilon" | "wrap/Bottom upgrade to umbrella fabric" |

The three seat-size clashes and the colour clash are the ones that change what gets built. The
nilon-vs-umbrella pattern recurs across five orders, which reads more like the sketch being drawn
first and the spec being upgraded when the line was typed — but that is a guess, and the owner
should rule on which side wins rather than have it decided here.

## One open question for the owner: which way round is LHF / RHF?

The book writes the handedness itself on two sketches in this batch, and they disagree with each
other:

- **HC-SO-009602** (crossed-out version): the piece drawn on the **left** with its arm on the
  **left** is labelled **1EL**; the piece on the right with its arm on the right is **1ER**.
  → label follows the drawing.
- **HC-SO-010121**: the piece drawn on the **left** with its arm on the **left** is labelled
  **1ER**; the 2-seater on the right with its arm on the right is **2EL**.
  → label is mirrored against the drawing (i.e. as you face the sofa).

Because of this, **every `(LHF)` / `(RHF)` tag in the tables above is stated in drawn order** —
reading the run left-to-right as it appears on the page, unrolling an L from the far end of one leg
through the corner to the far end of the other. The piece *sequence* and which ends carry arms are
what the sketches actually prove; the L/R tag needs the owner's convention before it is trusted.

## One ERP item code covers two different book models

`9058-1S` is used for **fifteen** lines in this batch, and the book splits them across two models:

- `DSL-9058 SOFA` — 12 lines: HC-SO-011450, 011447, 011446, 011160, 011159, 011007, 011002,
  010417, 010416, 010415, 010120, 008214
- `AMN-SF9058 SOFA` — 3 lines: HC-SO-011008, HC-SO-008942, HC-SO-008166

Every other ERP code in this batch maps to exactly one book item (`9028-1S` → DSL-9028,
`9050-1S` → AMN-SF9050, `8051-1S` → DSL-8051, `2379-1S` → THL-2379, and so on). So the 9058
placeholder is the only one that cannot tell the two brands apart — worth deciding whether the
three AMN lines should carry their own code before the compartments are entered.

## Other things worth a tick

- **HC-SO-011008** — the seat size is written on the sheet ("* 3? inch") but the second digit is
  under the 240 px storage resolution and Desc2 carries no size. Needs the paper book.
- **HC-SO-008166** — a number is written in each of the four cells but the sketch is a phone snap of
  a note and none of the digits resolve. The build itself is safe (Desc2 states `L2L`).
- **HC-SO-008942** — the stored photo is cropped at both edges; confirm no piece is missing.
- **HC-SO-009602** and **HC-SO-004751** each carry a superseded version on the same sheet
  (2 armed singles → one 2-seater; "2S" → "3RR"). The later version is the one proposed.
- **HC-SO-009915** and **HC-SO-002861** are the only two lines in this batch with a **Console**;
  HC-SO-009915's is labelled "conso table" in words, HC-SO-002861's is the narrow `C` box.
