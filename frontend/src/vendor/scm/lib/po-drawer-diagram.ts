// DEV-74 (Sim 2026-10-13): a bedframe PO line with a drawer special prints a
// small top-view picture of the bed with an arrow on the pull-out side, so the
// supplier does not have to read LEFT / RIGHT / FRONT out of the specs text.
// Drawn with jsPDF lines, nothing to upload or store.
type JsPdf = import('jspdf').jsPDF;

export type DrawerSide = 'LEFT' | 'RIGHT' | 'FRONT';

/* The values the bedframe specials picker stores (mig 0022 / 0030 seeds). */
const DRAWER_RE = /^(left|right|front)\s+drawer$/i;

/** Drawer sides picked on a line, from `variants.specials` (string[] | string). */
export function drawerSidesOf(variants: Record<string, unknown> | null | undefined): DrawerSide[] {
  const raw = variants?.specials ?? variants?.special;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const sides = new Set<DrawerSide>();
  for (const s of list) {
    const m = String(s).trim().match(DRAWER_RE);
    if (m) sides.add(m[1]!.toUpperCase() as DrawerSide);
  }
  return (['LEFT', 'RIGHT', 'FRONT'] as const).filter((s) => sides.has(s));
}

/** Height (mm) the diagram needs below the description text. */
export const DRAWER_DIAGRAM_H = 18;

/* Bed seen from above, headboard (filled bar) at the top, foot at the bottom.
   LEFT / RIGHT are as seen standing at the foot facing the headboard. */
export function drawDrawerDiagram(doc: JsPdf, sides: DrawerSide[], x: number, y: number): void {
  const bw = 9, bh = 12, bx = x + 4, by = y + 1;
  const midY = by + bh / 2;
  doc.setDrawColor(0); doc.setFillColor(0, 0, 0); doc.setLineWidth(0.25);
  doc.rect(bx, by, bw, bh);
  doc.rect(bx, by, bw, 1.6, 'F');
  for (const side of sides) {
    if (side === 'LEFT') {
      doc.rect(bx + 0.6, midY - 2.5, 1.8, 5);
      doc.line(bx, midY, bx - 2.2, midY);
      doc.triangle(bx - 3.4, midY, bx - 2.2, midY - 0.9, bx - 2.2, midY + 0.9, 'F');
    } else if (side === 'RIGHT') {
      doc.rect(bx + bw - 2.4, midY - 2.5, 1.8, 5);
      doc.line(bx + bw, midY, bx + bw + 2.2, midY);
      doc.triangle(bx + bw + 3.4, midY, bx + bw + 2.2, midY - 0.9, bx + bw + 2.2, midY + 0.9, 'F');
    } else {
      const cx = bx + bw / 2, fy = by + bh;
      doc.rect(cx - 2.5, fy - 2.4, 5, 1.8);
      doc.line(cx, fy, cx, fy + 2.2);
      doc.triangle(cx, fy + 3.4, cx - 0.9, fy + 2.2, cx + 0.9, fy + 2.2, 'F');
    }
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(0);
  doc.text(`PULL OUT ${sides.join(' + ')}`, bx + bw + 5, midY + 1);
}
