/* A new supplier's code, numbered from its name (owner 2026-11-20:
   「正常我开supplier时，默认是公司名的字母；至于是400或405也要可以选」).
   Pinned: the rule itself (kind, the name's first letter, the NEXT number in
   that run, never a gap); the preview endpoint the forms fill the field from;
   and the create path numbering a supplier saved with no code — Finance picks
   400 or 405, a purchaser only opens trade suppliers, and a code held in the
   AutoCount creditor copy is not handed out again. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { createSupplierHandler, nextSupplierCodeHandler } from '../src/scm/routes/suppliers';
import { nextSupplierCode, supplierCodeLetter } from '../src/scm/shared/supplier-code';

const CO = 1;
const FINANCE = { id: 7, name: 'Carrie Ong', position_name: 'Finance Executive', position_policy: { cohort: 'full', can_move_money: true }, permissions_set: new Set<string>() };
const PURCHASER = { id: 11, name: 'Sim', position_name: 'Operation Executive', position_policy: { cohort: 'full', can_move_money: false }, permissions_set: new Set<string>() };

describe('the numbering rule', () => {
  test('kind, the first letter of the name, then the next number in that run', () => {
    expect(nextSupplierCode('405', 'Tenaga Nasional Berhad', ['405-T001', '400-T009', '405-A004'])).toBe('405-T002');
    expect(nextSupplierCode('400', 'tns sofa design', ['400-T002', '400-T004', '400-T005'])).toBe('400-T006');
    expect(nextSupplierCode('400', 'Brand New Maker', [])).toBe('400-B001');
  });

  test('the next number, never a gap: a gap is usually a renamed or retired creditor', () => {
    expect(nextSupplierCode('405', 'Charm', ['405-C001', '405-C006', '405-C007'])).toBe('405-C008');
  });

  test('leading punctuation is skipped; a digit-led name keeps its digit; no letter at all gives nothing', () => {
    expect(supplierCodeLetter('(M) Sdn Bhd')).toBe('M');
    expect(nextSupplierCode('405', '1MK Retail', ['405-1001'])).toBe('405-1002');
    expect(nextSupplierCode('400', '野人山棕', [])).toBeNull();
    expect(nextSupplierCode('400', '   ', [])).toBeNull();
  });
});

function harness(who: Row) {
  const sb = fakeSb({
    suppliers: [
      { id: 's-1', code: '405-T001', name: 'TENAGA NASIONAL BERHAD', company_id: CO },
      { id: 's-2', code: '400-T005', name: 'TODERN HOME SDN BHD', company_id: CO, for_purchasing: true },
      { id: 's-x', code: '405-T007', name: 'OTHER COMPANY TRANSPORT', company_id: 2 },
    ],
    supplier_material_bindings: [],
    /* The AutoCount copy holds 405-T003 for a creditor the ERP never opened. */
    creditors: [{ creditor_code: '405-T003', company_name: 'TS MOON GROUP TRADING', company_id: CO }],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, who as never);
    await next();
  });
  app.get('/suppliers/next-code', nextSupplierCodeHandler as never);
  app.post('/suppliers', createSupplierHandler as never);
  return { app, sb };
}

/* A Malaysian supplier carries a postcode (owner 2026-11-19), so every new one here does. */
const post = (app: Hono, body: Row) =>
  app.request('/suppliers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postcode: '47500', ...body }) });

describe('the preview the forms fill the code field from', () => {
  test('Finance numbers under the kind it picks, past both the suppliers and the AutoCount copy, in this company only', async () => {
    const { app } = harness(FINANCE);
    const res = await app.request('/suppliers/next-code?kind=405&name=Tiow%20Wai%20Keong');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ kind: '405', code: '405-T004' });
  });

  test('a purchaser is numbered as a trade supplier whatever kind it asks for', async () => {
    const { app } = harness(PURCHASER);
    const res = await app.request('/suppliers/next-code?kind=405&name=Twin%20Sofa');
    expect(await res.json()).toEqual({ kind: '400', code: '400-T006' });
  });
});

describe('saving a new supplier with no code', () => {
  test('Finance: the server numbers it, and an other creditor stays Finance-only unless the form says', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await post(app, { name: 'Tiow Wai Keong', codeKind: '405' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(sb.tables.suppliers.find((s) => s.name === 'TIOW WAI KEONG' || s.name === 'Tiow Wai Keong')).toMatchObject({ code: '405-T004', for_purchasing: false, company_id: CO });
  });

  test('Finance: a trade supplier saved without the purchasing flag is shared with purchasing', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await post(app, { name: 'Twin Sofa', codeKind: '400' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(sb.tables.suppliers.find((s) => /twin sofa/i.test(String(s.name)))).toMatchObject({ code: '400-T006', for_purchasing: true });
  });

  test('Finance: the form\'s own purchasing flag still wins', async () => {
    const { app, sb } = harness(FINANCE);
    const res = await post(app, { name: 'Tiow Wai Keong', codeKind: '405', forPurchasing: true });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(sb.tables.suppliers.find((s) => s.code === '405-T004')).toMatchObject({ for_purchasing: true });
  });

  test('a purchaser opens a trade supplier, shared, even when it asks for 405', async () => {
    const { app, sb } = harness(PURCHASER);
    const res = await post(app, { name: 'Twin Sofa', codeKind: '405' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(sb.tables.suppliers.find((s) => /twin sofa/i.test(String(s.name)))).toMatchObject({ code: '400-T006', for_purchasing: true });
  });

  test('a typed code is kept as typed; a name with no letter to number from asks for one', async () => {
    const { app, sb } = harness(FINANCE);
    const typed = await post(app, { code: '405-T050', name: 'Typed Code Co' });
    expect(typed.status, await typed.clone().text()).toBe(201);
    expect(sb.tables.suppliers.some((s) => s.code === '405-T050')).toBe(true);
    const none = await post(app, { name: '野人山棕' });
    expect(none.status).toBe(400);
    expect(((await none.json()) as Row).error).toBe('code_required');
  });
});
