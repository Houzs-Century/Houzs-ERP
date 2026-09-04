/* The Payment Voucher sheet — what it DRAWS (owner 2026-09-03: 我发现没有办法
 * print pv). Assertions ride `doc.text` captures, the packing-list technique.
 *
 * What is worth pinning here and the rest is layout:
 *   1. THE FOUR-LAYER STRIP IS THE SIGNATURE BLOCK. Prepared/Checked/Approved
 *      print the RECORDED name and date; Received by prints its placeholder
 *      and nothing else — that box is for the payee's pen.
 *   2. THE STATUS WORD COMES FROM THE ONE HOME. POSTED must print whatever
 *      statusLabel('pv', 'POSTED') says (the owner's "Approved"), never a
 *      hand-typed casing of the raw status.
 *   3. MONEY WORDS ARE MYR-ONLY. A MYR voucher spells its total (RINGGIT
 *      MALAYSIA …); a CNY voucher must NOT — spelling yuan as ringgit is a
 *      false sentence — and shows the ≈ posted-to-GL line instead.
 *   4. ACCOUNTS PRINT THROUGH THE CALLER'S NAMER — the table gives code and
 *      name their own columns (owner 2026-09-04), Paid From stays one joined
 *      string, and the GL address on paper matches the screen. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from '../../../lib/branding';
import { statusLabel } from './status-pill';
import type { PvPdfAllocation, PvPdfHeader, PvPdfLine } from './payment-voucher-pdf';

type JsPdf = import('jspdf').jsPDF;
type TextDraw = { text: string; y: number };

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

/* Ordinary ASCII in the fixture: no CJK font fetch, no logo fetch, no network. */
const setUpBranding = () => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const HEADER: PvPdfHeader = {
  pv_number: 'HC-PV-2609-012', status: 'POSTED', voucher_date: '2026-09-03',
  payee_name: 'ABC Freight Forwarding', notes: 'Bill INV-88',
  currency: 'MYR', exchange_rate: 1, credit_account_code: '310-0010',
  total_sen: 123456,
  supplier: null,
  submitted_at: '2026-09-03T01:00:00Z', submitted_by: 'Ah Hua',
  checked_at: '2026-09-03T02:00:00Z',   checked_by: 'Mei Ling',
  approved_at: '2026-09-03T03:00:00Z',  approved_by: 'The Boss',
};
const LINES: PvPdfLine[] = [
  { description: 'Freight — container', debit_account_code: '900-A002', amount_sen: 100000 },
  { description: null, debit_account_code: '900-A002', amount_sen: 23456 },
];
const ALLOCS: PvPdfAllocation[] = [
  { invoiceNumber: '2990-PI-2609-001', supplierInvoiceRef: 'INV-88', amountSen: 100000 },
];

const nameOf = (code: string) => (code === '310-0010' ? 'Bank — Maybank'
  : code === '900-A002' ? 'Advertisement' : null);

async function render(over: Partial<PvPdfHeader> = {}, allocations: PvPdfAllocation[] = ALLOCS): Promise<TextDraw[]> {
  setUpBranding();
  const [{ jsPDF }, { default: autoTable }, { renderPaymentVoucherInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./payment-voucher-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws = captureTextDraws(doc);
  await renderPaymentVoucherInto(doc, autoTable, { ...HEADER, ...over }, LINES, allocations, nameOf);
  return draws;
}

const has = (draws: TextDraw[], needle: string): boolean =>
  draws.some((d) => d.text.includes(needle));

describe('the payment voucher sheet', () => {
  test('the four-layer strip is the signature block — recorded names in their boxes, Received by left blank', async () => {
    const draws = await render();
    for (const boxLabel of ['Prepared by', 'Checked by', 'Approved by', 'Received by']) {
      expect(has(draws, boxLabel), boxLabel).toBe(true);
    }
    expect(has(draws, 'Ah Hua')).toBe(true);
    expect(has(draws, 'Mei Ling')).toBe(true);
    expect(has(draws, 'The Boss')).toBe(true);
    /* The empty box keeps its placeholder — one 'Name / Date' for the one
       unsigned cell (the other three carry real dates instead). */
    expect(draws.filter((d) => d.text === 'Name / Date')).toHaveLength(1);
  });

  test('the status word comes from the one home — POSTED prints as statusLabel says, not as the raw status', async () => {
    const draws = await render();
    expect(has(draws, statusLabel('pv', 'POSTED'))).toBe(true);
    /* And the essentials around it. */
    expect(has(draws, 'PAYMENT VOUCHER')).toBe(true);
    expect(has(draws, 'HC-PV-2609-012')).toBe(true);
    expect(has(draws, 'ABC Freight Forwarding')).toBe(true);
    /* Paid From stays ONE joined string… */
    expect(has(draws, '310-0010 · Bank — Maybank')).toBe(true);
    /* …but the TABLE gives code and name their OWN columns (owner
       2026-09-04): both drawn, never as the joined pair. */
    expect(has(draws, 'Account Code')).toBe(true);
    expect(has(draws, 'Account Name')).toBe(true);
    expect(has(draws, '900-A002')).toBe(true);
    expect(has(draws, 'Advertisement')).toBe(true);
    expect(has(draws, '900-A002 · Advertisement')).toBe(false);
    expect(has(draws, '2990-PI-2609-001')).toBe(true);
  });

  test('MYR spells the total in words; a foreign voucher must NOT, and shows the posted-to-GL line instead', async () => {
    const myr = await render();
    expect(has(myr, 'RINGGIT MALAYSIA')).toBe(true);
    expect(has(myr, '≈ posted to GL')).toBe(false);

    const cny = await render({ currency: 'CNY', exchange_rate: 0.62 });
    expect(has(cny, 'RINGGIT MALAYSIA')).toBe(false);
    expect(has(cny, '≈ posted to GL')).toBe(true);
    expect(has(cny, 'CNY @ 0.62')).toBe(true);
  });

  test('no settlement, no settlement table', async () => {
    const draws = await render({}, []);
    expect(has(draws, 'Settles invoice')).toBe(false);
  });
});
