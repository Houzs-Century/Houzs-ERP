/* Product request (owner 2026-10-06: to request new product / repack product —
   要审批, Purchaser 批; Sales 都能提; 然后这个会连接 purchase consignment order).
   Pinned through the real router:
     • a Sales caller raises a request without any flat key; another Sales caller
       cannot see it; the Purchaser (scm.product_request.approve) sees all;
     • a repack must name an existing SKU; a new product names a SKU or a Model;
       a SKU not in the catalogue is refused;
     • the requester edits and withdraws their own; the Purchaser approves or
       rejects (a rejection needs its why); a rejected request resubmits;
     • a new-Model request cannot raise a PC Order until the Purchaser builds the
       Model + SKU from it — which lands ACTIVE, off POS, and names the request's
       SKU; the PC Order door then accepts it and the request reads PCO_ISSUED;
     • requireScmAccess admits a Sales caller and the keys for /product-requests
       and nothing else.
   Same fake-PostgREST harness as tests/paymentRequests.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { requireScmAccess } from '../src/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { productRequests } from '../src/scm/routes/product-requests';
import { loadRequestForPco, markRequestPcoIssued } from '../src/scm/lib/product-request-link';

const CO = 1;
type Who = { id: number; name: string; perms: string[]; position?: string; department?: string };
const AMY: Who = { id: 31, name: 'Amy Tan', perms: ['scm.access'], position: 'Sales Executive', department: 'Sales Department' };
const BEN: Who = { id: 32, name: 'Ben Lee', perms: ['scm.access'], position: 'Sales Person', department: 'Sales Department' };
const PURCHASER: Who = { id: 9, name: 'Chong', perms: ['scm.product_request.approve'], position: 'Procurement/Purchasing', department: 'Operation Department' };
const NOBODY: Who = { id: 50, name: 'Warehouse', perms: ['scm.access'], position: 'Storekeeper', department: 'Operation Department' };

function world() {
  const sb = fakeSb({
    companies: [{ id: CO, code: 'HC' }],
    product_requests: [],
    product_models: [{ id: 'model-5530', company_id: CO, model_code: '5530', name: 'SOFA 5530', category: 'SOFA', active: true, allowed_options: {} }],
    mfg_products: [{ id: 'mfg-1', company_id: CO, code: '5530-3S', name: 'SOFA 5530 3 SEATER', category: 'SOFA', status: 'ACTIVE', model_id: 'model-5530', base_model: '5530' }],
    fabric_trackings: [{ id: 'fab-1', company_id: CO, fabric_code: 'LIN-01', is_active: true }],
    warehouses: [{ id: 'wh-kl', company_id: CO, code: 'KL', name: 'KL Showroom' }],
    suppliers: [
      { id: 'sup-1', company_id: CO, code: '400-D001', name: 'DIGLANT FURNITURE', status: 'ACTIVE' },
      { id: 'sup-old', company_id: CO, code: '400-X001', name: 'RETIRED SUPPLIER', status: 'INACTIVE' },
      { id: 'sup-other', company_id: 2, code: '400-O001', name: 'OTHER CO SUPPLIER', status: 'ACTIVE' },
    ],
    purchase_consignment_orders: [],
    entity_audit_log: [],
  }, {}, [{ table: 'mfg_products', column: 'code', name: 'mfg_products_code_key' }]);
  sb.rpcHandlers.entity_audit_writable = () => true;
  return sb;
}

function as(sb: ReturnType<typeof world>, who: Who) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, {
      id: who.id, name: who.name, permissions_set: new Set(who.perms),
      position_name: who.position ?? null, department_name: who.department ?? null,
    } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/product-requests', productRequests);
  return async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Row };
  };
}

const NEW_SOFA = {
  requestType: 'NEW_PRODUCT', application: 'SHOWROOM', proposedModelName: 'Aurora', category: 'SOFA',
  compartment: '2S', fabricCode: 'LIN-01', seatSize: '22', legSize: '4', qty: 2,
  specialRemarks: 'Deeper seat than 5530', deliveryLocationId: 'wh-kl', expectedDeliveryDate: '2026-10-25',
};

describe('product request — raising one', () => {
  test('a Sales caller raises a request with no flat key; it is numbered PDR and waits for the Purchaser', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const res = await amy('/product-requests', 'POST', NEW_SOFA);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const r = res.body.request as Row;
    expect(r.request_no).toMatch(/^HC-PDR-\d{4}-001$/);
    expect(r.status).toBe('REQUESTED');
    expect(r.requested_by).toBe(AMY.id);
    expect(r.requested_by_name).toBe('Amy Tan');
    expect(r.item_code).toBeNull();
    expect(r.proposed_model_name).toBe('Aurora');
    expect(r.deliveryLocation).toEqual({ id: 'wh-kl', code: 'KL', name: 'KL Showroom' });
    expect(sb.tables.entity_audit_log.some((a) => a.entity_type === 'PRODUCT_REQUEST' && a.action === 'CREATE')).toBe(true);
  });

  test('a repack names an existing SKU; a SKU the catalogue has not got is refused; a storekeeper cannot raise one', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const noSku = await amy('/product-requests', 'POST', { ...NEW_SOFA, requestType: 'REPACK' });
    expect(noSku.status).toBe(400);
    expect(noSku.body.error).toBe('item_code_required');
    const unknown = await amy('/product-requests', 'POST', { ...NEW_SOFA, requestType: 'REPACK', itemCode: 'NOPE-1' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unknown_item');
    const ok = await amy('/product-requests', 'POST', { ...NEW_SOFA, requestType: 'REPACK', itemCode: '5530-3S', proposedModelName: null });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    /* The SKU fixes the Model and the category; the proposed name is moot. */
    expect((ok.body.request as Row).model_id).toBe('model-5530');
    expect((ok.body.request as Row).proposed_model_name).toBeNull();
    const nobody = await as(sb, NOBODY)('/product-requests', 'POST', NEW_SOFA);
    expect(nobody.status).toBe(403);
  });

  test('the supplier and agreed price ride the request; only this company\'s suppliers; the picker is open to a Sales caller', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    /* The picker: ACTIVE suppliers of this company, id / code / name only. */
    const opts = await amy('/product-requests/supplier-options');
    expect(opts.status).toBe(200);
    expect((opts.body.suppliers as Row[]).map((s) => s.code)).toEqual(['400-D001']);
    expect(Object.keys((opts.body.suppliers as Row[])[0]).sort()).toEqual(['code', 'id', 'name']);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, supplierId: 'sup-other' })).body.error).toBe('unknown_supplier');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, unitPriceSen: -1 })).body.error).toBe('price_invalid');
    const ok = await amy('/product-requests', 'POST', { ...NEW_SOFA, supplierId: 'sup-1', unitPriceSen: 185_000 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body.request as Row).supplier).toEqual({ id: 'sup-1', code: '400-D001', name: 'DIGLANT FURNITURE' });
    expect((ok.body.request as Row).unit_price_sen).toBe(185_000);
    /* An edit that says nothing about them keeps them. */
    const edited = await amy(`/product-requests/${(ok.body.request as Row).id}`, 'PATCH', { qty: 4 });
    expect((edited.body.request as Row).supplier_id).toBe('sup-1');
    expect((edited.body.request as Row).unit_price_sen).toBe(185_000);
  });

  test('an unknown fabric or delivery location is refused by name', async () => {
    const amy = as(world(), AMY);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, fabricCode: 'ZZZ' })).body.error).toBe('unknown_fabric');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, deliveryLocationId: 'wh-other' })).body.error).toBe('unknown_location');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, application: 'PARTY' })).body.error).toBe('application_invalid');
    /* A fair booth is the fourth use (owner 2026-10-07). */
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, application: 'FAIR_EXHIBITION' })).status).toBe(201);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, qty: 0 })).body.error).toBe('qty_invalid');
  });
});

describe('product request — who sees what', () => {
  test('a requester sees their own; another Sales caller sees nothing of it; the Purchaser sees all', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const { body } = await amy('/product-requests', 'POST', NEW_SOFA);
    const id = String((body.request as Row).id);
    expect(((await amy('/product-requests')).body.requests as Row[]).map((r) => r.id)).toEqual([id]);
    const ben = as(sb, BEN);
    expect((await ben('/product-requests')).body.requests).toEqual([]);
    expect((await ben(`/product-requests/${id}`)).status).toBe(404);
    const purchaser = as(sb, PURCHASER);
    const all = await purchaser('/product-requests');
    expect((all.body.requests as Row[]).map((r) => r.id)).toEqual([id]);
    expect(all.body.approver).toBe(true);
  });
});

describe('product request — the requester changes it', () => {
  test('edits while waiting; another person cannot; withdraws; a withdrawn one cannot change', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const edited = await amy(`/product-requests/${id}`, 'PATCH', { qty: 3, seatSize: '24' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((edited.body.request as Row).qty).toBe(3);
    expect((edited.body.request as Row).seat_size).toBe('24');
    /* The Purchaser may open it, but only the requester changes it. */
    expect((await as(sb, PURCHASER)(`/product-requests/${id}`, 'PATCH', { qty: 9 })).status).toBe(403);
    expect((await amy(`/product-requests/${id}/withdraw`, 'POST', {})).status).toBe(200);
    expect(sb.tables.product_requests[0].status).toBe('WITHDRAWN');
    expect((await amy(`/product-requests/${id}`, 'PATCH', { qty: 4 })).status).toBe(409);
  });
});

describe('product request — the Purchaser decides', () => {
  test('a Sales caller cannot approve; the Purchaser approves; approving twice is refused', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    expect((await amy(`/product-requests/${id}/approve`, 'POST', {})).status).toBe(403);
    const purchaser = as(sb, PURCHASER);
    const ok = await purchaser(`/product-requests/${id}/approve`, 'POST', { note: 'Go ahead' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.needsModel).toBe(true);
    const row = sb.tables.product_requests[0];
    expect(row.status).toBe('APPROVED');
    expect(row.decided_by).toBe('Chong');
    expect(row.decision_note).toBe('Go ahead');
    expect((await purchaser(`/product-requests/${id}/approve`, 'POST', {})).status).toBe(409);
    /* Approved: the requester can no longer withdraw it. */
    expect((await amy(`/product-requests/${id}/withdraw`, 'POST', {})).status).toBe(409);
  });

  test('a rejection says why; the requester fixes it and it goes back in, the old decision cleared', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const purchaser = as(sb, PURCHASER);
    expect((await purchaser(`/product-requests/${id}/reject`, 'POST', {})).status).toBe(400);
    expect((await purchaser(`/product-requests/${id}/reject`, 'POST', { note: 'We have 5530 in that fabric already' })).status).toBe(200);
    expect(sb.tables.product_requests[0].status).toBe('REJECTED');
    const again = await amy(`/product-requests/${id}`, 'PATCH', { itemCode: '5530-3S' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body.request as Row).status).toBe('REQUESTED');
    expect((again.body.request as Row).decision_note).toBeNull();
    expect((again.body.request as Row).item_code).toBe('5530-3S');
    expect(sb.tables.entity_audit_log.some((a) => a.action === 'SUBMIT_FOR_APPROVAL')).toBe(true);
  });
});

describe('product request — the new Model, then the PC Order', () => {
  test('no PC Order until the Model is built; the build makes the Model + an off-POS SKU and names it on the request; then the order claims the request', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const purchaser = as(sb, PURCHASER);
    /* Not approved yet: the PC Order door refuses. */
    const early = await loadRequestForPco(sb as never, CO, id);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.body.error).toBe('request_not_approved');
    await purchaser(`/product-requests/${id}/approve`, 'POST', {});
    /* Approved, but the Model does not exist: still refused, by name. */
    const noModel = await loadRequestForPco(sb as never, CO, id);
    expect(noModel.ok).toBe(false);
    if (!noModel.ok) expect(noModel.body.error).toBe('model_not_created');
    /* A Sales caller cannot build it; the Purchaser can — the code is required. */
    expect((await amy(`/product-requests/${id}/create-model`, 'POST', { modelCode: 'AURORA' })).status).toBe(403);
    expect((await purchaser(`/product-requests/${id}/create-model`, 'POST', {})).status).toBe(400);
    /* A code the catalogue already has is refused, not overwritten. */
    expect((await purchaser(`/product-requests/${id}/create-model`, 'POST', { modelCode: '5530', skuCode: '5530-3S' })).status).toBe(409);
    const built = await purchaser(`/product-requests/${id}/create-model`, 'POST', { modelCode: 'aurora' });
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    expect(built.body.sku).toMatchObject({ code: 'AURORA-2S' });
    const sku = sb.tables.mfg_products.find((p) => p.code === 'AURORA-2S');
    expect(sku).toMatchObject({ company_id: CO, category: 'SOFA', status: 'ACTIVE', pos_active: false, base_model: 'AURORA' });
    const model = sb.tables.product_models.find((m) => m.model_code === 'AURORA');
    expect(model).toMatchObject({ company_id: CO, category: 'SOFA', name: 'Aurora', active: true });
    expect(sku!.model_id).toBe(model!.id);
    const req = (built.body.request as Row);
    expect(req.item_code).toBe('AURORA-2S');
    expect(req.model_id).toBe(model!.id);
    expect(req.status).toBe('APPROVED');
    /* Building twice: the request already names its SKU. */
    expect((await purchaser(`/product-requests/${id}/create-model`, 'POST', { modelCode: 'AURORA2' })).status).toBe(409);
    /* Now the PC Order door accepts it, and the order claims the request once. */
    const ready = await loadRequestForPco(sb as never, CO, id);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    sb.tables.purchase_consignment_orders.push({ id: 'pco-1', company_id: CO, pc_number: 'HC-PCO-2610-001', status: 'SUBMITTED', source_product_request_id: id });
    const first = await markRequestPcoIssued(sb as never, CO, ready.request, { id: 'pco-1', pc_number: 'HC-PCO-2610-001' }, { id: PURCHASER.id, name: PURCHASER.name });
    expect(first.claimed).toBe(true);
    const second = await markRequestPcoIssued(sb as never, CO, ready.request, { id: 'pco-2', pc_number: 'HC-PCO-2610-002' }, { id: PURCHASER.id, name: PURCHASER.name });
    expect(second.claimed).toBe(false);
    const after = await purchaser(`/product-requests/${id}`);
    expect((after.body.request as Row).status).toBe('PCO_ISSUED');
    expect((after.body.request as Row).pco).toMatchObject({ id: 'pco-1', pcNumber: 'HC-PCO-2610-001' });
    /* Issued, it is refused again; and the Purchaser closes it. */
    const issued = await loadRequestForPco(sb as never, CO, id);
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(issued.body.error).toBe('request_already_issued');
    expect((await purchaser(`/product-requests/${id}/close`, 'POST', {})).status).toBe(200);
    expect(sb.tables.product_requests[0].status).toBe('CLOSED');
  });

  test('a request in another company is not a request at all', async () => {
    const sb = world();
    sb.tables.product_requests.push({ id: 'pr-x', company_id: 2, request_no: 'OT-PDR-2610-001', status: 'APPROVED', item_code: '5530-3S', requested_by: AMY.id });
    const found = await loadRequestForPco(sb as never, CO, 'pr-x');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.status).toBe(404);
    expect((await as(sb, PURCHASER)('/product-requests/pr-x')).status).toBe(404);
  });
});

describe('product request — the SCM umbrella', () => {
  const guard = (who: Who, path: string) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user' as never, {
        id: who.id, permissions_set: new Set(who.perms), permissions: who.perms,
        position_name: who.position ?? null, department_name: who.department ?? null, page_access: {},
      } as never);
      await next();
    });
    app.use('/api/scm/*', requireScmAccess as never);
    app.get('/api/scm/*', (c) => c.json({ ok: true }));
    return app.request(path);
  };
  test('a Sales caller with no SCM grant reaches /product-requests and nothing else; the approve key likewise', async () => {
    const sales: Who = { ...AMY, perms: [] };
    expect((await guard(sales, '/api/scm/product-requests')).status).toBe(200);
    expect((await guard(sales, '/api/scm/product-requests/abc')).status).toBe(200);
    expect((await guard(sales, '/api/scm/purchase-consignment-orders')).status).toBe(403);
    const approver: Who = { ...PURCHASER, position: 'Clerk', department: 'Operation Department' };
    expect((await guard(approver, '/api/scm/product-requests')).status).toBe(200);
    expect((await guard(approver, '/api/scm/mfg-products')).status).toBe(403);
    const nobody: Who = { ...NOBODY, perms: [] };
    expect((await guard(nobody, '/api/scm/product-requests')).status).toBe(403);
  });
});
