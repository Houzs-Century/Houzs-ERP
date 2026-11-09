/* Regression (sister fix hookka-erp-testing #604): a delivery return line with
 * a blank, zero or negative quantity got past the over-return cap.
 *
 * The cap read `qtyReturned ?? qty ?? 0` and the insert read `?? 1`, so a blank
 * line counted as 0 against a fully-returned DO line and was then stored as 1.
 * A negative line lowered "already returned" and made room to return more than
 * was delivered, putting goods back in stock and re-opening them for invoicing.
 *
 * These drive the REAL exported create / add-line handlers. The quantity rule
 * runs before any database read, so the fake client counts calls: a refused
 * request must not have touched a table at all.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createDeliveryReturnHandler, addDeliveryReturnItemHandler } from '../src/scm/routes/delivery-returns';
import { parseReturnLineQty, returnLineQtyMessage } from '../src/scm/shared/return-line-qty';

function harness() {
  const touched: string[] = [];
  const client = {
    from: (t: string) => { touched.push(t); throw new Error(`unexpected read of ${t}`); },
    rpc: () => { touched.push('rpc'); throw new Error('unexpected rpc'); },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, client as never);
    c.set('companyId' as never, 1 as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('companies' as never, [{ id: 1, code: 'HOUZS', name: 'Houzs Century' }] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/delivery-returns', createDeliveryReturnHandler as never);
  app.post('/delivery-returns/:id/items', addDeliveryReturnItemHandler as never);
  return { app, touched };
}

const post = (app: Hono, url: string, body: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const line = (extra: Record<string, unknown>) => ({ itemCode: 'MATT-A', doItemId: 'dl-1', unitPriceSen: 10000, ...extra });

describe('delivery return line quantity must be more than 0', () => {
  for (const [label, extra] of [
    ['blank (no qty at all)', {}],
    ['null', { qtyReturned: null }],
    ['empty text', { qtyReturned: '' }],
    ['zero', { qtyReturned: 0 }],
    ['negative', { qtyReturned: -3 }],
    ['not a number', { qtyReturned: 'abc' }],
  ] as const) {
    test(`create refuses a ${label} line with 400 before reading anything`, async () => {
      const { app, touched } = harness();
      const res = await post(app, '/delivery-returns', {
        debtorName: 'Cust', deliveryOrderId: 'do-1',
        items: [line({ qtyReturned: 5 }), line(extra)],
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe('invalid_qty');
      expect(body.message).toContain('more than 0');
      expect(touched).toEqual([]);
    });
  }

  test('add-line refuses a negative line with 400 before reading anything', async () => {
    const { app, touched } = harness();
    const res = await post(app, '/delivery-returns/dr-1/items', line({ qtyReturned: -1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_qty');
    expect(touched).toEqual([]);
  });

  test('add-line refuses a blank line (it used to be stored as 1)', async () => {
    const { app, touched } = harness();
    const res = await post(app, '/delivery-returns/dr-1/items', line({}));
    expect(res.status).toBe(400);
    expect(touched).toEqual([]);
  });

  test('a valid quantity passes the rule and goes on to the database checks', async () => {
    const { app, touched } = harness();
    const res = await post(app, '/delivery-returns', { debtorName: 'Cust', items: [line({ qtyReturned: 2 })] });
    // The throwing fake proves the request got past the quantity rule.
    expect(touched.length).toBeGreaterThan(0);
    expect(res.status).not.toBe(400);
  });
});

describe('parseReturnLineQty: one read for the cap and the insert', () => {
  test('positive numbers (and numeric text) pass as numbers', () => {
    expect(parseReturnLineQty(2)).toBe(2);
    expect(parseReturnLineQty('3')).toBe(3);
    expect(parseReturnLineQty(0.5)).toBe(0.5);
  });
  test('blank, zero, negative and junk are null', () => {
    for (const v of [undefined, null, '', '  ', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', true, {}]) {
      expect(parseReturnLineQty(v)).toBeNull();
    }
  });
  test('the message names the line and what was typed', () => {
    expect(returnLineQtyMessage('MATT-A', -3)).toBe('Return quantity must be more than 0 on every line (MATT-A is -3).');
    expect(returnLineQtyMessage(null, undefined)).toContain('a line is blank');
  });
});
