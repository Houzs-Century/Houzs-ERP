import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';
import { getCaseAddress } from '../src/services/assrCaseAddress';

/* Owner 2026-11-17: the Service Case's address in the SO's format — lines +
   Postcode + City + State — filled from the SO when the SO is picked, editable,
   and carried on. Postcode / City / State live in assr_case_address (1:1). */

const USER = {
  id: 1,
  permissions_set: new Set(['service_cases.create', 'service_cases.write', 'service_cases.manage']),
} as any;

function mount() {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', USER);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let seq = 0;
async function createCase() {
  const res = await mount().request(
    '/',
    json('POST', { doc_no: `SO-ADDR-NEW-${++seq}`, items: [{ item_code: 'ITM-1' }], complaint_issue: 'Torn', issue_category: 'Product Defect' }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

async function mirrorSo(docNo: string, lines: [string | null, string | null, string | null, string | null]) {
  await env.DB.prepare(
    `INSERT INTO sales_orders (doc_no, region, debtor_name, phone, inv_addr1, inv_addr2, inv_addr3, inv_addr4)
     VALUES (?, 'WEST', 'Lim Ah Kow', '0124445555', ?, ?, ?, ?)`,
  )
    .bind(docNo, ...lines)
    .run();
}

const patch = (id: number, body: Record<string, unknown>) => mount().request(`/${id}`, json('PATCH', body), env);
const lines = (id: number) =>
  env.DB.prepare(`SELECT addr1, addr2, addr3, addr4, customer_name FROM assr_cases WHERE id = ?`).bind(id).first<Record<string, string | null>>();

describe('Service case address in the SO format', () => {
  test('picking the SO fills the address lines and the postcode / state they name', async () => {
    const id = await createCase();
    await mirrorSo('SO-ADDR-1', ['1-G-9 Halaman Teratai', 'lebuh nipah 2', '11900 Bayan Lepas', 'PENANG']);
    expect((await patch(id, { doc_no: 'SO-ADDR-1' })).status).toBe(200);
    expect(await lines(id)).toMatchObject({
      addr1: '1-G-9 Halaman Teratai', addr2: 'lebuh nipah 2', addr3: '11900 Bayan Lepas', addr4: 'PENANG', customer_name: 'Lim Ah Kow',
    });
    expect(await getCaseAddress(env as any, id)).toEqual({ postcode: '11900', city: null, state: 'Pulau Pinang' });
  });

  test('an address sent with the SO change wins over the SO', async () => {
    const id = await createCase();
    await mirrorSo('SO-ADDR-2', ['From the SO', null, '47300 Petaling Jaya', 'Selangor']);
    expect((await patch(id, { doc_no: 'SO-ADDR-2', addr1: 'Typed by staff' })).status).toBe(200);
    expect(await lines(id)).toMatchObject({ addr1: 'Typed by staff', addr3: null });
    expect(await getCaseAddress(env as any, id)).toEqual({ postcode: null, city: null, state: null });
  });

  // The detail route merges getCaseAddress onto `case`; it cannot run on the D1
  // mirror (no companies table), so the stored row is what is asserted here.
  test('postcode / city / state save on their own and land on the timeline', async () => {
    const id = await createCase();
    expect((await patch(id, { postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' })).status).toBe(200);
    expect(await getCaseAddress(env as any, id)).toEqual({ postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' });
    const notes = await env.DB.prepare(`SELECT note FROM assr_activity WHERE assr_id = ? AND action = 'field_change' ORDER BY id`)
      .bind(id)
      .all<{ note: string }>();
    expect((notes.results ?? []).map((n) => n.note)).toEqual(expect.arrayContaining(['Postcode: (empty) → 11900', 'State: (empty) → Pulau Pinang']));
    // Clearing one part leaves the others.
    expect((await patch(id, { city: '' })).status).toBe(200);
    expect(await getCaseAddress(env as any, id)).toEqual({ postcode: '11900', city: null, state: 'Pulau Pinang' });
  });

  test('a non-text or over-long part is refused before anything is written', async () => {
    const id = await createCase();
    const res = await patch(id, { city: 'x'.repeat(81), addr1: 'Should not save' });
    expect(res.status).toBe(400);
    expect(await lines(id)).toMatchObject({ addr1: null });
    expect((await patch(id, { postcode: 11900 })).status).toBe(400);
  });
});
