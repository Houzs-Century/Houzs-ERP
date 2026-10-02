import { describe, expect, it } from 'vitest';
import { purchaseOrderPdfBase64 } from './purchase-order-pdf';
import { splitBackendSofa } from './sofa-walk-order';

const split = (ids: string[]) => splitBackendSofa(ids, (id) => id);

describe('splitBackendSofa', () => {
  it('HC-SO-2609-393: LHF first, RHF last, the both-arms 2S a sofa of its own', () => {
    expect(split(['1A(LHF)', '1A(RHF)', 'Console', '2S'])).toEqual([['1A(LHF)', 'Console', '1A(RHF)'], ['2S']]);
  });

  it('keeps a correctly keyed sofa, corners included, exactly as stored', () => {
    const u = ['1A(LHF)', 'CNR', '2NA', '1NA', 'CNR', '1A(RHF)'];
    expect(split(u)).toEqual([u]);
    expect(split(['2A(LHF)', 'L(RHF)'])).toEqual([['2A(LHF)', 'L(RHF)']]);
  });

  it('two LHF pieces: the line order is the only evidence, so it is kept', () => {
    const two = ['1A(RHF)', '1A(LHF)', '1A(LHF)', 'Console'];
    expect(split(two)).toEqual([two]);
  });

  it('every both-arms piece is its own sofa, in order of appearance', () => {
    expect(split(['3S', '2S', '1S(P)'])).toEqual([['3S'], ['2S'], ['1S(P)']]);
  });
});

type PdfArgs = Parameters<typeof purchaseOrderPdfBase64>;

const header: PdfArgs[0] = {
  po_number: 'HC-PO-TEST-007', supplier_id: null, status: 'SUBMITTED', po_date: '2026-10-02',
  expected_at: '2026-10-29', currency: 'MYR', subtotal_sen: 0, tax_sen: 0, total_sen: 0, notes: null,
  supplier: { code: '400-TEST', name: 'TEST SUPPLIER', address: '1 JALAN TEST' },
};

const line = (moduleId: string, lineNo: number): PdfArgs[1][number] => ({
  item_code: `8030-${moduleId}`, material_name: `SOFFIO ${moduleId}`, supplier_sku: `5540-${moduleId}`,
  qty: 1, unit_price_sen: 0, line_total_sen: 0, uom: 'UNIT', item_group: 'sofa',
  so_doc_no: 'HC-SO-2609-393', variants: {}, line_no: lineNo,
});

describe('PO PDF prints a mis-keyed backend sofa in walking order', () => {
  it('table rows and layout follow LHF -> Console -> RHF, with the 2S drawn separately', async () => {
    const b64 = await purchaseOrderPdfBase64(header, [
      line('1A(LHF)', 1), line('1A(RHF)', 3), line('Console', 4), line('2S', 5),
    ]);
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    const at = (s: string) => raw.indexOf(s);
    expect(at('SOFFIO 1A\\(LHF\\)')).toBeGreaterThan(-1);
    expect(at('SOFFIO 1A\\(LHF\\)')).toBeLessThan(at('SOFFIO Console'));
    expect(at('SOFFIO Console')).toBeLessThan(at('SOFFIO 1A\\(RHF\\)'));
    expect(at('SOFFIO 1A\\(RHF\\)')).toBeLessThan(at('SOFFIO 2S'));
    // Two diagrams: the three-piece sofa, then the 2S on its own.
    expect(raw).toContain('Console + 1A\\(RHF\\)');
    expect(raw).not.toContain('1A\\(RHF\\) + Console');
    expect(raw).not.toContain('+ 2S');
  });
});
