// ----------------------------------------------------------------------------
// The two things the PO sheet got wrong about sofa artwork, each pinned.
//
// 1. THREE KEY SHAPES, NOT ONE. The loader used to send every imageKey to the
//    uploaded-photo API. The seeded default is `sofa-modules/<code>.svg` — a
//    bundled file on this origin — so every default compartment 404'd and the
//    sheet silently drew its own schematic instead. Asserted against the
//    Maintenance list's own resolver, read out of Products.tsx, so the two
//    cannot drift apart again.
//
// 2. CROP TO THE SILHOUETTE. The art is 1024² with the drawing padded inside.
//    Fill a cell with the raw file and the modules tile small with gaps —
//    POS calls it "the 2WC card bug". Asserted as a measurement, because a
//    fallback bbox would satisfy any looser check.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as rsv } from 'node:path';
import { resolveCompartmentArtUrl, measureArtBbox, ART_BBOX_FALLBACK } from './sofa-compartment-art';

const here = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.example.com/api/scm';

describe('the three imageKey shapes', () => {
  test('a BUNDLED key resolves to a static file, never to the API', () => {
    /* THE REGRESSION. This is the default every compartment ships with. */
    const url = resolveCompartmentArtUrl('1A(LHF)', 'sofa-modules/1A(LHF).svg', API);
    expect(url).toBe('/sofa-modules/1A(LHF).png');
    expect(url).not.toContain(API);
  });

  test('the bundled key is answered as PNG whatever extension it carries', () => {
    /* jsPDF embeds raster only, and POS tiles from `${id}.png` for the same
       reason. The seed writes `.svg`; the raster twin beside it is the file. */
    for (const key of ['sofa-modules/CNR.svg', 'sofa-modules/CNR.png', 'sofa-modules/CNR']) {
      expect(resolveCompartmentArtUrl('CNR', key, API)).toBe('/sofa-modules/CNR.png');
    }
  });

  test('an UPLOADED key goes through the API, code and key both encoded', () => {
    const url = resolveCompartmentArtUrl('2A(RHF)', 'sofa-compartments/2A(RHF)/hero.jpg', API)!;
    expect(url.startsWith(`${API}/maintenance-config/sofa-compartments/`)).toBe(true);
    expect(url).toContain(encodeURIComponent('2A(RHF)'));
    expect(url).toContain(encodeURIComponent('sofa-compartments/2A(RHF)/hero.jpg'));
  });

  test('an http(s) key is used as-is, and a missing key resolves to nothing', () => {
    expect(resolveCompartmentArtUrl('X', 'https://cdn.example.com/a.png', API))
      .toBe('https://cdn.example.com/a.png');
    expect(resolveCompartmentArtUrl('X', undefined, API)).toBeNull();
    expect(resolveCompartmentArtUrl('X', '', API)).toBeNull();
  });

  test('it agrees with the Maintenance list, which resolves the same three shapes', () => {
    /* Two surfaces resolving one key differently is the fault this module was
       written to repair; a third copy would be the next one. Read rather than
       imported because that file is a page, not a library. */
    const products = readFileSync(rsv(here, '../../../pages/scm-v2/Products.tsx'), 'utf8');
    expect(products).toContain("SOFA_COMPARTMENT_API_PREFIX = 'sofa-compartments/'");
    expect(products).toContain('/maintenance-config/sofa-compartments/');
    // The bundled branch: a key that is not a URL and not uploaded is served
    // from /public in both places.
    expect(products).toMatch(/return `\/\$\{imageKey\}`/);
  });
});

describe('the silhouette crop', () => {
  /** A fake 100×100 image whose opaque pixels sit in a known inner box. */
  const fakeImage = (box: { l: number; t: number; r: number; b: number }) => {
    const W = 100;
    const data = new Uint8ClampedArray(W * W * 4);
    for (let y = 0; y < W; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const inside = x >= box.l * W && x <= box.r * W && y >= box.t * W && y <= box.b * W;
        data[(y * W + x) * 4 + 3] = inside ? 255 : 0;
      }
    }
    const ctx = {
      drawImage() {},
      getImageData: () => ({ data }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
    };
    return { width: W, height: W } as unknown as HTMLImageElement;
  };

  test('it finds the drawn box, not the padded frame', () => {
    const bbox = measureArtBbox(fakeImage({ l: 0.25, t: 0.3, r: 0.75, b: 0.7 }));
    /* Sampled every 2px, so allow one sample of slack — and assert it is NOT
       the whole frame, which is the failure that reproduces the gaps. */
    expect(bbox.l).toBeCloseTo(0.26, 1);
    expect(bbox.t).toBeCloseTo(0.30, 1);
    expect(bbox.r).toBeCloseTo(0.74, 1);
    expect(bbox.b).toBeCloseTo(0.70, 1);
    expect(bbox.r - bbox.l).toBeLessThan(0.6);
  });

  test('a fully transparent image falls back rather than reporting an empty box', () => {
    /* An empty bbox would divide by zero downstream and place the module at
       infinity. POS returns the same rough fallback for the same reason. */
    expect(measureArtBbox(fakeImage({ l: 2, t: 2, r: 3, b: 3 }))).toEqual(ART_BBOX_FALLBACK);
  });
});
