// ----------------------------------------------------------------------------
// Delivery Order print theme — BLACK ON WHITE, ONE FACE, for a dot-matrix printer.
//
// Owner 2026-09-08: the DO is printed on an Epson LQ-310 (24-pin impact
// printer, black ribbon) onto 9.5 x 11 inch 2-ply continuous paper. On that
// printer the Theme C "Ink & Petrol" sheet this file used to describe came out
// unreadable, and each of its three devices was a cause, not a style choice:
//
//   · every grey ink (muted labels, faint placeholders, the green column
//     headers) is DITHERED by the driver into a speckle of dots — there is no
//     grey ribbon — and the second carbonless ply gets a fainter copy of the
//     speckle;
//   · every pale fill (the paper panel, the brass doc-number chip, the teal
//     status chip, the rounded header band) prints as a field of dots UNDER
//     the text, which is the one thing an impact printer cannot make legible;
//   · the courier / helvetica mix set most of the small text in a thin
//     typewriter face at 7.5–9pt, below what 24 pins at 180dpi can form.
//
// So the palette is one colour and no fills, the face is one family, and the
// sizes below are the whole scale — every draw call reads from here, so the
// floor the test pins (nothing under DO_SIZE.min) is a fact about the sheet.
// ----------------------------------------------------------------------------

export type Rgb = [number, number, number];

/** mm per point — jsPDF documents here are created with unit: 'mm', while every
 *  font size (and setFontSize) is in points. */
export const PT = 25.4 / 72;

/** Points → mm. */
export const pt = (points: number): number => points * PT;

/** CSS `letter-spacing: <em>` → jsPDF's charSpace, which is in the document's
 *  unit (mm here), not em. */
export const charSpace = (sizePt: number, em: number): number => pt(sizePt) * em;

export const DO_THEME = {
  ink: [0, 0, 0] as Rgb,
  line: [0, 0, 0] as Rgb,
} as const;

/**
 * The type scale, in points. One family (SANS) at these sizes and nothing
 * else — "字体统一" (owner 2026-09-08). `min` is the floor the template test
 * holds every setFontSize call to; a size added below it fails the test rather
 * than printing as a smudge on the second ply.
 */
export const DO_SIZE = {
  min: 9,
  title: 18,
  docNo: 13,
  company: 15,
  meta: 10,
  caption: 10,
  customer: 13,
  body: 10.5,
  tableHead: 9.5,
  tableFoot: 10.5,
  sigTitle: 11,
  sigField: 10,
  footer: 9,
} as const;

/**
 * jsPDF ships helvetica / times / courier and nothing else. Helvetica is the
 * ONE family the DO uses, and it is also the family ensurePdfCjkFont redirects
 * onto the embedded CJK subset — so a Chinese address paints correctly in every
 * cell, which the old courier identifier columns could not promise.
 */
export const SANS = 'helvetica';
