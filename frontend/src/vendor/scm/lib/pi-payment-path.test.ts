import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AP_PAYMENT_AREA,
  apPaymentHrefFor,
  canOpenApPayment,
  piAwaitsPayment,
} from './pi-payment-path';
import { stripComments } from '../../../auth/sourceScan.testutil';

const PAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../pages/scm-v2');

const pi = (over: Record<string, unknown> = {}) => ({
  id: 'pi-1', status: 'POSTED', total_sen: 255_000, paid_sen: 0, supplier: { id: 'sup-1' }, ...over,
});

describe('piAwaitsPayment — the invoices the AP Payment page will offer', () => {
  it('a confirmed invoice with money owed takes a payment, fully or partly unpaid', () => {
    expect(piAwaitsPayment(pi())).toBe(true);
    expect(piAwaitsPayment(pi({ status: 'PARTIALLY_PAID', paid_sen: 100_000 }))).toBe(true);
  });

  it('a draft, a cancelled or a paid invoice does not', () => {
    expect(piAwaitsPayment(pi({ status: 'DRAFT' }))).toBe(false);
    expect(piAwaitsPayment(pi({ status: 'CANCELLED' }))).toBe(false);
    expect(piAwaitsPayment(pi({ status: 'PAID', paid_sen: 255_000 }))).toBe(false);
  });

  it('nothing owed means nothing to pay, whatever the status still says', () => {
    expect(piAwaitsPayment(pi({ paid_sen: 255_000 }))).toBe(false);
    expect(piAwaitsPayment(pi({ total_sen: 0 }))).toBe(false);
  });

  it('a held invoice does not — the voucher route refuses it (allocation_on_hold)', () => {
    expect(piAwaitsPayment(pi({ on_hold: true }))).toBe(false);
    expect(piAwaitsPayment(pi({ status: 'ON_HOLD' }))).toBe(false);
  });

  it('an unloaded header is not payable', () => {
    expect(piAwaitsPayment(null)).toBe(false);
    expect(piAwaitsPayment(undefined)).toBe(false);
  });
});

describe('apPaymentHrefFor — the AP Payment with the invoice already chosen', () => {
  it('names the document type, the supplier and the invoice', () => {
    const href = apPaymentHrefFor(pi());
    const url = new URL(href, 'https://erp.test');
    expect(url.pathname).toBe('/scm/payment-vouchers/new');
    expect(url.searchParams.get('type')).toBe('ap');
    expect(url.searchParams.get('supplier')).toBe('sup-1');
    expect(url.searchParams.get('pi')).toBe('pi-1');
  });

  it('leaves the supplier for the operator when the invoice row did not carry one', () => {
    const url = new URL(apPaymentHrefFor(pi({ supplier: null })), 'https://erp.test');
    expect(url.searchParams.has('supplier')).toBe(false);
    expect(url.searchParams.get('pi')).toBe('pi-1');
  });
});

describe('canOpenApPayment — the doors ScmGuard opens for the AP Payment route', () => {
  const none = () => 'none';
  it('scm.access opens it', () => {
    expect(canOpenApPayment((p) => p === 'scm.access', none)).toBe(true);
  });
  it('the accounting page grant opens it', () => {
    expect(canOpenApPayment(() => false, (k) => (k === AP_PAYMENT_AREA ? 'view' : 'none'))).toBe(true);
  });
  it('a purchasing clerk with only the purchase invoice area does not', () => {
    expect(canOpenApPayment(() => false, (k) => (k === 'scm.procurement.pi' ? 'edit' : 'none'))).toBe(false);
  });
});

/* docs/bugs/0889 — the desktop's Record payment navigated to `?tab=payments&record=1`
   on the invoice's own page, which reads neither, and its Mark paid sent RM0 to a
   route that refuses anything but a positive amount. Both buttons now lead to the
   AP Payment, or are gone. */
describe('the desktop purchase invoice screens pay through the AP Payment', () => {
  for (const file of ['PurchaseInvoiceDetailV2.tsx', 'PurchaseInvoicesListV2.tsx']) {
    it(`${file}: Record payment opens the AP Payment, and nothing records a payment in place`, () => {
      const src = stripComments(readFileSync(resolve(PAGES, file), 'utf8'));
      expect(src).toMatch(/navigate\(apPaymentHrefFor\(/);
      expect(src).toMatch(/piAwaitsPayment\(/);
      expect(src).toMatch(/canOpenApPayment\(can, pageAccess\)/);
      expect(src).not.toMatch(/tab=payments&record=1/);
      expect(src).not.toMatch(/useRecordPiPayment|Mark paid/);
      expect(src).not.toMatch(/purchase-invoices\/[^"'`]*\/payment\b/);
    });
  }
});
