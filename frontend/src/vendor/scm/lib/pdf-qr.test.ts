import { describe, it, expect } from 'vitest';
// @ts-ignore — same typings pragma as the module under test.
import qrcode from 'qrcode-generator';
import { drawQrIntoPdf } from './pdf-qr';

type Rect = { x: number; y: number; w: number; h: number; fill: [number, number, number] };

function record(): { doc: { setFillColor: (r: number, g: number, b: number) => void; rect: (x: number, y: number, w: number, h: number, s?: string) => void }; rects: Rect[] } {
  const rects: Rect[] = [];
  let fill: [number, number, number] = [0, 0, 0];
  return {
    rects,
    doc: {
      setFillColor: (r, g, b) => { fill = [r, g, b]; },
      rect: (x, y, w, h) => { rects.push({ x, y, w, h, fill }); },
    },
  };
}

const URL = 'https://erp.houzscentury.com/scm/do-load?id=0f0e0d0c-0b0a-4908-8706-050403020100';
const SHORT = 'https://erp.houzscentury.com/d/k3m9p2vx7q';
const LEGACY = `https://erp.houzscentury.com/d/${'a'.repeat(64)}`;
const MIN_MODULE_MM = 0.42;

const moduleCount = (text: string): number => {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.getModuleCount();
};

describe('drawQrIntoPdf', () => {
  it('draws the white quiet-zone backing first, at the requested spot and the drawn size', () => {
    const { doc, rects } = record();
    const size = drawQrIntoPdf(doc, SHORT, 180, 40, 14);
    expect(size).toBe(14);
    expect(rects[0]).toEqual({ x: 180, y: 40, w: 14, h: 14, fill: [255, 255, 255] });
  });

  it('NEVER prints a module smaller than the floor, whatever it is asked for', () => {
    for (const text of [SHORT, LEGACY, URL]) {
      const n = moduleCount(text) + 4;
      for (const asked of [6, 10, 14, 16, 25]) {
        const { doc } = record();
        const drawn = drawQrIntoPdf(doc, text, 0, 0, asked);
        expect(drawn / n, `${text.length} chars asked for ${asked}mm`)
          .toBeGreaterThanOrEqual(MIN_MODULE_MM - 1e-9);
        expect(drawn).toBeGreaterThanOrEqual(asked - 1e-9);
      }
    }
  });

  it('the short token is what makes 14mm both smaller than before AND easier to scan', () => {
    /* The owner asked for a smaller code (2026-08-27). A smaller code with the
       same payload is a WORSE code, so the token was shortened in the same
       change; this pins that the pair actually delivers what it claimed. */
    const shortCell = 14 / (moduleCount(SHORT) + 4);
    const legacyAt16 = 16 / (moduleCount(LEGACY) + 4);
    expect(shortCell).toBeGreaterThan(legacyAt16);
    expect(shortCell).toBeGreaterThanOrEqual(MIN_MODULE_MM);
  });

  it('draws one ink rect per dark module — the same matrix the library reports', () => {
    const { doc, rects } = record();
    drawQrIntoPdf(doc, URL, 0, 0, 16);
    const qr = qrcode(0, 'M');
    qr.addData(URL);
    qr.make();
    let dark = 0;
    const n = qr.getModuleCount();
    for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) dark += 1;
    expect(rects.length - 1).toBe(dark);
  });

  it('keeps every module inside the backing — the quiet zone is real', () => {
    const { doc, rects } = record();
    const drawn = drawQrIntoPdf(doc, URL, 10, 20, 16);
    for (const r of rects.slice(1)) {
      expect(r.x).toBeGreaterThan(10);
      expect(r.y).toBeGreaterThan(20);
      expect(r.x + r.w).toBeLessThan(10 + drawn + 1e-9);
      expect(r.y + r.h).toBeLessThan(20 + drawn + 1e-9);
    }
  });
});
