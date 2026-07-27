// ----------------------------------------------------------------------------
// Sofa layout schematic for the Purchase Order PDF (owner 2026-06-23).
//
// A SMALL top-down plan-view of a configured sofa, drawn with plain jsPDF
// vector primitives — NO image / canvas / sharp. The goal is DIRECTION: the
// supplier sees which side the chaise / L sits on (LHF vs RHF) and which way
// the sofa faces the TV, so they don't build it mirror-reversed. The LHF/RHF
// text already prints in the line Description; this is a visual cross-check.
//
// Coordinate convention (matches apps/pos CustomBuilder EXACTLY):
//   - cells use cm; the top-left corner of a cell's footprint is (cell.x,
//     cell.y); x increases RIGHTWARD, y increases DOWNWARD.
//   - moduleFootprint(module, rot, depth) already bakes the rotation (swaps
//     w/h for 90/270), so a cell rect is simply {x, y, footprint.w,
//     footprint.h} — no extra rotation math. CustomBuilder draws each cell at
//     `left: cell.x*SCALE, top: cell.y*SCALE, width: fp.w*SCALE,
//     height: fp.h*SCALE`; we reproduce that 1:1 in mm.
//   - the sofa FRONT faces +y (downward, toward the TV at the bottom). So the
//     TV marker is drawn BELOW the sofa with an up-pointing triangle between
//     them — same as CustomBuilder's bottom-center TV + up beam.
//
// Because positions are faithful, the L-side and LHF·RHF orientation come out
// correct automatically — getting direction right is the whole point.
// ----------------------------------------------------------------------------

import {
  findModule,
  moduleFootprint,
  cellsBbox,
  type Cell,
  type Depth,
} from '@2990s/shared';

type JsPdf = import('jspdf').jsPDF;

/**
 * Draw a small top-down sofa schematic at (x, y) within (maxW × maxH) mm.
 * Returns the height (mm) actually drawn (sofa + TV block + dims caption).
 *
 * Pure vector primitives only. Fail-soft: malformed / empty / unmeasurable
 * cells draw nothing and return 0 (never throws inside PDF generation).
 */
export function drawSofaLayout(
  doc: JsPdf,
  cells: Cell[],
  depth: Depth,
  x: number,
  y: number,
  maxW: number,
  maxH: number,
): number {
  if (!Array.isArray(cells) || cells.length === 0) return 0;

  // Union bbox in cm (rotation-aware footprints). Null = no measurable cell.
  const bbox = cellsBbox(cells, depth);
  if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return 0;

  // Reserve a small block under the sofa for the TV marker + the up-triangle.
  const TV_BLOCK = 6;   // mm — gap + triangle + TV rect + "TV" label

  const usableH = maxH - TV_BLOCK;
  if (usableH <= 1) return 0;

  // Scale so the sofa + TV block fit the box. cm → mm.
  const scale = Math.min(maxW / bbox.w, usableH / bbox.h);
  if (!(scale > 0) || !Number.isFinite(scale)) return 0;

  const sofaW = bbox.w * scale;
  const sofaH = bbox.h * scale;

  // Centre the sofa horizontally within maxW.
  const ox = x + Math.max(0, (maxW - sofaW) / 2);
  const oy = y;

  // ── Cells: each module = a cream SEAT with a tan BACKREST strip on its back
  //    edge (the side away from the TV — the whole sofa faces the TV at the
  //    bottom/+y). Faithful positions → the L-shape notch + LHF/RHF come out
  //    automatically. NO outer union outline: that boxed an L-shape back into a
  //    rectangle (owner: "看起来整个是长方形").
  for (const c of cells) {
    if (!c || typeof c.moduleId !== 'string') continue;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const m = findModule(c.moduleId);
    if (!m) continue;
    const fp = moduleFootprint(m, c.rot, depth);
    if (!(fp.w > 0) || !(fp.h > 0)) continue;
    const px = ox + (c.x - bbox.x) * scale;
    const py = oy + (c.y - bbox.y) * scale;
    const w = fp.w * scale;
    const h = fp.h * scale;
    // Seat — cream fill + thin border.
    doc.setLineWidth(0.2);
    doc.setDrawColor(120);
    doc.setFillColor(244, 238, 226);
    doc.rect(px, py, w, h, 'FD');
    // Backrest + outer ARMS — tan strips forming a U-frame (back on top, arms on
    // the sofa's exposed outer left/right edges), open at the FRONT (toward the
    // TV). Arms only land on outer edges (a cell flush with the union's min/max
    // x), so an L-shape and LHF/RHF read correctly.
    const t = Math.max(0.8, Math.min(h * 0.26, 2.4)); // strip thickness (mm)
    const eps = 0.5; // cm tolerance
    doc.setFillColor(196, 162, 110); // tan
    doc.rect(px, py, w, t, 'F'); // backrest (top / back)
    if (Math.abs(c.x - bbox.x) < eps) doc.rect(px, py, t, h, 'F'); // left arm
    if (Math.abs((c.x + fp.w) - (bbox.x + bbox.w)) < eps) doc.rect(px + w - t, py, t, h, 'F'); // right arm
  }

  // ── TV marker BELOW the sofa (greater y = front / viewing direction) ─
  // Small filled triangle pointing UP (toward the sofa), then a dark TV rect
  // centred under the sofa, then the "TV" label.
  const sofaBottom = oy + sofaH;
  const cx = ox + sofaW / 2;

  // Up-pointing triangle just below the sofa front edge.
  const triH = 1.8;
  const triHalf = 1.4;
  const triTopY = sofaBottom + 0.8;            // apex (points up toward sofa)
  doc.setFillColor(60, 60, 60);
  doc.triangle(
    cx, triTopY,                                // apex (up)
    cx - triHalf, triTopY + triH,               // bottom-left
    cx + triHalf, triTopY + triH,               // bottom-right
    'F',
  );

  // Dark TV rect centred under the sofa.
  const tvW = Math.min(sofaW * 0.45, 14);
  const tvH = 2.4;
  const tvX = cx - tvW / 2;
  const tvY = triTopY + triH + 0.6;
  doc.setFillColor(60, 60, 60);
  doc.rect(tvX, tvY, tvW, tvH, 'F');

  // "TV" label centred inside the dark rect (white text).
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(5);
  doc.setTextColor(255);
  doc.text('TV', cx, tvY + tvH - 0.7, { align: 'center' });
  doc.setTextColor(0);

  // Total drawn height: top of sofa → TV block bottom (no dims caption).
  return (tvY + tvH) - oy + 0.5;
}
