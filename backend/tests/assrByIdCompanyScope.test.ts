/* Service Cases by id, across companies.
 *
 * Company A's session asking for company B's case by id gets 404 and no data:
 * no portal / sales / supplier link is minted, no creditor lookup runs, and a
 * PATCH changes nothing. The by-id statements now carry assrCompanySql
 * themselves, so they no longer lean only on the enforceCaseScope middleware.
 *
 * The cost suggestion read the purchase order by doc_no alone. PO numbers come
 * from each company's own AutoCount and are not unique across companies, so a
 * case could price itself from the other company's PO line. It now reads the
 * PO in the CASE's company.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

const CO_A = 1;
const CO_B = 2;

const mountAs = (): Hono => {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    c.set('user' as never, { id: 1, position_name: 'Super Admin', permissions: ['*'], permissions_set: new Set(['*']) } as never);
    c.set('userId' as never, 1 as never);
    c.set('companies' as never, [{ id: CO_A, code: 'HOUZS' }, { id: CO_B, code: '2990' }] as never);
    c.set('companyId' as never, CO_A as never);
    c.set('allowedCompanyIds' as never, [CO_A] as never);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
};

const req = (path: string, method = 'GET', body?: unknown) =>
  mountAs().request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);

async function addCompanyColumn(table: string) {
  try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN company_id INTEGER`).run(); } catch { /* already there */ }
}

beforeAll(async () => {
  await addCompanyColumn('assr_cases');
  await addCompanyColumn('purchase_orders');
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM case_track_tokens');
  await env.DB.exec('DELETE FROM assr_cases');
  await env.DB.exec('DELETE FROM purchase_orders');
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, customer_name, item_code, po_no, assigned_to, company_id)
     VALUES (101, 'ASSR-A-1', 'HC-SO-1', 'Own Customer', 'ITEM-1', 'PO-1', NULL, ?),
            (202, 'ASSR-B-1', '2990-SO-9', 'Other Company Customer', 'ITEM-1', 'PO-1', NULL, ?)`,
  ).bind(CO_A, CO_B).run();
});

describe('company A asking for company B\'s case by id', () => {
  test.each([
    ['POST', '/202/track-link'],
    ['POST', '/202/sales-link'],
    ['POST', '/202/supplier-link'],
    ['POST', '/202/resolve-creditor'],
    ['GET', '/202/cost-suggestion'],
  ])('%s %s answers 404 with no data', async (method, path) => {
    const res = await req(path, method);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('token');
    expect(text).not.toContain('Other Company Customer');
  });

  test('no portal link was minted for the foreign case', async () => {
    await req('/202/track-link', 'POST');
    await req('/202/sales-link', 'POST');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM case_track_tokens WHERE assr_id = 202').first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  test('PATCH answers 404 and changes nothing', async () => {
    const res = await req('/202', 'PATCH', { customer_name: 'Rewritten' });
    expect(res.status).toBe(404);
    const row = await env.DB.prepare('SELECT customer_name FROM assr_cases WHERE id = 202').first<{ customer_name: string }>();
    expect(row?.customer_name).toBe('Other Company Customer');
  });

  test('its own case still mints a link', async () => {
    const res = await req('/101/track-link', 'POST');
    expect(res.status).toBe(201);
  });
});

describe('cost suggestion prices from the case\'s own company PO', () => {
  test('a PO line with the same number in company B is not used for company A\'s case', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_orders (doc_no, item_code, remaining_qty, original_qty, unit_price, company_id)
       VALUES ('PO-1', 'ITEM-1', 1, 2, 500, ?)`,
    ).bind(CO_B).run();
    const res = await req('/101/cost-suggestion');
    expect(res.status).toBe(200);
    const body = await res.json() as { po_amount: number | null };
    expect(body.po_amount).toBeNull();
  });

  test('its own company\'s PO line is used', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_orders (doc_no, item_code, remaining_qty, original_qty, unit_price, company_id)
       VALUES ('PO-1', 'ITEM-1', 1, 2, 500, ?)`,
    ).bind(CO_A).run();
    const res = await req('/101/cost-suggestion');
    expect(res.status).toBe(200);
    const body = await res.json() as { po_amount: number | null };
    expect(body.po_amount).toBe(1000);
  });
});
