// A DRAFT delivery order can leave with the lorry before its goods are received
// (owner 2026-11-18), so its print carries a DRAFT mark; a shipped DO does not.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));

import { drawDraftWatermark, isDraftDo } from './delivery-order-pdf';

describe('delivery order DRAFT mark', () => {
  it('only a DRAFT DO is a draft', () => {
    expect(isDraftDo('DRAFT')).toBe(true);
    expect(isDraftDo('draft')).toBe(true);
    for (const s of ['LOADED', 'DISPATCHED', 'DELIVERED', 'INVOICED', null, undefined]) expect(isDraftDo(s)).toBe(false);
  });

  it('writes DRAFT across the page centre', () => {
    const texts: Array<{ t: string; x: number; y: number; o: unknown }> = [];
    const doc = {
      internal: { pageSize: { getWidth: () => 200, getHeight: () => 300 } },
      saveGraphicsState: () => undefined,
      restoreGraphicsState: () => undefined,
      setGState: () => undefined,
      GState: (o: unknown) => o,
      setFont: () => undefined,
      setFontSize: () => undefined,
      setTextColor: () => undefined,
      text: (t: string, x: number, y: number, o: unknown) => { texts.push({ t, x, y, o }); },
    };
    drawDraftWatermark(doc as never);
    expect(texts).toEqual([{ t: 'DRAFT', x: 100, y: 150, o: { align: 'center', angle: 30 } }]);
  });
});
