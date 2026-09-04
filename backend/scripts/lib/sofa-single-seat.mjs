// "The book itself says one seat." Shared by the completeness audit so the
// question can be TESTED rather than restated inside a 500-line one-shot.
//
// Why it exists (owner 2026-09-04): a sofa line whose ERP code ends in `-1S` is
// two completely different situations wearing the same suffix —
//
//   * the AutoCount line says one seat and the ERP holds one seat. CORRECT.
//   * the decoder could not read the build, so the importer fell back to the
//     bare one-seat placeholder. WORK.
//
// Counted together they inflate the backlog the owner plans against: 26 lines
// on the proceeded sales orders, of which 5 were never a defect (measured on
// prod, company 1, 2026-09-04).
//
// BOTH halves below are required, and each covers the other's measured failure:
//   - the Desc2 must WRITE a one-seater. Without this, HC-SO-013327
//     ("Size:24”/Col:BO315-7 Peach/Bottom wrap nylon/Seater depth +1”") reads as
//     one, because the "+1" of a depth instruction reaches the grammar as a bare
//     unit. That text carries no build at all, so the line is backlog.
//   - the DECODER must read the whole build as exactly that one piece. Without
//     this, "3S+2S+1S" (HC-SO-001472) qualifies on the letters alone — it is a
//     three-sofa suite whose 1S line is correct for a different reason.
//
// The remark is deliberately NOT consulted. It is free text, it is what puts a
// line in the placeholder branch in the first place, and other work rewrites it.

/** The Desc2 writes a one-seater: "1S", "1 S", "1S/…", "1 SEATER". Never "1SEAT2". */
export const SAYS_ONE_SEATER = /(^|[^0-9A-Za-z])1\s?S(?:EATER)?(?![A-Za-z])/i;

/**
 * @param {string|null|undefined} d2  the AutoCount Desc2 as the row holds it
 * @param {{ pieces: string[], conf: string }} ps  the result of parseSofa over that Desc2
 */
export function isSingleSeatBuild(d2, ps) {
  if (!SAYS_ONE_SEATER.test(String(d2 || ""))) return false;
  if (!ps || ps.conf === "low") return false;
  return ps.pieces.length === 1 && String(ps.pieces[0]).trim().toUpperCase() === "1S";
}
