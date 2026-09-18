/* The bill reader's pure halves — coercion, JSON tolerance, the supplier
 * fuzzy match — and the one vision call with fetch injected. What is pinned:
 *
 *   • an unreadable field arrives null and STAYS null — never invented,
 *     never computed (the scan-so discipline, kept);
 *   • RM figures become integer sen exactly once, here;
 *   • supplier matching is code, not prompt: SDN BHD tails and punctuation
 *     do not defeat it, and below its two confidence rungs it returns
 *     NOTHING — a wrong supplier pre-selected is worse than none;
 *   • API trouble comes back as a sentence, not a throw.
 */
import { describe, expect, it } from 'vitest';
import {
  coerceBillJson, parseModelJson, extractOneBill, matchSupplier,
} from './bill-extract';

describe('coerceBillJson', () => {
  it('converts RM to sen once, keeps nulls null, clamps the shapes', () => {
    const out = coerceBillJson({
      vendorName: 'TENAGA NASIONAL BERHAD',
      documentKind: 'bill',
      invoiceNumber: 'TNB-2609-001',
      invoiceDate: '2026-09-01',
      dueDate: null,
      currency: 'myr',
      totalRm: 1234.56,
      sstRm: null,
      lines: [{ description: 'Electricity Aug', amountRm: 1234.56 }],
    });
    expect(out.totalSen).toBe(123456);
    expect(out.sstSen).toBeNull();
    expect(out.dueDate).toBeNull();
    expect(out.currency).toBe('MYR');
    expect(out.lines).toEqual([{ description: 'Electricity Aug', amountSen: 123456 }]);
  });

  it('garbage in, nulls out — a finance screen never crashes on a bad photo', () => {
    const out = coerceBillJson({ documentKind: 'poem', invoiceDate: '01/09/2026', totalRm: 'a lot', lines: 'none' });
    expect(out.documentKind).toBe('unknown');
    expect(out.invoiceDate).toBeNull();   // non-ISO refused, not re-parsed
    expect(out.totalSen).toBeNull();
    expect(out.lines).toEqual([]);
  });

  it('parseModelJson takes the outermost object out of prose and fences', () => {
    expect(parseModelJson('Here is the bill:\n```json\n{"totalRm": 5}\n```')).toEqual({ totalRm: 5 });
    expect(parseModelJson('no json at all')).toBeNull();
  });

  /* docs/bugs/0702 — the owner's 99 Speedmart receipt (2026-09-08: 这个 ocr 会
     显示 sub total, 这样我开 ocr 时会开, 不太对): the reader listed the footer
     rows as line items, so the voucher pre-filled at roughly TWICE the receipt.
     The shape below is that receipt's, with made-up goods. */
  const SPEEDMART = {
    vendorName: '99 SPEEDMART S/B', documentKind: 'receipt', invoiceNumber: 'T0012-3456',
    invoiceDate: '2026-09-07', currency: 'MYR', totalRm: 19.10, sstRm: null,
    lines: [
      { description: 'MILO ACTIV-GO 1KG', amountRm: 15.90 },
      { description: 'GARDENIA ORIGINAL 400G', amountRm: 3.20 },
      { description: 'ROUNDING ADJ', amountRm: 0.00 },
      { description: 'Sub Total', amountRm: 19.10 },
      { description: 'NET TOTAL', amountRm: 19.10 },
      { description: 'DUITNOW QR', amountRm: 19.10 },
      { description: 'CHANGE', amountRm: 0.00 },
      { description: 'Total Items', amountRm: 2 },
    ],
  };

  it('a receipt\'s footer rows are NOT line items — the lines are the goods, and they add up to the total', () => {
    const out = coerceBillJson(SPEEDMART);
    expect(out.lines).toEqual([
      { description: 'MILO ACTIV-GO 1KG', amountSen: 1590 },
      { description: 'GARDENIA ORIGINAL 400G', amountSen: 320 },
    ]);
    expect(out.lines.reduce((s, l) => s + (l.amountSen ?? 0), 0)).toBe(out.totalSen);
  });

  it('rows that MOVE the total stay: a discount, the tax, a non-zero rounding — the total the receipt asks for is what the lines add up to', () => {
    const out = coerceBillJson({
      ...SPEEDMART, totalRm: 20.00,
      lines: [
        { description: 'MILO ACTIV-GO 1KG', amountRm: 15.90 },
        { description: 'GARDENIA ORIGINAL 400G', amountRm: 3.20 },
        { description: 'MEMBER DISCOUNT', amountRm: -0.50 },
        { description: 'SST 6%', amountRm: 1.42 },
        { description: 'ROUNDING ADJ', amountRm: -0.02 },
        { description: 'TOTAL', amountRm: 20.00 },
        { description: 'CASH', amountRm: 50.00 },
        { description: 'CHANGE', amountRm: 30.00 },
      ],
    });
    expect(out.lines.map((l) => l.description)).toEqual(['MILO ACTIV-GO 1KG', 'GARDENIA ORIGINAL 400G', 'MEMBER DISCOUNT', 'SST 6%', 'ROUNDING ADJ']);
    expect(out.lines.reduce((s, l) => s + (l.amountSen ?? 0), 0)).toBe(2000);
  });

  it('the tender rows of every wallet and card are footer, wherever the total sits; a goods line that merely contains "total" is kept', () => {
    const out = coerceBillJson({
      ...SPEEDMART, totalRm: 12.00,
      lines: [
        { description: 'TOTAL CARE SHAMPOO 200ML', amountRm: 12.00 },
        { description: 'Amount Due', amountRm: 12.00 },
        { description: 'Touch \'n Go eWallet', amountRm: 12.00 },
        { description: 'GrabPay', amountRm: 0 },
        { description: 'VISA ****1234', amountRm: 0 },
        { description: 'Balance', amountRm: 0 },
        { description: 'Tendered', amountRm: 12.00 },
        { description: 'Payment: Cash', amountRm: null },
      ],
    });
    expect(out.lines).toEqual([{ description: 'TOTAL CARE SHAMPOO 200ML', amountSen: 1200 }]);
  });
});

describe('matchSupplier', () => {
  const SUPPLIERS = [
    { id: 's1', code: '400-H004', name: 'HOOKKA INDUSTRIES SDN. BHD.' },
    { id: 's2', code: '400-A004', name: 'ARMANI SOFA SDN. BHD.' },
    { id: 's3', code: '405-N001', name: 'NANTONG YOURUI TEXTILE CO., LTD.' },
  ];

  it('the SDN BHD tail and punctuation do not defeat an exact match', () => {
    const m = matchSupplier('Hookka Industries', SUPPLIERS);
    expect(m?.supplier.id).toBe('s1');
    expect(m?.confidence).toBe('exact');
  });

  it('a printed longer form still finds its supplier by containment', () => {
    const m = matchSupplier('NANTONG YOURUI TEXTILE', SUPPLIERS);
    expect(m?.supplier.id).toBe('s3');
  });

  it('below the rungs: nothing — a wrong supplier pre-selected is worse than none', () => {
    expect(matchSupplier('TENAGA NASIONAL BERHAD', SUPPLIERS)).toBeNull();
    expect(matchSupplier(null, SUPPLIERS)).toBeNull();
    expect(matchSupplier('   ', SUPPLIERS)).toBeNull();
  });
});

describe('extractOneBill', () => {
  const FILES = [{ name: 'bill.jpg', mime: 'image/jpeg', dataBase64: 'aGk=' }];
  const modelSays = (text: string): typeof fetch => (async () => new Response(JSON.stringify({
    content: [{ type: 'text', text }],
  }), { status: 200 })) as unknown as typeof fetch;

  it('a clean answer comes back coerced', async () => {
    const r = await extractOneBill('key', FILES, modelSays('{"vendorName":"TNB","totalRm":10}'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.extraction.totalSen).toBe(1000);
  });

  it('API refusal is a sentence, not a throw', async () => {
    const failing: typeof fetch = (async () => new Response('overloaded', { status: 529 })) as unknown as typeof fetch;
    const r = await extractOneBill('key', FILES, failing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/refused \(529\)/);
  });

  it('an answer with no JSON is refused with advice, not crashed on', async () => {
    const r = await extractOneBill('key', FILES, modelSays('I see a cat.'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/clearer photo/);
  });
});
