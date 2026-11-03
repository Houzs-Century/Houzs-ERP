/* Supplier bills on paper (batch 4 step 8) — printSupplierBills. Pinned:
     • every paper is read fresh, in the order given, and starts on a fresh
       page of ONE document — an AP bill as the AP BILL, a supplier credit
       note as the note print, a purchase invoice as Procurement's;
     • without files nothing goes to the Worker; with files each paper renders
       as its own PDF and the parts go to POST /ap-invoices/print-bundle in
       order, and what comes back is what is delivered;
     • purchase invoices alone keep no files here, so they never call the Worker;
     • a paper that cannot be read fails the whole print by its number.
   Ordinary ASCII in the fixtures: no CJK font fetch, no logo fetch. */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';

const reads: string[] = [];
let refuse: string | null = null;
vi.mock('./authed-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authed-fetch')>()),
  authedFetch: async (path: string) => {
    reads.push(path);
    if (refuse && path.includes(refuse)) throw new Error('HTTP 403 — you may not read this.');
    if (path === '/accounting/accounts') return { accounts: [{ account_code: '900-A001', account_name: 'RENTAL' }, { account_code: '612-0000', account_name: 'PURCHASES RETURN' }] };
    if (path.startsWith('/ap-invoices/')) {
      return {
        invoice: {
          invoice_number: '2990-API-2609-001', doc_kind: 'INV', status: 'POSTED', invoice_date: '2026-09-01', due_date: '2026-09-30',
          supplier_invoice_ref: 'HVH-0912', currency: 'MYR', total_sen: 420_000, paid_sen: 0, notes: null, je_no: '2990-JE-2609-0030',
        },
        lines: [{ description: 'Rent Sept', debit_account_code: '900-A001', amount_sen: 420_000 }],
        supplier: { code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
        controlCode: '405-0000',
      };
    }
    if (path.startsWith('/credit-notes/')) {
      return {
        note: {
          note_number: '2990-SCN-2610-001', kind: 'SCN', status: 'POSTED', note_date: '2026-10-05', party_name: 'HOOKKA INDUSTRIES SDN. BHD.', party_code: '400-H004',
          so_doc_no: null, source_doc_no: 'CN-77', sales_invoice_number: null, reason: 'Short delivery', total_sen: 50_000, je_no: '2990-JE-2610-0100',
        },
        lines: [{ description: 'Short delivery', account_code: '612-0000', amount_sen: 50_000 }],
      };
    }
    if (path.startsWith('/purchase-invoices/')) return { purchaseInvoice: { invoice_number: '2990-PI-2607-005' }, items: [] };
    throw new Error(`unexpected read ${path}`);
  },
}));
/* Procurement's own print reads the supplier's catalogue; here it only says where it drew. */
const piDrawnOnPage: number[] = [];
vi.mock('./purchase-invoice-pdf', () => ({
  renderPurchaseInvoiceInto: async (doc: import('jspdf').jsPDF, _autoTable: unknown, header: { invoice_number: string }) => {
    piDrawnOnPage.push(doc.getNumberOfPages());
    doc.text(`PURCHASE INVOICE ${header.invoice_number}`, 20, 20);
  },
}));
const BUNDLED = new Blob(['%PDF-bundle'], { type: 'application/pdf' });
const bundle = vi.fn(async (_path: string, _parts: unknown[]) => BUNDLED);
vi.mock('./payment-voucher-queries', () => ({ fetchPrintBundle: (path: string, parts: unknown[]) => bundle(path, parts), fetchPvPrintBundle: vi.fn() }));
const delivered = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdf-common')>()),
  deliverPdfBlob: (...args: unknown[]) => delivered(...args),
}));

import { printSupplierBills, type BillPrintDoc } from './supplier-bills-print';

const API: BillPrintDoc = { kind: 'API', id: 'api-1', number: '2990-API-2609-001' };
const SCN: BillPrintDoc = { kind: 'SCN', id: 'scn-1', number: '2990-SCN-2610-001' };
const PI: BillPrintDoc = { kind: 'PI', id: 'pi-1', number: '2990-PI-2607-005' };

beforeEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  reads.length = 0; piDrawnOnPage.length = 0; refuse = null;
  bundle.mockClear(); delivered.mockClear();
});
afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
});

describe('printSupplierBills', () => {
  test('without files: each paper read fresh in order, a fresh page each, one document, no Worker', async () => {
    await printSupplierBills([API, SCN, PI], { withFiles: false, action: 'print' });
    expect(reads).toEqual(['/accounting/accounts', '/ap-invoices/api-1', '/credit-notes/scn-1', '/purchase-invoices/pi-1']);
    /* The bill took page 1, the note page 2: the purchase invoice starts on page 3. */
    expect(piDrawnOnPage).toEqual([3]);
    expect(bundle).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledTimes(1);
    const [blob, name, action] = delivered.mock.calls[0]! as [Blob, string, string];
    expect(blob.size).toBeGreaterThan(1000);
    expect(name).toBe('supplier-bills.pdf');
    expect(action).toBe('print');
  });

  test('with files: one rendered PDF per paper goes to the Worker in order, and its answer is what is delivered', async () => {
    await printSupplierBills([SCN, API, PI], { withFiles: true, action: 'save' });
    expect(bundle).toHaveBeenCalledTimes(1);
    const [path, parts] = bundle.mock.calls[0]! as [string, Array<{ kind: string; id: string; pageBase64: string }>];
    expect(path).toBe('/ap-invoices/print-bundle');
    expect(parts.map((p) => `${p.kind}:${p.id}`)).toEqual(['SCN:scn-1', 'API:api-1', 'PI:pi-1']);
    for (const p of parts) expect(atob(p.pageBase64).startsWith('%PDF')).toBe(true);
    /* Each paper on its own document: the purchase invoice draws on page 1 of ITS file. */
    expect(piDrawnOnPage).toEqual([1]);
    const [blob, name, action] = delivered.mock.calls[0]! as [Blob, string, string];
    expect(blob).toBe(BUNDLED);
    expect(name).toBe('supplier-bills.pdf');
    expect(action).toBe('save');
  });

  test('purchase invoices keep no files here: with files asked, nothing goes to the Worker; one paper is named by its number', async () => {
    await printSupplierBills([PI], { withFiles: true, action: 'print' });
    expect(bundle).not.toHaveBeenCalled();
    expect(delivered.mock.calls[0]![1]).toBe('2990-PI-2607-005.pdf');
  });

  test('a paper that cannot be read fails the whole print by its number; nothing is delivered', async () => {
    refuse = '/credit-notes/';
    await expect(printSupplierBills([API, SCN], { withFiles: true, action: 'print' }))
      .rejects.toThrow('2990-SCN-2610-001 could not be printed — HTTP 403 — you may not read this.');
    expect(bundle).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  test('nothing to print does nothing', async () => {
    await printSupplierBills([], { withFiles: true, action: 'print' });
    expect(reads).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
  });
});
