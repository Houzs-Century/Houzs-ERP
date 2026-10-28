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
/* The two payloads the printed sheet actually carries: a token minted today,
   and the 64-hex one every paper printed before 2026-08-27 still holds. */
const SHORT = 'https://erp.houzscentury.com/d/k3m9p2vx7q';
const LEGACY = `https://erp.houzscentury.com/d/${'a'.repeat(64)}`;
/* The floor the drawer enforces, and the only figure with field evidence behind
   it: Hookka's delivery QR runs at 0.415mm per module on a warehouse floor. */
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
    /* 14mm is a floor the short token clears, so nothing grows here. */
    const size = drawQrIntoPdf(doc, SHORT, 180, 40, 14);
    expect(size).toBe(14);
    expect(rects[0]).toEqual({ x: 180, y: 40, w: 14, h: 14, fill: [255, 255, 255] });
  });

  it('NEVER prints a module smaller than the floor, whatever it is asked for', () => {
    /* THE PROPERTY THAT MATTERS, and it is about millimetres on paper rather
       than anything on screen: a QR's readability is its MODULE size, and the
       module count comes from the payload — so one fixed box is comfortable for
       a short link and unscannable for a long one. Asked for something too
       small, the drawer GROWS rather than obeying, because a sheet that looks
       right and does not scan is discovered at the lorry.

       Swept across sizes and both live payloads, so this cannot pass by
       accident on the one case somebody happened to pick. */
    for (const text of [SHORT, LEGACY, URL]) {
      const n = moduleCount(text) + 4; // + the 2-module quiet zone each side
      for (const asked of [6, 10, 14, 16, 25]) {
        const { doc } = record();
        const drawn = drawQrIntoPdf(doc, text, 0, 0, asked);
        expect(drawn / n, `${text.length} chars asked for ${asked}mm`)
          .toBeGreaterThanOrEqual(MIN_MODULE_MM - 1e-9);
        /* And it never shrinks something already big enough — growing is the
           only correction it is allowed to make. */
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
    expect(shortCell).toBeGreaterThan(legacyAt16);          // easier to scan
    expect(shortCell).toBeGreaterThanOrEqual(MIN_MODULE_MM); // and above the floor
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
    /* Measured against what was DRAWN, not what was asked for: the drawer may
       have grown the code, and a test that assumed otherwise would report a
       module outside a backing that is not there. */
    const drawn = drawQrIntoPdf(doc, URL, 10, 20, 16);
    for (const r of rects.slice(1)) {
      expect(r.x).toBeGreaterThan(10);
      expect(r.y).toBeGreaterThan(20);
      expect(r.x + r.w).toBeLessThan(10 + drawn + 1e-9);
      expect(r.y + r.h).toBeLessThan(20 + drawn + 1e-9);
    }
  });
});
