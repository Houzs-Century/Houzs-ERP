/* The SO balance is SIGNED — negative means over-collected (owner 2026-08-16:
   「需要可以超收 negative 边红色」).
   Backend half: backend/tests/soOverCollection.test.ts.

   Both surfaces here used to floor at zero with Math.max(0, …), which is what
   made an over-payment look like a settled order — and a settled-looking order
   is why the only way to bank RM 250 of real cash was to go back and re-price
   a LINE (prod HC-SO-2608-002, 2026-08-16). The floor is the bug; these pin
   its removal, and pin the one place it must STAY. */

import { describe, expect, test, vi, afterEach } from 'vitest';
import { deriveBalance } from './so-detail-gates';
import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';

describe('deriveBalance is signed', () => {
  test('the server-stamped balance_centi wins, negative included', () => {
    // GET /:docNo computes this with soBalanceCenti and it is already signed;
    // the client must pass it through rather than re-floor it.
    expect(deriveBalance({ balance_centi: -25_000 })).toBe(-25_000);
    expect(deriveBalance({ balance_centi: 0 })).toBe(0);
    expect(deriveBalance({ balance_centi: 200_000 })).toBe(200_000);
  });

  test('the local fallback goes negative by exactly the excess', () => {
    expect(deriveBalance({ local_total_centi: 400_000, paid_centi_total: 425_000 }))
      .toBe(-25_000);
  });

  test('an exact payment is still zero, and an under-payment still positive', () => {
    expect(deriveBalance({ local_total_centi: 400_000, paid_centi_total: 400_000 })).toBe(0);
    expect(deriveBalance({ local_total_centi: 400_000, paid_centi_total: 200_000 })).toBe(200_000);
  });

  test('it sums the payments ledger when no paid total was stamped', () => {
    expect(deriveBalance(
      { local_total_centi: 400_000 },
      [{ amount_centi: 200_000 }, { amount_centi: 225_000 }],
    )).toBe(-25_000);
  });

  /* The floor that must STAY. A zero total is an order whose header has not
     been recomputed — true of every AutoCount import, where total_revenue_centi
     is 0 on 2,687 of production's 2,824 live orders — not an order that has
     been credited. Without this guard the legacy book turns red overnight. */
  test('a zero total answers 0 rather than a huge false credit', () => {
    expect(deriveBalance({ local_total_centi: 0, paid_centi_total: 990_000 })).toBe(0);
    expect(deriveBalance({ paid_centi_total: 990_000 })).toBe(0);
  });
});

/* ── The customer-facing print ──────────────────────────────────────────── */

type JsPdf = import('jspdf').jsPDF;
type TextDraw = { text: string; y: number };

/* Same spy as pdf-money-layout.test.ts — one hook sees autoTable's cells and
   the totals block, so a label can be asserted by the text actually drawn. */
function captureTextDraws(doc: JsPdf): TextDraw[] {
  const draws: TextDraw[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, , y] = args;
    if (typeof y === 'number') {
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const line of lines) draws.push({ text: line.trim(), y });
    }
    return original(...args);
  }) as typeof doc.text);
  return draws;
}

const drawn = (draws: TextDraw[]): string => draws.map((d) => d.text).join(' | ');

/** Render one SO and return every text draw. `paid` drives the totals block. */
async function renderSo(localTotalCenti: number, paidCenti: number): Promise<TextDraw[]> {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderSalesOrderInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./sales-order-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws = captureTextDraws(doc);
  await renderSalesOrderInto(
    doc,
    autoTable,
    {
      doc_no: 'SO-OVER-001',
      so_date: '2026-08-16',
      status: 'processing',
      debtor_code: 'CUST-001',
      debtor_name: 'Over Collect Sdn Bhd',
      agent: null, branding: null, venue: null, ref: null, po_doc_no: null, phone: null,
      address1: '2 Jalan Test', address2: null, address3: null, address4: null,
      mattress_sofa_centi: 0, bedframe_centi: localTotalCenti,
      accessories_centi: 0, others_centi: 0,
      local_total_centi: localTotalCenti,
      line_count: 1, currency: 'MYR', note: null,
      paid_centi_total: paidCenti,
    },
    [{
      id: 'item-1', item_group: 'BEDFRAME', item_code: 'SO-A',
      description: 'Sales order line 1', uom: 'UNIT', qty: 1,
      unit_price_centi: localTotalCenti, discount_centi: 0,
      total_centi: localTotalCenti, variants: null,
    }],
    [{
      paid_at: '2026-08-16', method: 'cash', merchant_provider: null,
      installment_months: null, approval_code: 'APPROVAL-XYZ',
      amount_centi: paidCenti, account_sheet: null,
      collected_by_name: 'Cashier One', note: null,
    }],
  );
  return draws;
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the SO print does not hide an over-collection', () => {
  test('an ordinary order still prints BALANCE DUE', async () => {
    const draws = await renderSo(400_000, 200_000);
    expect(draws.map((d) => d.text), drawn(draws)).toContain('BALANCE DUE');
    expect(draws.map((d) => d.text)).not.toContain('CREDIT BALANCE');
  }, 20_000);

  /* RM 4,000 order, RM 4,250 collected. The floored version printed
     "BALANCE DUE 0.00" and handed the customer a document asserting he was
     square while the business held RM 250 of his money. */
  test('an over-collected order prints CREDIT BALANCE, not a floored zero', async () => {
    const draws = await renderSo(400_000, 425_000);
    const texts = draws.map((d) => d.text);
    expect(texts, drawn(draws)).toContain('CREDIT BALANCE');
    expect(texts).not.toContain('BALANCE DUE');
    /* The figure is the excess as a positive credit — never "MYR -250.00",
       and never the "MYR 0.00" the floor used to print. fmtRm prefixes the
       currency, so the drawn cell is the whole string. */
    expect(texts, drawn(draws)).toContain('MYR 250.00');
    expect(texts).not.toContain('MYR -250.00');
    expect(texts).not.toContain('MYR 0.00');
  }, 20_000);
});
