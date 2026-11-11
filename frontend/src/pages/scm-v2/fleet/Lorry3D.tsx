// The lorry drawn in 3D to its own container size (owner 2026-11-07, the Coverage & Fleet
// design): a fixed cab, the container to scale, drag to turn and tilt, double-click to reset.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

export type LorryBox = { length: number; width: number; height: number };

type V3 = [number, number, number];
type V2 = [number, number];
type Item = { pts?: V3[]; segs?: V3[][]; close?: boolean; style: CSSProperties };
type Group = { depth: number; items: Item[] };

const VIEW_W = 360;
const VIEW_H = 220;
const DEFAULT_YAW = -32;
const DEFAULT_PITCH = 20;
const MIN_PITCH = -10;
const MAX_PITCH = 80;

// One scale (px per ft) for every lorry, so two drawings compare honestly.
// It only shrinks when a lorry would not fit the drawing.
const SCALE = 9;

// The cab is a fixed size; only the container follows the entered size.
const CAB = { length: 5.4, width: 6.2, bottom: 1.3, top: 7.6 };
const FLOOR = 2.6;
const GAP = 0.6;
const WHEEL_R = 1.35;

const GREEN = '#16695f';
const GREEN_DARK = '#0b4740';

const clampPitch = (p: number) => Math.max(MIN_PITCH, Math.min(MAX_PITCH, p));
const fmt = (n: number) => String(Math.round(n * 10) / 10);
const tint = (t: number) => {
  const f = (hi: number) => Math.round(255 + (hi - 255) * t);
  return `rgb(${f(22)},${f(105)},${f(95)})`;
};

type Built = {
  ok: boolean;
  paths: { d: string; style: CSSProperties }[];
  dims: { line: string; ext: string }[];
  labels: { x: number; y: number; text: string }[];
};

function buildLorry(box: LorryBox | null, yaw: number, pitch: number): Built {
  const b = box && box.length > 0 && box.width > 0 && box.height > 0 ? box : null;
  const ok = b != null;
  const texts = b
    ? [`L ${fmt(b.length)} ft`, `W ${fmt(b.width)} ft`, `H ${fmt(b.height)} ft`]
    : ['L ?', 'W ?', 'H ?'];
  const L = Math.min(b ? b.length : 14, 40);
  const W = Math.min(b ? b.width : 6.5, 10);
  const H = Math.min(b ? b.height : 7, 12);

  const c = FLOOR;
  const x1 = L + GAP;
  const x2 = x1 + CAB.length;
  const zm = W / 2;
  const cz0 = zm - CAB.width / 2;
  const cz1 = zm + CAB.width / 2;
  const a = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cp = Math.cos(p), sp = Math.sin(p);
  const ox = (x2 - 0.3) / 2, oy = (c + H) / 2, oz = zm;

  const rotV = (x: number, y: number, z: number): V3 => {
    const xr = x * ca + z * sa;
    const z1 = -x * sa + z * ca;
    return [xr, y * cp - z1 * sp, y * sp + z1 * cp];
  };
  const rot = (v: V3): V3 => rotV(v[0] - ox, v[1] - oy, v[2] - oz);
  const light: V3 = [-0.45, 0.75, 0.5];
  const ll = Math.hypot(light[0], light[1], light[2]);

  const groups: Group[] = [];
  let cur: Group | null = null;

  type Kind = 'shadow' | 'box' | 'cab' | 'dark' | 'wheel';
  const face = (pts: V3[], n: V3, kind: Kind, bias = 0): boolean => {
    const nr = rotV(n[0], n[1], n[2]);
    if (kind !== 'shadow' && nr[2] <= 0.0001) { cur = null; return false; }
    const R = pts.map(rot);
    const lam = Math.max(0, (nr[0] * light[0] + nr[1] * light[1] + nr[2] * light[2]) / ll);
    let style: CSSProperties;
    if (kind === 'shadow') style = { fill: '#1d2624', opacity: 0.07, stroke: 'none' };
    else if (kind === 'box') style = ok
      ? { fill: tint(0.04 + 0.26 * (1 - lam)), stroke: GREEN, strokeWidth: 1.3, strokeLinejoin: 'round' }
      : { fill: tint(0.04 + 0.26 * (1 - lam)), fillOpacity: 0.55, stroke: GREEN, strokeWidth: 1.3, strokeLinejoin: 'round', strokeDasharray: '5 4' };
    else if (kind === 'cab') style = { fill: tint(0.74 + 0.26 * (1 - lam)), stroke: GREEN_DARK, strokeWidth: 1, strokeLinejoin: 'round' };
    else if (kind === 'dark') style = { fill: lam > 0.5 ? '#3d4442' : '#2a2f2e', stroke: '#161a19', strokeWidth: 0.7, strokeLinejoin: 'round' };
    else style = { fill: '#1b1f1e', stroke: '#000', strokeWidth: 0.6 };
    const depth = kind === 'shadow' ? -1e6 + groups.length : R.reduce((m, r) => m + r[2], 0) / R.length + bias;
    const g: Group = { depth, items: [{ pts: R, close: true, style }] };
    groups.push(g);
    cur = g;
    return true;
  };
  const decal = (pts: V3[], style: CSSProperties) => { if (cur) cur.items.push({ pts: pts.map(rot), close: true, style }); };
  const lines = (segs: V3[][], style: CSSProperties) => { if (cur) cur.items.push({ segs: segs.map((s) => s.map(rot)), style }); };
  const cuboid = (a0: number, a1: number, b0: number, b1: number, z0: number, z1: number, kind: Kind, noTop = false) => {
    face([[a0, b0, z1], [a1, b0, z1], [a1, b1, z1], [a0, b1, z1]], [0, 0, 1], kind);
    face([[a0, b0, z0], [a0, b1, z0], [a1, b1, z0], [a1, b0, z0]], [0, 0, -1], kind);
    if (!noTop) face([[a0, b1, z0], [a0, b1, z1], [a1, b1, z1], [a1, b1, z0]], [0, 1, 0], kind);
    face([[a0, b0, z0], [a1, b0, z0], [a1, b0, z1], [a0, b0, z1]], [0, -1, 0], kind);
    face([[a1, b0, z0], [a1, b1, z0], [a1, b1, z1], [a1, b0, z1]], [1, 0, 0], kind);
    face([[a0, b0, z0], [a0, b0, z1], [a0, b1, z1], [a0, b1, z0]], [-1, 0, 0], kind);
  };
  const ellipse = (cx: number, cz: number, rx: number, rz: number): V3[] =>
    Array.from({ length: 28 }, (_, k) => {
      const t = (k / 28) * Math.PI * 2;
      return [cx + Math.cos(t) * rx, 0, cz + Math.sin(t) * rz] as V3;
    });

  face(ellipse((x2 - 0.3) / 2, zm, (x2 + 2.2) / 2, W / 2 + 1.6), [0, 1, 0], 'shadow');
  face(ellipse((x2 - 0.3) / 2, zm, (x2 + 0.6) / 2, W / 2 + 0.6), [0, 1, 0], 'shadow');

  const ribStyle: CSSProperties = { fill: 'none', stroke: GREEN, strokeOpacity: 0.38, strokeWidth: 0.9 };
  const doorStyle: CSSProperties = { fill: 'none', stroke: GREEN, strokeWidth: 1 };
  const barStyle: CSSProperties = { fill: 'none', stroke: GREEN_DARK, strokeWidth: 1.5, strokeLinecap: 'round' };
  const glassStyle: CSSProperties = { fill: '#23403c', stroke: GREEN_DARK, strokeWidth: 0.8, strokeLinejoin: 'round' };
  const sideRibs = (z: number) => {
    if (!ok) return;
    const segs: V3[][] = [];
    const n = Math.max(3, Math.round((L - 1) / 1.1));
    for (let k = 0; k <= n; k++) {
      const x = 0.5 + ((L - 1) * k) / n;
      segs.push([[x, c + 0.3, z], [x, c + H - 0.35, z]]);
    }
    segs.push([[0.15, c + H - 0.3, z], [L - 0.15, c + H - 0.3, z]]);
    segs.push([[0.15, c + 0.3, z], [L - 0.15, c + 0.3, z]]);
    lines(segs, ribStyle);
  };

  // chassis rails: the part under the container has no top, so it never paints over the floor
  cuboid(-0.3, L, c - 0.5, c, zm - 1.5, zm + 1.5, 'dark', true);
  cuboid(L, x1 + 0.4, c - 0.5, c - 0.08, zm - 1.5, zm + 1.5, 'dark');

  // container
  if (face([[0, c, W], [L, c, W], [L, c + H, W], [0, c + H, W]], [0, 0, 1], 'box')) sideRibs(W);
  if (face([[0, c, 0], [0, c + H, 0], [L, c + H, 0], [L, c, 0]], [0, 0, -1], 'box')) sideRibs(0);
  if (face([[0, c + H, 0], [0, c + H, W], [L, c + H, W], [L, c + H, 0]], [0, 1, 0], 'box') && ok) {
    decal([[0.2, c + H, 0.2], [0.2, c + H, W - 0.2], [L - 0.2, c + H, W - 0.2], [L - 0.2, c + H, 0.2]], ribStyle);
  }
  face([[0, c, 0], [L, c, 0], [L, c, W], [0, c, W]], [0, -1, 0], 'box');
  face([[L, c, 0], [L, c + H, 0], [L, c + H, W], [L, c, W]], [1, 0, 0], 'box');
  if (face([[0, c, 0], [0, c, W], [0, c + H, W], [0, c + H, 0]], [-1, 0, 0], 'box') && ok) {
    decal([[0, c + 0.25, 0.25], [0, c + 0.25, W - 0.25], [0, c + H - 0.3, W - 0.25], [0, c + H - 0.3, 0.25]], doorStyle);
    const doors: V3[][] = [[[0, c + 0.25, zm], [0, c + H - 0.3, zm]]];
    const bars: V3[][] = [];
    for (const f of [0.2, 0.4, 0.6, 0.8]) {
      const z = W * f;
      bars.push([[0, c + 0.45, z], [0, c + H - 0.5, z]]);
      bars.push([[0, c + H * 0.45, z], [0, c + H * 0.45, z + (f < 0.5 ? 0.35 : -0.35)]]);
    }
    for (const f of [0.18, 0.5, 0.82]) {
      const y = c + H * f;
      doors.push([[0, y - 0.18, 0.25], [0, y - 0.18, 0.5], [0, y + 0.18, 0.5], [0, y + 0.18, 0.25]]);
      doors.push([[0, y - 0.18, W - 0.25], [0, y - 0.18, W - 0.5], [0, y + 0.18, W - 0.5], [0, y + 0.18, W - 0.25]]);
    }
    lines(doors, doorStyle);
    lines(bars, barStyle);
  }

  // cab-over cab: flat front, small roof bevel
  const prof: V2[] = [[x1, CAB.bottom], [x2, CAB.bottom], [x2, CAB.top - 0.35], [x2 - 0.35, CAB.top], [x1, CAB.top]];
  const capDetails = (z: number) => {
    decal([[x2 - 2.3, 4.9, z], [x2 - 0.35, 4.9, z], [x2 - 0.35, 6.95, z], [x2 - 2.3, 6.95, z]], glassStyle);
    lines([
      [[x2 - 2.6, CAB.bottom + 0.2, z], [x2 - 2.6, CAB.top - 0.25, z]],
      [[x2 - 2.35, 4.35, z], [x2 - 1.85, 4.35, z]],
      [[x2 - 2.6, 4.75, z], [x2 - 0.2, 4.75, z]],
    ], { fill: 'none', stroke: '#0b3b35', strokeWidth: 1 });
    decal([[x2 - 2.3, CAB.bottom - 0.45, z], [x2 - 0.9, CAB.bottom - 0.45, z], [x2 - 0.9, CAB.bottom - 0.15, z], [x2 - 2.3, CAB.bottom - 0.15, z]],
      { fill: '#2a2f2e', stroke: '#161a19', strokeWidth: 0.6 });
  };
  if (face(prof.map((q) => [q[0], q[1], cz1] as V3), [0, 0, 1], 'cab')) capDetails(cz1);
  if (face(prof.slice().reverse().map((q) => [q[0], q[1], cz0] as V3), [0, 0, -1], 'cab')) capDetails(cz0);
  for (let i = 0; i < prof.length; i++) {
    const P = prof[i], Q = prof[(i + 1) % prof.length];
    const dx = Q[0] - P[0], dy = Q[1] - P[1], nl = Math.hypot(dx, dy);
    const shown = face([[P[0], P[1], cz0], [Q[0], Q[1], cz0], [Q[0], Q[1], cz1], [P[0], P[1], cz1]], [dy / nl, -dx / nl, 0], 'cab');
    if (shown && i === 1) {
      const lamp: CSSProperties = { fill: '#f4efd9', stroke: '#0b3b35', strokeWidth: 0.7 };
      decal([[x2, 4.85, cz0 + 0.3], [x2, 4.85, cz1 - 0.3], [x2, 7.0, cz1 - 0.3], [x2, 7.0, cz0 + 0.3]], glassStyle);
      decal([[x2, 2.0, cz0 + 0.3], [x2, 2.0, cz0 + 1.2], [x2, 2.55, cz0 + 1.2], [x2, 2.55, cz0 + 0.3]], lamp);
      decal([[x2, 2.0, cz1 - 1.2], [x2, 2.0, cz1 - 0.3], [x2, 2.55, cz1 - 0.3], [x2, 2.55, cz1 - 1.2]], lamp);
      const grille: V3[][] = [];
      for (let gy = 2.9; gy <= 3.9; gy += 0.33) grille.push([[x2, gy, cz0 + 1.6], [x2, gy, cz1 - 1.6]]);
      lines(grille, { fill: 'none', stroke: '#0b3b35', strokeWidth: 1.1 });
    }
  }
  cuboid(x2 - 0.05, x2 + 0.3, CAB.bottom - 0.2, CAB.bottom + 0.55, cz0 - 0.05, cz1 + 0.05, 'dark'); // bumper
  cuboid(x2 - 0.35, x2 - 0.15, 4.5, 5.8, cz1, cz1 + 0.45, 'dark'); // mirrors
  cuboid(x2 - 0.35, x2 - 0.15, 4.5, 5.8, cz0 - 0.45, cz0, 'dark');

  // wheels: single front, dual rear
  const r = WHEEL_R;
  const ring = (xc: number, z: number, rad: number): V3[] =>
    Array.from({ length: 18 }, (_, k) => {
      const t = (k / 18) * Math.PI * 2;
      return [xc + Math.cos(t) * rad, r + Math.sin(t) * rad, z] as V3;
    });
  const wheel = (xc: number, z: number, out: 1 | -1) => {
    const pts = ring(xc, z, r);
    if (face(out > 0 ? pts : pts.slice().reverse(), [0, 0, out], 'wheel')) {
      decal(ring(xc, z + 0.01 * out, r * 0.5), { fill: '#aeb5b2', stroke: '#5b6663', strokeWidth: 0.6 });
      decal(ring(xc, z + 0.02 * out, r * 0.16), { fill: '#5b6663', stroke: 'none' });
    }
  };
  const xf = x1 + CAB.length * 0.45;
  const xr = Math.max(r + 0.3, L * 0.3);
  wheel(xf, cz1 - 0.25, 1); wheel(xf, cz0 + 0.25, -1);
  wheel(xr, W - 0.15, 1); wheel(xr, W - 0.8, 1); wheel(xr, 0.15, -1); wheel(xr, 0.8, -1);

  groups.sort((m, n) => m.depth - n.depth);

  // fit
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const g of groups) for (const it of g.items) {
    const all = it.pts ?? (it.segs ?? []).flat();
    for (const q of all) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); }
  }
  const sc = Math.min(SCALE, 270 / (maxX - minX), 150 / (maxY - minY));
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const S2 = (q: V3): V2 => [VIEW_W / 2 + (q[0] - mx) * sc, 108 - (q[1] - my) * sc];
  const f1 = (v: number) => v.toFixed(1);
  const pathOf = (pts: V3[]) => pts.map((q, k) => { const t = S2(q); return `${k ? 'L' : 'M'}${f1(t[0])} ${f1(t[1])}`; }).join(' ');

  const paths: Built['paths'] = [];
  for (const g of groups) for (const it of g.items) {
    const d = it.segs ? it.segs.map(pathOf).join(' ') : pathOf(it.pts ?? []) + (it.close ? ' Z' : '');
    paths.push({ d, style: it.style });
  }

  // dimension lines on the outermost container edges (the back end, never the cab end)
  const P3 = (x: number, y: number, z: number) => S2(rot([x, y, z]));
  const C = P3(L / 2, c + H / 2, W / 2);
  const cands: number[][][] = [
    [[0, c + H, 0, L, c + H, 0], [0, c + H, W, L, c + H, W], [0, c, 0, L, c, 0], [0, c, W, L, c, W]],
    [[0, c + H, 0, 0, c + H, W], [0, c, 0, 0, c, W]],
    [[0, c, 0, 0, c + H, 0], [0, c, W, 0, c + H, W]],
  ];
  const dims: Built['dims'] = [];
  const labels: (Built['labels'][number] & { nx: number; ny: number })[] = [];
  cands.forEach((list, k) => {
    let best: { A: V2; B: V2; nx: number; ny: number; mx: number; my: number; score: number } | null = null;
    for (const e of list) {
      const A = P3(e[0], e[1], e[2]), B = P3(e[3], e[4], e[5]);
      const mx2 = (A[0] + B[0]) / 2, my2 = (A[1] + B[1]) / 2;
      const ddx = B[0] - A[0], ddy = B[1] - A[1], len = Math.hypot(ddx, ddy);
      let nx: number, ny: number;
      if (len < 4) { nx = mx2 - C[0]; ny = my2 - C[1]; const nn = Math.hypot(nx, ny) || 1; nx /= nn; ny /= nn; }
      else { nx = -ddy / len; ny = ddx / len; if ((mx2 - C[0]) * nx + (my2 - C[1]) * ny < 0) { nx = -nx; ny = -ny; } }
      const score = (mx2 - C[0]) * nx + (my2 - C[1]) * ny;
      if (!best || score > best.score) best = { A, B, nx, ny, mx: mx2, my: my2, score };
    }
    if (!best) return;
    const o = 14, t = 4.5, b = best;
    const a1: V2 = [b.A[0] + b.nx * o, b.A[1] + b.ny * o];
    const b1: V2 = [b.B[0] + b.nx * o, b.B[1] + b.ny * o];
    const seg = (p1: V2, p2: V2) => `M${f1(p1[0])} ${f1(p1[1])} L${f1(p2[0])} ${f1(p2[1])}`;
    dims.push({
      line: [seg(a1, b1), seg([a1[0] - b.nx * t, a1[1] - b.ny * t], [a1[0] + b.nx * t, a1[1] + b.ny * t]), seg([b1[0] - b.nx * t, b1[1] - b.ny * t], [b1[0] + b.nx * t, b1[1] + b.ny * t])].join(' '),
      ext: [seg([b.A[0] + b.nx * 3, b.A[1] + b.ny * 3], [a1[0] + b.nx * 2, a1[1] + b.ny * 2]), seg([b.B[0] + b.nx * 3, b.B[1] + b.ny * 3], [b1[0] + b.nx * 2, b1[1] + b.ny * 2])].join(' '),
    });
    labels.push({ x: b.mx + b.nx * (o + 13), y: b.my + b.ny * (o + 13), text: texts[k], nx: b.nx, ny: b.ny });
  });
  for (let pass = 0; pass < 4; pass++) {
    for (let u = 0; u < labels.length; u++) for (let w = u + 1; w < labels.length; w++) {
      const A = labels[u], B = labels[w];
      if (Math.abs(A.x - B.x) < 62 && Math.abs(A.y - B.y) < 22) {
        B.x += B.nx * 14; B.y += B.ny * 14;
        if (Math.abs(A.x - B.x) < 62 && Math.abs(A.y - B.y) < 22) B.y += B.y >= A.y ? 12 : -12;
      }
    }
  }
  return {
    ok,
    paths,
    dims,
    labels: labels.map((lb) => ({ x: Math.max(36, Math.min(VIEW_W - 36, lb.x)), y: Math.max(13, Math.min(VIEW_H - 13, lb.y)), text: lb.text })),
  };
}

const labelStyle: CSSProperties = {
  position: 'absolute',
  transform: 'translate(-50%, -50%)',
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--hz-c-surface)',
  border: '1px solid #9cc4ba',
  color: GREEN_DARK,
  font: '700 12px Inter, system-ui, sans-serif',
  whiteSpace: 'nowrap',
  boxShadow: '0 1px 2px rgba(0,0,0,.08)',
  pointerEvents: 'none',
};

/**
 * Rotatable 3D lorry. The container is drawn to the entered size (feet) on one
 * common scale next to a fixed cab. Drag turns it left/right and tilts it
 * (-10 to 80 degrees); a double-click or double-tap resets the view.
 */
export function Lorry3D({ box, height }: { box: LorryBox | null; height: number }) {
  const [view, setView] = useState({ yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH });
  const viewRef = useRef(view);
  viewRef.current = view;
  const raf = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; lx: number; ly: number; lt: number; vx: number; vy: number } | null>(null);
  const lastTap = useRef(0);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: VIEW_W, h: height });

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const animateTo = useCallback((yaw: number, pitch: number) => {
    stop();
    const from = viewRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 420);
      const e = 1 - Math.pow(1 - k, 3);
      setView({ yaw: from.yaw + (yaw - from.yaw) * e, pitch: from.pitch + (pitch - from.pitch) * e });
      raf.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    raf.current = requestAnimationFrame(step);
  }, [stop]);

  const coast = useCallback((vx0: number, vy0: number) => {
    stop();
    let vx = vx0, vy = vy0;
    const step = () => {
      vx *= 0.93; vy *= 0.86;
      setView((v) => ({ yaw: v.yaw + vx, pitch: clampPitch(v.pitch + vy) }));
      raf.current = Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05 ? requestAnimationFrame(step) : null;
    };
    raf.current = requestAnimationFrame(step);
  }, [stop]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onPointerDown = (ev: ReactPointerEvent<SVGSVGElement>) => {
    stop();
    const now = performance.now();
    if (now - lastTap.current < 320) {
      lastTap.current = 0;
      drag.current = null;
      animateTo(DEFAULT_YAW, DEFAULT_PITCH);
      return;
    }
    lastTap.current = now;
    const v = viewRef.current;
    drag.current = { x: ev.clientX, y: ev.clientY, yaw: v.yaw, pitch: v.pitch, lx: ev.clientX, ly: ev.clientY, lt: now, vx: 0, vy: 0 };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.lt);
    d.vx = ((ev.clientX - d.lx) * 0.6 * 16) / dt;
    d.vy = ((ev.clientY - d.ly) * 0.4 * 16) / dt;
    d.lx = ev.clientX; d.ly = ev.clientY; d.lt = now;
    setView({ yaw: d.yaw + (ev.clientX - d.x) * 0.6, pitch: clampPitch(d.pitch + (ev.clientY - d.y) * 0.4) });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && performance.now() - d.lt < 80 && (Math.abs(d.vx) > 0.4 || Math.abs(d.vy) > 0.4)) coast(d.vx, d.vy);
  };

  const built = buildLorry(box, view.yaw, view.pitch);
  // where the 360x220 drawing actually sits inside the box (preserveAspectRatio meet)
  const k = Math.min(size.w / VIEW_W, size.h / VIEW_H);
  const offX = (size.w - VIEW_W * k) / 2;
  const offY = (size.h - VIEW_H * k) / 2;
  const aria = built.ok && box
    ? `Lorry with container ${fmt(box.length)} ft long, ${fmt(box.width)} ft wide, ${fmt(box.height)} ft high`
    : 'Lorry, container size not entered';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        ref={wrap}
        style={{ position: 'relative', height, background: 'var(--hz-dk-surface-2, #f2f6f4)', border: '1px solid #e3ebe7', borderRadius: 12, overflow: 'hidden' }}
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={aria}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => animateTo(DEFAULT_YAW, DEFAULT_PITCH)}
          style={{ display: 'block', touchAction: 'none', cursor: 'grab', userSelect: 'none' }}
        >
          {built.paths.map((p, i) => <path key={i} d={p.d} style={p.style} />)}
          {built.dims.map((d, i) => (
            <g key={`d${i}`}>
              <path d={d.ext} style={{ fill: 'none', stroke: GREEN_DARK, strokeWidth: 0.8, strokeDasharray: '2 2' }} />
              <path d={d.line} style={{ fill: 'none', stroke: GREEN_DARK, strokeWidth: 1.4, strokeLinecap: 'round' }} />
            </g>
          ))}
        </svg>
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {built.labels.map((lb, i) => (
            <span key={i} style={{ ...labelStyle, left: offX + lb.x * k, top: offY + lb.y * k }}>{lb.text}</span>
          ))}
        </div>
      </div>
      {built.ok && box ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 16px', fontSize: 13, color: '#1d2624' }}>
          <span><span style={{ color: '#5b6663' }}>Length</span> <b>{fmt(box.length)} ft</b></span>
          <span><span style={{ color: '#5b6663' }}>Width</span> <b>{fmt(box.width)} ft</b></span>
          <span><span style={{ color: '#5b6663' }}>Height</span> <b>{fmt(box.height)} ft</b></span>
          <span style={{ marginLeft: 'auto', color: '#0e4e46' }}>
            <b style={{ fontSize: 18 }}>{(box.length * box.width * box.height * 0.0283168).toFixed(1)}</b> m³
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 13, fontWeight: 600, color: '#82440f' }}>Size not entered</div>
      )}
    </div>
  );
}

/** Small side view of the lorry, on the same per-foot scale for every lorry, for list cards. */
export function LorrySide({ box }: { box: LorryBox | null }) {
  const b = box && box.length > 0 && box.width > 0 && box.height > 0 ? box : null;
  const ok = b != null;
  const L = Math.min(b ? b.length : 14, 40);
  const H = Math.min(b ? b.height : 7, 11);
  const s = 5, gy = 60, c = FLOOR, cabR = 254, cabL = CAB.length * s, cabLeft = cabR - cabL;
  const y = (ft: number) => gy - ft * s;
  const boxR = cabLeft - GAP * s, boxL = boxR - L * s, top = gy - (c + H) * s, bot = gy - c * s;
  const ribs: number[] = [];
  if (ok) {
    const n = Math.max(3, Math.round(L / 1.4));
    for (let k = 1; k < n; k++) ribs.push(boxL + ((boxR - boxL) * k) / n);
  }
  const r = WHEEL_R * s, wy = gy - r, xf = cabLeft + cabL * 0.45, xr = boxL + Math.max(r + 2, L * s * 0.3);
  const label = b ? `Lorry with container ${fmt(b.length)} by ${fmt(b.height)} ft` : 'Lorry, container size not entered';
  /* Every lorry keeps the one scale (s); only its position moves, so a short lorry sits in
     the middle of its box instead of against the right edge. */
  const dx = (260 - (cabR - (boxL - 1))) / 2 - (boxL - 1);
  return (
    <svg viewBox="0 0 260 64" width="100%" role="img" aria-label={label} style={{ display: 'block', background: 'var(--hz-dk-surface-2, #f6f8f7)', borderRadius: 8 }}>
      <path d="M4 60.5 H256" style={{ fill: 'none', stroke: '#dfe5e2', strokeWidth: 1 }} />
      <g transform={`translate(${dx} 0)`}>
      <rect x={boxL - 1} y={bot} width={cabR - 2 - (boxL - 1)} height={2.5} style={{ fill: '#2f3433' }} />
      <rect
        x={boxL} y={top} width={boxR - boxL} height={bot - top}
        style={ok ? { fill: '#e6f0ed', stroke: GREEN, strokeWidth: 1.3 } : { fill: '#f6f4ee', stroke: '#9aa29f', strokeWidth: 1.3, strokeDasharray: '4 3' }}
      />
      {ribs.map((x, i) => (
        <line key={i} x1={x} y1={top + 2} x2={x} y2={bot - 2} style={{ stroke: GREEN, strokeOpacity: 0.35, strokeWidth: 0.8 }} />
      ))}
      <path
        d={`M${cabLeft} ${y(CAB.bottom)} H${cabR} V${y(CAB.top - 0.35)} L${cabR - 1.8} ${y(CAB.top)} H${cabLeft} Z`}
        style={{ fill: GREEN, stroke: GREEN_DARK, strokeWidth: 0.8, strokeLinejoin: 'round' }}
      />
      <rect x={cabR - 11.5} y={y(6.95)} width={9.7} height={y(4.9) - y(6.95)} style={{ fill: '#23403c' }} />
      {[xf, xr].map((cx, i) => (
        <g key={i}>
          <circle cx={cx} cy={wy} r={r} style={{ fill: '#1b1f1e' }} />
          <circle cx={cx} cy={wy} r={r * 0.45} style={{ fill: '#aeb5b2' }} />
        </g>
      ))}
      </g>
    </svg>
  );
}
