#!/usr/bin/env node
// Teach the SO scanner to read a handwritten slip: the sofa DRAWING and the
// bedframe numbers.
//
// Owner 2026-08-10: "你看了那么多图片和解析了那么多 ... 所以你应该可以用这个去
// train 我们的 salesorder OCR 到很厉害很准了 ... 会的话教我们的 salesorder OCR
// 怎么解析."
//
// Everything below was derived by reading ~25 real AutoCount slips this week
// and checking each reading against the owner's own corrections. It is
// knowledge the distiller can never produce, because it is not in the
// corrections: the distiller diffs extracted JSON against corrected JSON, and
// no diff teaches you that a hatched strip on the left edge of a box IS a
// left armrest.
//
// It is written to the __GLOBAL_MANUAL__ row, which distillGlobalRules never
// regenerates, so a weekly cron cannot wipe it.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: convergent. ON CONFLICT (salesperson) DO UPDATE re-writes the same rules, overwriting anything a person has tuned since.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const KEY = "__GLOBAL_MANUAL__";

const RULES = `SOFA — READING THE SKETCH

A sofa slip almost always carries a hand drawing of the build. Read it in this
order; stop at the first step that answers the question.

1. THE WRITTEN STRING BEATS THE DRAWING. Many slips spell the build out under
   the sketch — "1EL + 1NA + C + 1NA + 1ER", or "3S : Size 26\\" / 1S : Size 28\\"".
   When that string is present, take it verbatim and do not interpret the boxes.

2. ONE BOX = ONE COMPARTMENT. The number written inside a box is the SEAT DEPTH
   in inches (24, 26, 28, 30, 32, 35 are the common ones). A number written under
   the whole run is the TOTAL WIDTH in feet or cm — it is not a seat depth.

3. A HATCHED OR DOUBLE-LINED STRIP ON THE EDGE OF A BOX IS AN ARMREST, and the
   edge it sits on is the side:
      strip on the LEFT edge   -> that piece is (LHF)
      strip on the RIGHT edge  -> that piece is (RHF)
      strips on BOTH edges     -> a whole seat, 1S or 2S
      no strip at all          -> armless, 1NA or 2NA
   This is the single most useful rule on the page: it turns a drawing into
   LHF / RHF without guessing.

4. A BOX DRAWN WITH A DIAGONAL, A CUT CORNER, OR MARKED C IS THE CORNER (CNR).

5. "TV" MARKS THE VIEWING DIRECTION. Left and right are as seen facing the sofa
   from the TV. A box drawn ABOVE or BELOW the main row, at right angles to it,
   is the other leg of an L — flatten it onto the end it joins.

6. A WORD INSIDE A BOX IS THE PIECE: Stool, Daybed, Console.

7. ARMS ONLY EVER CLOSE THE RUN. A sofa has exactly two closed ends; everything
   between them is armless. If a drawing seems to put an arm in the middle, the
   armrest belongs at the nearest end.

8. NEVER GUESS. If the drawing is cropped at the edge of the photo, or the piece
   order cannot be read, return what IS legible and say the rest is unreadable.
   A placeholder a human completes is right; an invented compartment is not.

SOFA — WHAT ELSE THE SLIP CARRIES

- SPECIAL ORDERS are written as instructions beside the sketch and must be
  captured, not dropped: "wrap bottom to nylon", "bottom use umbrella fabric"
  (the same treatment as nylon), "fully cover replace the leg", "back rest
  change 8030", "wooden arm", "no this stitching", "seat firmer".
- A LEG that is not stated means the Default leg, not a missing value.
- COLOUR is written as a series code: BO315-23, HR805-40, CH141-8, GD2502#09,
  MODENZA 05, PC151-01. Read it exactly as written, including any name after it
  ("BO315-23 (BEIGE)"); the ERP normalises the spelling, the scanner should not.
  "TBC" or "KIV" means the colour is not chosen yet — that is a real state, not
  a miss.
- Lines like "dispose 3S sofa" or "Free Pillow (Random)" are a SERVICE or a
  giveaway, not a compartment and not a special order.

BEDFRAME — WHAT THE SLIP STATES AND WHAT THE DRAWING SHOWS

A bedframe line is a MODEL plus a SIZE plus four numbers. Read all four; a
missing one is what blocks the order later.

1. SIZE is the suffix on the code and the words on the slip:
      (K) 6FT / 183x190    (Q) 5FT / 152x190    (SS) 3.5FT / 107x190
      (S) 3FT / 90x190     (SK) 200x200 — the owner calls 200x200 superking
   Anything outside those five is a SPECIAL size and MUST carry its dimensions.
   Do not round a stated dimension to the nearest standard size.

2. THE THREE HEIGHTS, all in inches, written every way a human writes them:
      DIVAN  the box height       Divan 10, Divan10", DIAVAN, 10inch
      LEG    the leg              +2" leg, 2inch leg, NO LEG / NOLEG
      GAP    the mattress gap     Gap 14, M.GAP, MGAP, MATTRESS GAP
   They are often run together with no spaces: "Divan10/Gap14", "8''+2\"leg",
   "10inch+NoLeg". Read the number that sits with each word, not the first
   number on the line.

3. A DIVAN STATED WITH NO LEG MENTIONED MEANS NO LEG — zero, not unknown.
   That is an owner ruling, and it is the difference between a complete line
   and one that blocks.

4. HYDRAULIC (storage) beds carry TWO heights and telling them apart is the
   whole job: an OUTER box height and an INNER storage depth, usually written
   "hydraulic 16\"/Inner 14\"". Owner's rulings: the outer wins when it is
   written, and an inner-only line converts at INNER + 2. Standard divans are
   12", 14", 16".

5. THESE FRAMES HAVE NO DIVAN BASE AT ALL, so divan height, leg height and gap
   do not apply and their absence is not a gap in the data: DIVAN ONLY (no
   mattress, so no gap either), ADJUSTABLE / electric, pull-out and trundle
   combos written (S+S) or (SS+S), and DOUBLE DECKER bunks.

6. AN UNQUALIFIED "DRAWER" MEANS FRONT DRAWER. Left and right drawers are
   always written as such.

7. COLOUR is a fabric code — PC151-01, AMBER 01, MEDITEX Silver. TBC or KIV
   means the colour is not chosen yet: a real state, not a miss.

8. ON THE DRAWING, a bedframe is sketched side-on as a headboard with the bed
   beside it, and the numbers are dimension marks against the parts: the tall
   one against the headboard is the TOTAL height, the one against the box is
   the DIVAN, the short one under it is the LEG, the one between the box top
   and the mattress top is the GAP. If only a total is written, say so rather
   than splitting it.

9. SPECIAL ORDERS on a bedframe read like: HB (headboard) fully cover, HB
   straight, headboard only, side panel none, no bracket, front / left / right
   drawer, divan top fully cover, 1 piece divan, fully cover to floor.

IMAGE QUALITY

These drawings are photographed order books, often small. When a mark is
ambiguous at full view, look again at that region enlarged before deciding —
several builds that read as unreadable at thumbnail size are unambiguous when
the box edges are examined closely. Enlarging is allowed; guessing is not.`;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const [row] = await sql`SELECT salesperson, length(rules) AS n FROM scm.so_scan_rules WHERE salesperson = ${KEY}`;
  log(row ? `${KEY} exists (${row.n} chars) — it will be replaced` : `${KEY} does not exist yet — it will be created`);
  log(`new rules: ${RULES.length} chars, ${RULES.split("\n").filter((l) => l.trim()).length} non-empty lines`);
  log("");
  for (const l of RULES.split("\n").slice(0, 12)) log(`   ${l}`);
  log("   ...");

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  await sql`INSERT INTO scm.so_scan_rules (salesperson, rules, updated_at)
    VALUES (${KEY}, ${RULES}, now())
    ON CONFLICT (salesperson) DO UPDATE SET rules = EXCLUDED.rules, updated_at = now()`;
  log("APPLIED — the scanner now receives the sketch-reading rules on every scan, for every rep.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
