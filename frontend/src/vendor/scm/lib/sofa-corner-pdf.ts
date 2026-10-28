// ----------------------------------------------------------------------------
// sofa-corner-pdf — a corner sofa drawn as ONE connected L, for the PO sheet.
//
// PORTED FROM POS at the owner's instruction, 2026-08-28. Source:
// wenwei4046/2990s, apps/pos/src/lib/sofa-corner.tsx. Its header states the
// reason plainly and it is not cosmetic: "A corner sofa (corner + 2/3-seater +
// 1-seater chaise) has NO single composite PNG, and tiling the three per-module
// PNGs leaves a STEP + an INTERNAL ARM." The supplier reads that step as a real
// gap and the internal arm as a real arm — on a document whose entire job is to
// stop the sofa being built mirror-reversed or in the wrong pieces.
//
// TWO HALVES, AND ONLY THE SECOND IS NEW WORK.
//   · `cornerCompositeFromCells` is POS's detector, transcribed. Pure geometry,
//     including the un-rotation trick that lets it decide which side the chaise
//     drops under any of the four group rotations. Returning null for anything
//     that is not a clean three-piece L is what keeps the per-module tiling path
//     in charge of everything else.
//   · the renderer re-emits POS's SVG as jsPDF primitives. Same four colours,
//     same proportions (every inset is a fraction of ART_BODY_UNITS), same
//     order of drawing — outline, backrest band, ends, module boundaries,
//     cushion seams — because the order is what makes the band sit behind the
//     seat and the bench overlay the band.
//
// THE ONE THING THAT COULD NOT BE COPIED VERBATIM is the L outline. POS emits a
// single SVG path with quadratic corners; jsPDF has no path builder this repo
// can rely on, so the same shape is drawn with `lines()` using cubic segments —
// a quadratic control point converted to two cubic ones exactly (P1 + 2/3(Q-P1),
// P2 + 2/3(Q-P2)), not eyeballed. The rounded corners are convex-only and the
// inner bend stays sharp, which is what makes it read as an L rather than a
// rounded rectangle.
// ----------------------------------------------------------------------------
import {
  cellBbox,
  cellsBbox,
  findModule,
  moduleFootprint,
  type Bbox,
  type Cell,
  type Depth,
  type Rot,
} from '@2990s/shared';

/* POS's palette, byte-for-byte — the two surfaces must not drift into two
   slightly different creams. */
const SOFA_SEAT: [number, number, number] = [0xF0, 0xE6, 0xD6];
const SOFA_BAND: [number, number, number] = [0xD9, 0xC2, 0xA0];
const SOFA_ARM: [number, number, number] = [0xB8, 0x99, 0x72];
const SOFA_INK: [number, number, number] = [0x2C, 0x2C, 0x2A];
/** Module-art body height; every inset below is a fraction of it. POS's. */
const ART_BODY_UNITS = 70;

/** 1B / 2B are the WIDE-ARM ("bench") variants — a soft rounded bench cushion
 *  instead of a hard armrest. Kept when the piece joins a corner so the joined
 *  drawing matches the separate per-module art. POS's rule, POS's regex. */
export const isBenchModule = (id: string): boolean => /^[12]B\(/.test(id);

export interface CornerGeo {
  W: number;
  H: number;
  T: number;
  cornerW: number;
  twoW: number;
  twoCushions: number;
  orientation: 'left' | 'right';
  longArmBench: boolean;
  chaiseBench: boolean;
}

/** Un-rotate a screen-frame vector back to the sofa's natural frame. */
const unrotateVec = (dx: number, dy: number, rot: number): { x: number; y: number } => {
  const r = ((rot % 360) + 360) % 360;
  if (r === 90) return { x: dy, y: -dx };
  if (r === 180) return { x: -dx, y: -dy };
  if (r === 270) return { x: -dy, y: dx };
  return { x: dx, y: dy };
};

/**
 * Recognise a corner sofa from laid-out cells and derive its natural-frame L
 * geometry, the group bbox and the group rotation. Null for anything that is
 * not a clean three-piece L — the caller then keeps tiling per module.
 */
export const cornerCompositeFromCells = (
  cells: Cell[],
  depth: Depth,
): { geo: CornerGeo; bb: Bbox; rot: Rot } | null => {
  if (cells.length !== 3) return null;
  const byGroup = (g: string) => cells.find((c) => findModule(c.moduleId)?.group === g);
  const cnr = byGroup('Corner');
  const two = byGroup('2-seater') ?? byGroup('3-seater');
  const one = byGroup('1-seater');
  if (!cnr || !two || !one) return null;
  const cnrM = findModule(cnr.moduleId);
  const twoM = findModule(two.moduleId);
  const oneM = findModule(one.moduleId);
  if (!cnrM || !twoM || !oneM) return null;

  /* The joined corner is REDRAWN from geometry, so only the bar's and the
     chaise's rotations matter — the corner piece's own is irrelevant. */
  const groupRot = two.rot;
  const chaiseRel = (((one.rot - groupRot) % 360) + 360) % 360;
  if (chaiseRel !== 90 && chaiseRel !== 270) return null;

  const bbC = cellBbox(cnr, depth);
  const bbA = cellBbox(two, depth);
  const bbH = cellBbox(one, depth);
  if (!bbC || !bbA || !bbH) return null;
  const ctr = (b: Bbox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const cc = ctr(bbC);
  const ca = ctr(bbA);
  const ch = ctr(bbH);
  const armN = unrotateVec(ca.x - cc.x, ca.y - cc.y, groupRot);
  const chaN = unrotateVec(ch.x - cc.x, ch.y - cc.y, groupRot);
  // Not a clean top-bar + down-leg L.
  if (chaN.y <= 0 || Math.abs(armN.x) < 1) return null;

  const cnrFp = moduleFootprint(cnrM, 0, depth);
  const twoW = moduleFootprint(twoM, 0, depth).w;
  const legLen = moduleFootprint(oneM, 0, depth).w; // seat width → chaise leg length
  const bb = cellsBbox(cells, depth);
  if (!bb) return null;

  return {
    geo: {
      W: cnrFp.w + twoW,
      H: cnrFp.h + legLen,
      T: cnrFp.h,
      cornerW: cnrFp.w,
      twoW,
      twoCushions: Math.max(1, twoM.cushions),
      orientation: armN.x > 0 ? 'left' : 'right',
      longArmBench: isBenchModule(two.moduleId),
      chaiseBench: isBenchModule(one.moduleId),
    },
    bb,
    rot: groupRot as Rot,
  };
};

type Doc = {
  setFillColor: (r: number, g: number, b: number) => unknown;
  setDrawColor: (r: number, g: number, b: number) => unknown;
  setLineWidth: (w: number) => unknown;
  rect: (x: number, y: number, w: number, h: number, style?: string) => unknown;
  roundedRect: (x: number, y: number, w: number, h: number, rx: number, ry: number, style?: string) => unknown;
  line: (x1: number, y1: number, x2: number, y2: number) => unknown;
  lines: (
    lines: number[][], x: number, y: number, scale?: [number, number],
    style?: string, closed?: boolean,
  ) => unknown;
  setLineDashPattern?: (pattern: number[], phase: number) => unknown;
};

/** A quadratic Bézier as jsPDF's relative cubic segment (6 numbers). */
const quadRel = (
  from: [number, number], ctrl: [number, number], to: [number, number],
): number[] => {
  const c1x = (2 / 3) * (ctrl[0] - from[0]);
  const c1y = (2 / 3) * (ctrl[1] - from[1]);
  const c2x = (to[0] - from[0]) + (2 / 3) * (ctrl[0] - to[0]);
  const c2y = (to[1] - from[1]) + (2 / 3) * (ctrl[1] - to[1]);
  return [c1x, c1y, c2x, c2y, to[0] - from[0], to[1] - from[1]];
};

/**
 * Draw the connected L at (x, y) scaled to (drawW × drawH) mm.
 *
 * `geo` is in the sofa's NATURAL frame (chaise dropping down). A rotated group
 * is handled by the caller swapping its box, exactly as POS CSS-rotates the SVG:
 * this function always draws the natural orientation.
 */
export function drawCornerSofa(
  doc: Doc,
  geo: CornerGeo,
  x: number,
  y: number,
  drawW: number,
  drawH: number,
): void {
  const { W, H, T, cornerW, twoCushions, orientation, longArmBench, chaiseBench } = geo;
  if (!(W > 0) || !(H > 0) || !(drawW > 0) || !(drawH > 0)) return;
  const sx = drawW / W;
  const sy = drawH / H;
  const PX = (v: number) => x + v * sx;
  const PY = (v: number) => y + v * sy;

  const u = T / ART_BODY_UNITS;
  const armW = 11 * u;
  const bandH = 11 * u;
  const rx = 3 * u;
  const benchThick = 20 * u;
  const benchInset = 2 * u;
  const benchRx = 5 * u;
  /* Stroke widths are in mm and must NOT be scaled by the sofa's cm scale —
     POS's are in SVG user units because its viewBox scales with the box. A
     hairline that scaled would vanish on a small plan. */
  const swOuter = 0.35;
  const swInner = 0.2;
  const swDash = 0.15;

  const colW = cornerW;
  const left = orientation === 'left';

  /* ── The L outline. Convex corners rounded, the inner bend sharp. ────────
     Written as POS writes it — corner-by-corner in the same order — so the two
     can be compared line for line. */
  const P = (cx: number, cy: number): [number, number] => [PX(cx), PY(cy)];
  const segs: number[][] = [];
  let cur: [number, number];
  const lineTo = (p: [number, number]) => { segs.push([p[0] - cur[0], p[1] - cur[1]]); cur = p; };
  const curveTo = (ctrl: [number, number], to: [number, number]) => {
    segs.push(quadRel(cur, ctrl, to)); cur = to;
  };

  const start = P(rx, 0);
  cur = start;
  if (left) {
    lineTo(P(W - rx, 0));
    curveTo(P(W, 0), P(W, rx));
    lineTo(P(W, T - rx));
    curveTo(P(W, T), P(W - rx, T));
    lineTo(P(colW, T));
    lineTo(P(colW, H - rx));
    curveTo(P(colW, H), P(colW - rx, H));
    lineTo(P(rx, H));
    curveTo(P(0, H), P(0, H - rx));
    lineTo(P(0, rx));
    curveTo(P(0, 0), start);
  } else {
    lineTo(P(W - rx, 0));
    curveTo(P(W, 0), P(W, rx));
    lineTo(P(W, H - rx));
    curveTo(P(W, H), P(W - rx, H));
    lineTo(P(W - colW + rx, H));
    curveTo(P(W - colW, H), P(W - colW, H - rx));
    lineTo(P(W - colW, T));
    lineTo(P(rx, T));
    curveTo(P(0, T), P(0, T - rx));
    lineTo(P(0, rx));
    curveTo(P(0, 0), start);
  }
  doc.setFillColor(...SOFA_SEAT);
  doc.setDrawColor(...SOFA_INK);
  doc.setLineWidth(swOuter);
  doc.lines(segs, start[0], start[1], [1, 1], 'FD', true);

  /* ── Backrest band: the top edge AND the outer side edge — the corner wraps
        two edges, which is the whole point of a corner piece. */
  doc.setFillColor(...SOFA_BAND);
  doc.setLineWidth(swInner);
  doc.rect(PX(0), PY(0), W * sx, bandH * sy, 'FD');
  doc.rect(left ? PX(0) : PX(W - bandH), PY(0), bandH * sx, H * sy, 'FD');

  /* ── The two ends: a hard arm (1A/2A) or a wide rounded bench (1B/2B). */
  const endEl = (ex: number, ey: number, ew: number, eh: number, bench: boolean) => {
    if (bench) {
      doc.setFillColor(...SOFA_BAND);
      doc.roundedRect(
        PX(ex + benchInset), PY(ey + benchInset),
        (ew - 2 * benchInset) * sx, (eh - 2 * benchInset) * sy,
        benchRx * sx, benchRx * sy, 'FD',
      );
    } else {
      doc.setFillColor(...SOFA_ARM);
      doc.rect(PX(ex), PY(ey), ew * sx, eh * sy, 'FD');
    }
  };
  const laThick = longArmBench ? benchThick : armW;
  const chThick = chaiseBench ? benchThick : armW;
  if (left) {
    endEl(W - laThick, 0, laThick, T, longArmBench);
    endEl(0, H - chThick, colW, chThick, chaiseBench);
  } else {
    endEl(0, 0, laThick, T, longArmBench);
    endEl(W - colW, H - chThick, colW, chThick, chaiseBench);
  }

  /* ── Module boundaries (solid): corner|long-arm and corner|chaise. */
  doc.setDrawColor(...SOFA_INK);
  doc.setLineWidth(swInner);
  if (left) {
    doc.line(PX(cornerW), PY(0), PX(cornerW), PY(T));
    doc.line(PX(0), PY(T), PX(colW), PY(T));
  } else {
    doc.line(PX(W - cornerW), PY(0), PX(W - cornerW), PY(T));
    doc.line(PX(W - colW), PY(T), PX(W), PY(T));
  }

  /* ── Cushion seams (dashed) within the long arm. The dash is restored to
        solid afterwards: jsPDF's dash pattern is document state, and leaving it
        set would dash the next document's table rules. */
  const twoWmm = W - cornerW;
  doc.setLineWidth(swDash);
  doc.setLineDashPattern?.([2 * u * sx, 2 * u * sx], 0);
  for (let j = 1; j < twoCushions; j += 1) {
    const cx = left ? cornerW + (twoWmm * j) / twoCushions : (twoWmm * j) / twoCushions;
    doc.line(PX(cx), PY(0), PX(cx), PY(T));
  }
  doc.setLineDashPattern?.([], 0);
}
