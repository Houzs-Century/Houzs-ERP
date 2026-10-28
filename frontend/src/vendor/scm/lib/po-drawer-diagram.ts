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

/* Sim 2026-10-16: a Single / Super Single bed is too narrow for two front
   drawers. Bedframe SKUs end in their size code, `{model_code}-({size_code})`. */
const NARROW_SIZE_RE = /\((S|SS)\)\s*$/i;

export function frontDrawerCountOf(itemCode: string | null | undefined): 1 | 2 {
  return NARROW_SIZE_RE.test(itemCode ?? '') ? 1 : 2;
}

/** Height (mm) the diagram needs below the description text. */
export const DRAWER_DIAGRAM_H = 18;

/* Bed seen from above, headboard (filled bar) at the top, foot at the bottom.
   LEFT / RIGHT are as seen standing at the foot facing the headboard.
   HC-0112 (Sim 2026-10-16): each drawer side is drawn as TWO drawers, each with
   its own arrow, and labelled LEFT / RIGHT / FRONT DRAWER. A single drawer made
   suppliers build one drawer, and "PULL OUT LEFT" is the trundle bed wording.
   The front gets one drawer only on a narrow bed (frontDrawerCountOf). */
export function drawDrawerDiagram(
  doc: JsPdf, sides: DrawerSide[], x: number, y: number, frontDrawers: 1 | 2 = 2,
): void {
  const bw = 9, bh = 12, bx = x + 4, by = y + 1;
  const sideYs = [by + 2.6, by + 7.2];
  const footW = frontDrawers === 1 ? 5 : 3.3;
  const footXs = frontDrawers === 1 ? [bx + (bw - footW) / 2] : [bx + 0.6, bx + bw / 2 + 0.6];
  doc.setDrawColor(0); doc.setFillColor(0, 0, 0); doc.setLineWidth(0.25);
  doc.rect(bx, by, bw, bh);
  doc.rect(bx, by, bw, 1.6, 'F');
  for (const side of sides) {
    if (side === 'LEFT') {
      for (const dy of sideYs) {
        const my = dy + 1.7;
        doc.rect(bx + 0.6, dy, 1.8, 3.4);
        doc.line(bx, my, bx - 2.2, my);
        doc.triangle(bx - 3.4, my, bx - 2.2, my - 0.9, bx - 2.2, my + 0.9, 'F');
      }
    } else if (side === 'RIGHT') {
      for (const dy of sideYs) {
        const my = dy + 1.7;
        doc.rect(bx + bw - 2.4, dy, 1.8, 3.4);
        doc.line(bx + bw, my, bx + bw + 2.2, my);
        doc.triangle(bx + bw + 3.4, my, bx + bw + 2.2, my - 0.9, bx + bw + 2.2, my + 0.9, 'F');
      }
    } else {
      const fy = by + bh;
      for (const dx of footXs) {
        const mx = dx + footW / 2;
        doc.rect(dx, fy - 2.4, footW, 1.8);
        doc.line(mx, fy, mx, fy + 2.2);
        doc.triangle(mx, fy + 3.4, mx - 0.9, fy + 2.2, mx + 0.9, fy + 2.2, 'F');
      }
    }
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(0);
  const labels = sides.map((s) => `${s} DRAWER`);
  doc.text(labels, bx + bw + 5, by + bh / 2 + 1 - (labels.length - 1) * 1.5, { lineHeightFactor: 1.2 });
}
