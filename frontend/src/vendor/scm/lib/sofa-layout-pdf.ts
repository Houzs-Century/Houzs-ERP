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
  cellEdges,
  findModule,
  moduleFootprint,
  cellsBbox,
  groupSofas,
  type Cell,
  type Depth,
} from '@2990s/shared';
import { cornerCompositeFromCells, drawCornerSofa } from './sofa-corner-pdf';

type JsPdf = import('jspdf').jsPDF;

/** The motion variant a module code carries: "1A(P)(LHF)" → "P", "1NA(R)" →
 *  "R", "1S(L)" → "L" (Power / Recliner / Power leg). Only the FIRST paren
 *  group counts, so the chaise "L(LHF)" and a plain "1A(LHF)" return null. */
export function motionMark(moduleId: string): 'P' | 'R' | 'L' | null {
  const m = /^[^(]+\(([PRL])\)/.exec(moduleId);
  return m ? (m[1] as 'P' | 'R' | 'L') : null;
}

/** The seat depth a POS build's stored x/y were laid out at. Module widths grow
 *  with depth, so drawing the cells at another depth opens gaps (or overlaps)
 *  between pieces that touched on the canvas. The SO split drops the line's
 *  `depth` key in favour of `seatHeight`, and the two can disagree with the x/y
 *  (BUG-110, Sim 2026-10-13: 2990-SO-2610-037, laid out at 28", drew at the 24"
 *  default with a 20cm gap; -022 stores seatHeight 28 but its x/y and summary
 *  are 24"). Of the candidates,
 *  the one under which the cells join into the fewest sofas wins; ties keep
 *  candidate order. */
export function layoutDepth(cells: Cell[], candidates: ReadonlyArray<unknown>): Depth {
  const depths = [...new Set(
    candidates.map((d) => String(d ?? '').trim()).filter((d) => /^\d+$/.test(d)),
  )];
  if (depths.length === 0) return '24';
  let best = depths[0]!;
  let bestGroups = Infinity;
  for (const d of depths) {
    const n = groupSofas(cells, d).length;
    if (n < bestGroups) { best = d; bestGroups = n; }
  }
  return best;
}

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
  photos?: Record<string, string>,
): number {
  if (!Array.isArray(cells) || cells.length === 0) return 0;

  const bbox = cellsBbox(cells, depth);
  if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return 0;

  const TV_BLOCK = 6;

  const usableH = maxH - TV_BLOCK;
  if (usableH <= 1) return 0;

  const scale = Math.min(maxW / bbox.w, usableH / bbox.h);
  if (!(scale > 0) || !Number.isFinite(scale)) return 0;

  const sofaW = bbox.w * scale;
  const sofaH = bbox.h * scale;

  const ox = x + Math.max(0, (maxW - sofaW) / 2);
  const oy = y;

  const corner = cornerCompositeFromCells(cells, depth);
  if (corner) {
    const quarter = ((Math.round(corner.rot / 90) % 4) + 4) % 4;
    const swap = quarter === 1 || quarter === 3;
    drawCornerSofa(doc, corner.geo, ox, oy, swap ? sofaH : sofaW, swap ? sofaW : sofaH);
  } else {
  const artOk = cells.every((c) => ((Number(c.rot) || 0) % 360) === 0);
  const sofaBbox = new Map<Cell, { x: number; w: number }>();
  try {
    for (const g of groupSofas(cells, depth)) {
      const gb = cellsBbox(g, depth);
      if (gb) for (const c of g) sofaBbox.set(c, gb);
    }
  } catch {
  }
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
    /* THE MODULE'S OWN ART, placed the way POS places it (2026-08-28, owner:
       「跟着 POS 系统的做法做」). Two details are load-bearing and both come from
       apps/pos/src/components/SofaCellsPreview.tsx:

         · the art is CROPPED TO ITS SILHOUETTE before it gets here
           (sofa-compartment-art.ts). The files are 1024² with the drawing padded
           inside, so filling this rect with the raw file renders every module
           small with gaps between them — POS's own "2WC card bug".
         · the rect is the ROTATED footprint, and the rotation is already baked
           into the bitmap, because jsPDF has no rotate-about-centre this repo can
           rely on. POS rotates the DOM box instead; same result.

       Codes with no PNG twin — the (P)/(R)/(L) power variants and Console-WC —
       are absent from the map and fall through to the schematic below. POS does
       not tile those either; it draws them through renderSeamlessSofa, which is
       not ported yet. A drawn cell is visibly a drawing; a blank one would look
       like a missing module. */
    const art = artOk ? photos?.[c.moduleId] : undefined;
    if (art) {
      try {
        doc.addImage(art, px, py, w, h);
        continue;
      } catch {
      }
    }
    doc.setLineWidth(0.2);
    doc.setDrawColor(120);
    doc.setFillColor(244, 238, 226);
    doc.rect(px, py, w, h, 'FD');
    const t = Math.max(0.8, Math.min(h * 0.26, 2.4));
    const eps = 0.5;
    doc.setFillColor(196, 162, 110);
    if ((Number(c.rot) || 0) % 360 !== 0) {
      const [ew, en, ee, es] = cellEdges(c);
      const solid = (e: string | undefined) => e === 'back' || e === 'arm';
      if (solid(ew)) doc.rect(px, py, t, h, 'F');
      if (solid(en)) doc.rect(px, py, w, t, 'F');
      if (solid(ee)) doc.rect(px + w - t, py, t, h, 'F');
      if (solid(es)) doc.rect(px, py + h - t, w, t, 'F');
    } else {
      doc.rect(px, py, w, t, 'F');
      const sb = sofaBbox.get(c) ?? bbox;
      if (Math.abs(c.x - sb.x) < eps) doc.rect(px, py, t, h, 'F');
      if (Math.abs((c.x + fp.w) - (sb.x + sb.w)) < eps) doc.rect(px + w - t, py, t, h, 'F');
    }
    const mark = motionMark(c.moduleId);
    if (mark) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(Math.max(4, Math.min(14, (Math.min(w, h) - t) * 0.55 * 2.835)));
      doc.setTextColor(44, 44, 42);
      doc.text(mark, px + w / 2, py + h / 2, { align: 'center', baseline: 'middle' });
      doc.setTextColor(0);
    }
  }
  }

  const sofaBottom = oy + sofaH;
  const cx = ox + sofaW / 2;

  const triH = 1.8;
  const triHalf = 1.4;
  const triTopY = sofaBottom + 0.8;
  doc.setFillColor(60, 60, 60);
  doc.triangle(
    cx, triTopY,
    cx - triHalf, triTopY + triH,
    cx + triHalf, triTopY + triH,
    'F',
  );

  const tvW = Math.min(sofaW * 0.45, 14);
  const tvH = 2.4;
  const tvX = cx - tvW / 2;
  const tvY = triTopY + triH + 0.6;
  doc.setFillColor(60, 60, 60);
  doc.rect(tvX, tvY, tvW, tvH, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(5);
  doc.setTextColor(255);
  doc.text('TV', cx, tvY + tvH - 0.7, { align: 'center' });
  doc.setTextColor(0);

  return (tvY + tvH) - oy + 0.5;
}
