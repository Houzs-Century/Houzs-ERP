// The delivery order's closing (signature + footer) must share its page with
// the last item photos. The photos used to run down to the footer rule, past
// the closing's top, so the closing took a fresh page holding only the
// signature (Conts-ERP #649). This drives the real photo layout with the DO's
// own bottom edge and checks the page-break decision the renderer makes.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));

import { DO_PHOTOS_PAGE_BOTTOM, doClosingNeedsNewPage } from './delivery-order-pdf';
import { drawItemPhotosBlock, type PdfDocLike, type PdfPhotoImage } from './pdf-item-photos';

const M = 14;
const CONTENT_W = 215.9 - M * 2;
/* The old bottom edge: the items table's rail, FOOTER_RULE_Y - 6 on Letter. */
const OLD_PAGE_BOTTOM = 279.4 - 12 - 6 - 6;

const img: PdfPhotoImage = { dataUrl: 'data:image/jpeg;base64,x', format: 'JPEG', w: 800, h: 800 };

function stubDoc(): PdfDocLike {
  return {
    addPage: () => undefined,
    setFont: () => undefined,
    setFontSize: () => undefined,
    setTextColor: () => undefined,
    setDrawColor: () => undefined,
    setLineWidth: () => undefined,
    text: () => undefined,
    rect: () => undefined,
    addImage: () => undefined,
    getTextWidth: (t) => t.length * 1.5,
  };
}

function photosEndY(pageBottom: number, startY: number, lines: number): number {
  const groups = Array.from({ length: lines }, (_, i) => ({ chip: `#${i + 1}`, code: `C${i}`, photoKeys: [`p${i}.jpg`] }));
  const images = new Map(groups.map((g) => [g.photoKeys[0]!, img] as const));
  const res = drawItemPhotosBlock(stubDoc(), groups, images, {
    margin: M, contentW: CONTENT_W, startY, pageBottom, pageTop: M, side: null, onNewPage: null,
  });
  return res.endY;
}

const CASES = [60, 100, 140, 180, 200].flatMap((startY) => [1, 3, 4, 6, 7, 11].map((lines) => ({ startY, lines })));

describe('the delivery order closing', () => {
  it('never needs a page of its own after the photos', () => {
    for (const { startY, lines } of CASES) {
      expect(doClosingNeedsNewPage(photosEndY(DO_PHOTOS_PAGE_BOTTOM, startY, lines)), `startY ${startY}, ${lines} lines`).toBe(false);
    }
  });

  it('the old bottom edge did leave the signature alone on a page', () => {
    expect(CASES.some(({ startY, lines }) => doClosingNeedsNewPage(photosEndY(OLD_PAGE_BOTTOM, startY, lines)))).toBe(true);
  });
});
