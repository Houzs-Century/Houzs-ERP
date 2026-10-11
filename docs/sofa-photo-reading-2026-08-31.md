# Sofa compartment readings from the AutoCount book sketches — 2026-08-31

These are **PROPOSALS for a human to tick**, read off the hand-drawn sketches embedded in the book's own
`SODTL.FurtherDescription` (RTF/WMF) for 22 of the 95 `<model>-1S` placeholder lines. **Nothing was written to any
document, order or table** — this file is the entire output, and every row still needs an owner/salesperson sign-off
before it is applied.

---

## How to read this table

- **Compartments** are suffixes only. The model prefix comes from the ERP product code, never from this document —
  e.g. row 1 means `AMN-SF9028-1A(LHF) + AMN-SF9028-1NA + AMN-SF9028-1A(RHF)`.
- "not shown" means the sketch genuinely does not contain it. Nothing here is inferred from what a sofa "usually" is.
- Colour and seat size come from the book's Desc2 text where it has them, otherwise from writing inside the sketch;
  the source is named in the note when the two disagree or when only one has it.

## Two caveats that apply to the whole table

1. **Resolution ceiling.** The book stores each sketch as a 24-bit DIB at most **240 px** on its long side
   (`\picw240 \pich240`, `\picwgoal3600` = 2.5 in). The PNGs are 4x upscales — there is **no sharper original to go
   back to**. Where a digit or a hatch mark is called uncertain below, that is the ceiling talking, not a missing step.
2. **L-shape handedness is the open question.** For a straight run, "left/right as you face the sofa" is unambiguous
   and the readings below are safe. For an **L-shape**, one leg runs perpendicular to the viewer, and I traversed the
   run end-to-end and labelled the first end as drawn `LHF`. **The owner should confirm that convention** — if he reads
   the perpendicular leg the other way, the `LHF`/`RHF` on every L-shape row flips as a pair. The piece *counts* and
   *types* are unaffected either way.

---

## Readings

| SO | book item code | what the sketch shows | proposed compartments | seat size | colour | confidence | note |
|---|---|---|---|---|---|---|---|
| SO-011957 | AMN-SF9028 SOFA | 3 boxes "32″", arm strip on outer edge of 1st and 3rd | `1A(LHF) + 1NA + 1A(RHF)` | 32″ | BO315-21 | high | **Desc2 already said `1R+1NA+1R`** and the sketch confirms it exactly. The importer had the answer in text and still wrote a placeholder — its Desc2 parser does not know the `1R`/`1NA` shorthand. Also "umbrella fabric full cover". (dtlkey 822479) |
| SO-011957 | AMN-SF9028 SOFA | one square labelled **"Stool"**, "32″" above, "49″" at the side | `STOOL` | n/a — 32″ x 49″ overall | BO315-21 | high | Not a sofa run at all. Desc2 `32” X 49”` is the stool's footprint. A `-1S` placeholder is simply the wrong shape of answer here. (dtlkey 822481) |
| SO-012107 | DSL-9058 SOFA | 2 boxes "32″", hatched arm on the outer edge of each; "120cm" depth, "223cm" total width | `1A(LHF) + 1A(RHF)` | 32″ | AM275-7 | high | Widths corroborate: 2x32″ seats + 2 arms ≈ 223 cm. Sketch repeats Desc2's "back rest change to (8030)" and "wrap bottom to nilon"; header adds "(* any fabric same price)". |
| SO-012277 | DSL-8051 SOFA | cross-hatched arm, 3 plain seat boxes, cross-hatched arm | `1A(LHF) + 1NA + 1A(RHF)` | 28″ | modenza 01 Houston cream | high | Same drawing grammar as SO-011957 above. Sketch adds "no holes on sitting area". |
| SO-012636 | DSL-8030 SOFA | hatched arm, 3 boxes "24", hatched arm | `1A(LHF) + 1NA + 1A(RHF)` | 24″ | modenza 04 mustard | high | Seat size 24″ is from the sketch — Desc2 gives no size. Sketch also notes "Nilon fabric" and a separate "Pillow" line. |
| SO-012929 | AMN-SF9028 SOFA | box "26″" with arm tab on its left, `+`, a 2-seat box "26″\|26″" with arm tab on its right | `1A(LHF) + 2A(RHF)` | 26″ | Modenza 02 Barley | high | The page writes it out in words: **"3S : Size : 26″ / Col : Modenza 02 - Barley"**. The same page also specs a separate **1S @ 28″** (drawn as one box with arm tabs both ends) — check whether that second product has its own line. (dtlkey 877725) |
| SO-013328 | DSL-9028 SOFA | header **"9028 L"**; 2 seats "26″" with arm tab on the left, `+`, a much deeper box "26″" with arm tab on its right | `2A(LHF) + L(RHF)` | 26″ | ZL-12 TAN | high | Three independent signals agree the last piece is a chaise: the "L" in the header, the box drawn ~2x deep, and the `+` separating it. Backrest changed to 8030 design. Page item 2 is a separate "Square Pillow". |
| SO-013384 | DSL-8030 SOFA | hatched arm, 3 boxes "28", hatched arm | `1A(LHF) + 1NA + 1A(RHF)` | 28″ | ZL-15 MISTY | high | Seat size from the sketch; Desc2 gives none. "fully cover replace the leg". (dtlkey 914561) |
| SO-013384 | DSL-8030 SOFA | one box "35" with splayed hatched arms at **both** ends, no divider | `1S` | 35″ | ZL-15 MISTY | high | The companion single-seater to the 3-seater above on the same SO. Two arms + one undivided span + one number = one seat. (dtlkey 914562) |
| SO-013389 | HOK-5540 SOFA | 2 boxes "35" with a narrow arm strip on the outer edge of each | `1A(LHF) + 1A(RHF)` | 35″ | HR805-30 | high | Matches Desc2's "35 inch per seat" exactly. "replace the leg by fully cover". |
| SO-013320 | DSL-8069 SOFA | narrow arm box labelled "12 inch", 2 boxes "32", arrow to "arm rest / 12 inch" on the right | `1A(LHF) + 1A(RHF)` | 32″ | HR805-20 | high | Arms are 12″ each, written on the sketch. An arrow labels the left arm **"Storage"** — worth carrying as a line remark; it is not a compartment. |
| SO-011008 | AMN-SF9058 SOFA | L-shape: arm-left seat, seat, corner box with curved inner edge, seat, seat with arm on the far end; "TV" marks the open side | `1A(LHF) + 1NA + CNR + 1NA + 1A(RHF)` | 30″ (soft) | MODENZA 01 Houston Cream | high | Shape is unmistakable — a distinctly drawn corner unit, 4 seats around it. Confidence is on the **shape**; the seat-size digits in the sketch read "30" but at 240 px "32" cannot be fully excluded, and Desc2 carries no size. See caveat 2 on handedness. |
| SO-011733 | AMN-SF9058 SOFA | L-shape: 2-seat "30″\|30″" with arm on the left, `+` corner box with a chamfered corner, `+` "30″", `+` "30″", `+` end box with a heavy bar | `2A(LHF) + CNR + 1NA + 1NA + 1A(RHF)` | 30″ | CH141-8 ARMY | medium | Piece count is clear; the end piece is the judgement call — an arrow from the right margin points at it, which lines up with Desc2's **"1 ARMREST USE WOODEN PLATE"**. An extra "18" is written inside that last box and is **unexplained** — possibly the arm width. Also "SEAT HEIGHT +1 INCH". |
| SO-012025 | AMN-SF9050 SOFA | L-shape: box with hatched arm on top, a diagonal step into the long leg, 2 seats, hatched arm at the right end | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30″ | GD2502#18 GREY | medium | The corner is drawn as a **diagonal step, not a separate box** — so "is there a distinct CNR unit, or is the first seat of the long leg just deeper?" is a real call for the owner. Seats and arms themselves are clear. "all adjustable arm rest". (dtlkey 829179) |
| SO-008942 | AMN-SF9058 SOFA | same L-shape family as the row above: hatched arm on top, diagonal step, 2 seats, hatched arm at the right end | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30″ | MODENZA 05 DARK OLIVE | medium | Same corner ambiguity, plus the **photo is cropped at both left and right edges** — both arm ends sit on the frame boundary, so I cannot prove nothing extends past them. Desc2 "30 inch per set". |
| SO-012828 | DSL-8030 SOFA | L-shape: 3 boxes "28" running left-to-right with an arm at the far left, a box marked **"C"** with a curved edge at the turn, one box "28" above it | `1A(LHF) + 1NA + 1NA + CNR + 1A(RHF)` | 28″ | B0315-21 | medium | Read "C" as **corner** here (large box, curved inner edge). Careful: the same letter "C" on SO-002861 below is a *narrow* box and reads as a **console** — the book uses one letter for two things, disambiguated only by the drawn shape. The top piece's arm is inferred from the arms-only-at-the-ends rule, not from a visible hatch. "fully cover replace the leg". |
| SO-013385 | DSL-9028 SOFA | L-shape: box "30" with hatching along its bottom edge, a large box with a curved inner corner, then "30", "30" with a hatched arm at the right | `1A(LHF) + CNR + 1NA + 1A(RHF)` | 30″ | ZL-15 MISTY | medium | The two hatched ends fix which pieces are the ends; the large curved box is between them, so corner. Whether it is a `CNR` or a chaise (`L`) is the judgement call — it is drawn wide *and* deep. "fully cover with one layer", backrest changed to 8030. |
| SO-002861 | DSL-8060 SOFA | a wrapped row: box (arm tick left) `+` plain box `+` **narrow** box "C" `+` wide box with a dotted centre line `+` (next line) box with a heavy bar labelled **"Wooden Arm"** | `1A(LHF) + 1NA + Console + 2NA + 1A(RHF)` | 28″ | Modenza 01 - Houston Cream | medium | Inventory is solid: 5 seats + 1 console (the dotted centre line splits the wide box into 2 seats). What is inferred is the **order and handedness** — the `+` sits under the first box, so I read the list as wrapping to the next line. The end piece carries the wooden-plate arm. A photo of the finished cream sectional is pasted on the same page and is consistent. |
| SO-012025 | AMN-SF9050 SOFA | one box with splayed hatched arms at both ends, **no divider and no number** | `1S` | 30″ (from Desc2, not the sketch) | GD2502#18 GREY | medium | Same drawing shape as SO-013384/914562, which *does* carry a number and is one seat — that is what makes `1S` the best reading. But the **seat count is genuinely not written** on this sketch, so it is a proposal, not a reading. Likely the companion armchair to the L-shape on the same SO. (dtlkey 829180) |
| SO-013312 | HOK-5536 SOFA | hatched arm, "32", "32", a deeper box "32" with a hatched arm at the right | `1A(LHF) + 1NA + 1A(RHF)` | 32″ | CH141-9 sky | medium | ⚠️ **Mismatch to resolve before using this row.** The sketch page is headed **"9058"** and notes **"Backrest ↑ 8030"**, but the book ItemCode is **HOK-5536** and Desc2 says **"back rest (5540)"**. The 32″ agrees on both sides. Either the photo captures a neighbouring row on a shared page, or the item/backrest on the line is wrong. The third box is drawn deeper than the other two — possibly a chaise rather than a seat. |
| SO-012877 | DSL-9058 SOFA | **not a sketch** — a photograph of a finished sofa in a showroom: L-shaped, long chaise on the left, arm on the right, 3 back cushions | not determinable | not shown | not shown | low | Desc2 is just **"SL0095 Ready Stock"**. This is an off-the-shelf unit photographed for identification, not a composition drawing — so it may legitimately not need splitting into compartments at all. That is an owner call, not something the picture can answer. |
| SO-013000 | AMN-SF9058 SOFA | out-of-focus photo; a stepped L-shaped piece at the left, 2 small boxes to its right, one separate box below-left, "TV" | not determinable | not shown | CH141-12 | low | The photo is **out of focus at the source**, and the source is 240 px — no amount of processing recovers the digits or the hatching. What is visible: an L-shape plus what looks like a separate single chair. Needs the original book page or the salesperson. |

---

## Cross-cutting findings worth acting on

1. **The importer discards a composition it was handed.** SO-011957/822479's Desc2 is literally `BO315-21/32”/1R+1NA+1R`.
   That is the full answer in text, and the line still became a `-1S` placeholder. If the parser learned the
   `1R` / `1NA` / `2R` shorthand, some of the other 73 unexamined placeholder lines may resolve **without any sketch**.
   Worth grepping the remaining Desc2 values for that pattern before doing more image work.
2. **Not every placeholder is a sofa run.** SO-011957/822481 is a **stool**; SO-012877 is a **ready-stock** unit. A
   `<model>-1S` placeholder silently asserts "one 1-seat compartment", which is wrong in a different way for each of
   these. They need a different disposition, not a better compartment guess.
3. **One data mismatch surfaced:** SO-013312's sketch page header ("9058", backrest 8030) contradicts its ItemCode
   (HOK-5536) and Desc2 (backrest 5540). Flagged in the table; needs a human to look at the original page.
4. **"C" is overloaded** in the book — a narrow "C" box is a console (SO-002861), a large curved "C" box is a corner
   (SO-012828). Anyone automating this later must key off the drawn shape, not the letter.
