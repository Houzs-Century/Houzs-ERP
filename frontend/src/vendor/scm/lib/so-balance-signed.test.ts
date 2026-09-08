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
  test('the server-stamped balance_sen wins, negative included', () => {
    // GET /:docNo computes this with soBalanceSen and it is already signed;
    // the client must pass it through rather than re-floor it.
    expect(deriveBalance({ balance_sen: -25_000 })).toBe(-25_000);
    expect(deriveBalance({ balance_sen: 0 })).toBe(0);
    expect(deriveBalance({ balance_sen: 200_000 })).toBe(200_000);
  });

  test('the local fallback goes negative by exactly the excess', () => {
    expect(deriveBalance({ local_total_sen: 400_000, paid_sen_total: 425_000 }))
      .toBe(-25_000);
  });

  test('an exact payment is still zero, and an under-payment still positive', () => {
    expect(deriveBalance({ local_total_sen: 400_000, paid_sen_total: 400_000 })).toBe(0);
    expect(deriveBalance({ local_total_sen: 400_000, paid_sen_total: 200_000 })).toBe(200_000);
  });

  test('it sums the payments ledger when no paid total was stamped', () => {
    expect(deriveBalance(
      { local_total_sen: 400_000 },
      [{ amount_sen: 200_000 }, { amount_sen: 225_000 }],
    )).toBe(-25_000);
  });

  /* The floor that must STAY. NO total at all is an order whose header has not
     been recomputed, not an order that has been credited. Without this guard
     such an order turns red for money nobody over-collected. */
  test('a zero total answers 0 rather than a huge false credit', () => {
    expect(deriveBalance({ local_total_sen: 0, paid_sen_total: 990_000 })).toBe(0);
    expect(deriveBalance({ paid_sen_total: 990_000 })).toBe(0);
  });
});

/* ── The server 0 that outranked a computable answer ────────────────────────
   The owner's order, 2026-09-08, on his phone: Total RM 3,200.00, Paid
   RM 1,600.00, Balance RM 0.00. `balance_sen` is stamped on every response, so
   `!= null` handed the server's 0 through and this function's own correct
   fallback was never reached. The server half is fixed too (soBalanceSen now
   falls back to local_total_sen); these pin the client half, which is what a
   cached or pre-deploy payload still goes through. */
describe('a server balance of 0 does not outrank a total we can subtract from', () => {
  test('the owner\'s order: 3,200 total, 1,600 paid, server says 0', () => {
    expect(deriveBalance({
      balance_sen: 0, local_total_sen: 320_000, paid_sen_total: 160_000,
    })).toBe(160_000);
  });

  test('over-collection stays signed through the same path', () => {
    expect(deriveBalance({
      balance_sen: 0, local_total_sen: 320_000, paid_sen_total: 400_000,
    })).toBe(-80_000);
  });

  test('it sums the ledger when the server stamped 0 and no paid total', () => {
    expect(deriveBalance(
      { balance_sen: 0, local_total_sen: 320_000 },
      [{ amount_sen: 160_000 }],
    )).toBe(160_000);
  });

  test('a genuinely settled order still reads 0 — same answer, computed', () => {
    expect(deriveBalance({
      balance_sen: 0, local_total_sen: 320_000, paid_sen_total: 320_000,
    })).toBe(0);
  });

  /* A NON-zero server balance is still authoritative: it is the only figure
     that carries the legacy header deposit rule (soPaidSen), which the client
     cannot see. */
  test('a non-zero server balance still wins over the local subtraction', () => {
    expect(deriveBalance({
      balance_sen: 200_000, local_total_sen: 320_000, paid_sen_total: 160_000,
    })).toBe(200_000);
  });

  /* A migrated order whose local_total_sen is absent too has no computable
     answer, so the server's 0 stands rather than becoming a guess. */
  test('with no total at all the server 0 is still what is shown', () => {
    expect(deriveBalance({ balance_sen: 0, paid_sen_total: 160_000 })).toBe(0);
  });

  /* total_revenue_sen is the fallback's fallback — a recomputed order that
     carries it but no local_total_sen must not read as "no total". */
  test('total_revenue_sen answers when local_total_sen is absent', () => {
    expect(deriveBalance({
      balance_sen: 0, total_revenue_sen: 320_000, paid_sen_total: 160_000,
    })).toBe(160_000);
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
async function renderSo(localTotalSen: number, paidSen: number): Promise<TextDraw[]> {
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
      mattress_sofa_sen: 0, bedframe_sen: localTotalSen,
      accessories_sen: 0, others_sen: 0,
      local_total_sen: localTotalSen,
      line_count: 1, currency: 'MYR', note: null,
      paid_sen_total: paidSen,
    },
    [{
      id: 'item-1', item_group: 'BEDFRAME', item_code: 'SO-A',
      description: 'Sales order line 1', uom: 'UNIT', qty: 1,
      unit_price_sen: localTotalSen, discount_sen: 0,
      total_sen: localTotalSen, variants: null,
    }],
    [{
      paid_at: '2026-08-16', method: 'cash', merchant_provider: null,
      installment_months: null, approval_code: 'APPROVAL-XYZ',
      amount_sen: paidSen, account_sheet: null,
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
