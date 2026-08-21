// pdf-qr — the vector QR drawer behind the DO print's "scan to mark loaded".
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

describe('drawQrIntoPdf', () => {
  it('draws the white quiet-zone backing first, exactly the requested size at the requested spot', () => {
    const { doc, rects } = record();
    const size = drawQrIntoPdf(doc, URL, 180, 40, 16);
    expect(size).toBe(16);
    expect(rects[0]).toEqual({ x: 180, y: 40, w: 16, h: 16, fill: [255, 255, 255] });
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
    expect(rects.length - 1).toBe(dark); // minus the backing
  });

  it('keeps every module inside the backing — the quiet zone is real', () => {
    const { doc, rects } = record();
    drawQrIntoPdf(doc, URL, 10, 20, 16);
    for (const r of rects.slice(1)) {
      expect(r.x).toBeGreaterThan(10);
      expect(r.y).toBeGreaterThan(20);
      expect(r.x + r.w).toBeLessThan(10 + 16 + 1e-9);
      expect(r.y + r.h).toBeLessThan(20 + 16 + 1e-9);
    }
  });
});
