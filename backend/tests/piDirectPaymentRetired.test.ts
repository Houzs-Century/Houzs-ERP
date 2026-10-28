/* docs/bugs/0889 — PATCH /purchase-invoices/:id/payment added a typed amount
 * straight onto a supplier invoice's paid_sen: no payment voucher, no journal
 * entry, no hold check, no approval, no clamp. The phone's Record Payment sheet
 * reached it. A supplier invoice is paid with an AP Payment voucher now, and the
 * route answers every call with a refusal that names where to go.
 *
 * Mounts the EXPORTED handler on a bare Hono app, like the company-scope suites:
 * the router's supabaseAuth bridge cannot run in this harness.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { retiredPiPaymentHandler } from '../src/scm/routes/purchase-invoices';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('PATCH /purchase-invoices/:id/payment is retired', () => {
  test('refuses a payment with a sentence naming the AP Payment, and reads or writes no table', async () => {
    const touched: string[] = [];
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, {
        from: (t: string) => { touched.push(t); throw new Error(`no table may be touched, got ${t}`); },
        rpc: (fn: string) => { touched.push(`rpc:${fn}`); throw new Error(`no rpc may run, got ${fn}`); },
      } as never);
      c.set('companyId' as never, 1 as never);
      await next();
    });
    app.patch('/purchase-invoices/:id/payment', retiredPiPaymentHandler as never);

    const res = await app.request('/purchase-invoices/pi-1/payment', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSen: 50_000, notes: 'paid by transfer' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('payment_voucher_required');
    expect(body.message).toContain('AP Payment');
    expect(touched).toEqual([]);
  });

  test('the router mounts the refusal, and no handler in the file adds an amount onto paid_sen', () => {
    const src = readFileSync(resolve(HERE, '../src/scm/routes/purchase-invoices.ts'), 'utf8');
    expect(src).toMatch(/purchaseInvoices\.patch\('\/:id\/payment', retiredPiPaymentHandler\);/);
    expect(src).not.toMatch(/paid_sen\s*\+\s*amount/);
  });
});
