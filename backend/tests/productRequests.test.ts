/* Product request (owner 2026-10-06: to request new product / repack product —
   要审批, Purchaser 批; Sales 都能提; 然后这个会连接 purchase consignment order;
   2026-10-15 方案 A: a header plus LINES, like a PC Order). Pinned through the
   real router:
     • a Sales caller raises a request without any flat key; another Sales caller
       cannot see it; the Purchaser (scm.product_request.approve) sees all;
     • a request has at least one line; a repack line must name an existing SKU;
       a new-product line names a SKU or a Model; a SKU not in the catalogue is
       refused, and every refusal says which line;
     • the requester edits (lines replaced as a set) and withdraws their own; the
       Purchaser approves or rejects the WHOLE request (a rejection needs its
       why); a rejected request resubmits;
     • a request cannot raise a PC Order until EVERY new-Model line has its Model
       + SKU built — each lands ACTIVE, off POS, and names the line's SKU; the
       PC Order door then accepts it and the request reads PCO_ISSUED;
     • a Purchase Order raised instead (2990-0015) claims it through
       POST /:id/link-po — PO_ISSUED with po_id — under the same rules, and a
       request carries one order of either kind;
     • requireScmAccess admits a Sales caller and the keys for /product-requests
       and nothing else.
   Same fake-PostgREST harness as tests/paymentRequests.test.ts. */

import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { requireScmAccess } from '../src/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { productRequests } from '../src/scm/routes/product-requests';
import { loadRequestForPco, markRequestPcoIssued } from '../src/scm/lib/product-request-link';

const notified = vi.fn((_event: string, _opts: Record<string, unknown>) => undefined);
vi.mock('../src/services/productRequestNotify', () => ({
  notifyProductRequest: async (_env: unknown, event: string, opts: Record<string, unknown>) => { notified(event, opts); },
}));

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
    product_request_lines: [],
    product_request_files: [],
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
    purchase_orders: [
      { id: 'po-1', company_id: CO, po_number: 'HC-PO-2610-001', status: 'SUBMITTED', expected_at: '2026-10-30' },
      { id: 'po-other', company_id: 2, po_number: 'OT-PO-2610-001', status: 'SUBMITTED', expected_at: null },
    ],
    entity_audit_log: [],
  }, {}, [{ table: 'mfg_products', column: 'code', name: 'mfg_products_code_key' }]);
  sb.rpcHandlers.entity_audit_writable = () => true;
  return sb;
}

/* The SLIPS bucket, in memory — the file factory's only I/O beside the index row. */
const fakeR2 = () => {
  const store = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) => { store.set(k, { bytes: v, contentType: o?.httpMetadata?.contentType ?? '' }); },
    get: async (k: string) => {
      const hit = store.get(k);
      return hit ? { arrayBuffer: async () => hit.bytes, body: new Blob([hit.bytes]).stream(), httpMetadata: { contentType: hit.contentType } } : null;
    },
    delete: async (k: string) => { store.delete(k); },
  };
};
const R2 = fakeR2();

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
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { SLIPS: R2 });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() as Row : {} };
  };
}

const LINE_AURORA = { proposedModelName: 'Aurora', category: 'SOFA', compartment: '2S', fabricCode: 'LIN-01', seatSize: '22', legSize: '4', qty: 2, remarks: 'Deeper seat than 5530' };
const LINE_5530 = { itemCode: '5530-3S', fabricCode: 'LIN-01', qty: 1 };
const NEW_SOFA = {
  requestType: 'NEW_PRODUCT', application: 'SHOWROOM', specialRemarks: 'For the new showroom corner',
  deliveryLocationId: 'wh-kl', expectedDeliveryDate: '2026-10-25',
  lines: [LINE_AURORA],
};
const linesOf = (sb: ReturnType<typeof world>, requestId: string) => sb.tables.product_request_lines.filter((l) => String(l.request_id) === requestId).sort((a, b) => a.line_no - b.line_no);

describe('product request — raising one', () => {
  test('a Sales caller raises a request with no flat key; it is numbered PDR, carries its lines and waits for the Purchaser', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const res = await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [LINE_AURORA, LINE_5530] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const r = res.body.request as Row;
    expect(r.request_no).toMatch(/^HC-PDR-\d{4}-001$/);
    expect(r.status).toBe('REQUESTED');
    expect(r.requested_by).toBe(AMY.id);
    expect(r.requested_by_name).toBe('Amy Tan');
    expect(r.deliveryLocation).toEqual({ id: 'wh-kl', code: 'KL', name: 'KL Showroom' });
    const lines = r.lines as Row[];
    expect(lines.map((l) => [l.line_no, l.item_code, l.proposed_model_name, l.qty])).toEqual([[1, null, 'Aurora', 2], [2, '5530-3S', null, 1]]);
    /* The SKU fixes the line's Model and category; a new Model has neither yet. */
    expect(lines[1].model).toEqual({ id: 'model-5530', modelCode: '5530', name: 'SOFA 5530' });
    expect(lines[0].model).toBeNull();
    expect(linesOf(sb, String(r.id)).every((l) => l.company_id === CO)).toBe(true);
    expect(sb.tables.entity_audit_log.some((a) => a.entity_type === 'PRODUCT_REQUEST' && a.action === 'CREATE')).toBe(true);
  });

  test('no lines is refused; a repack line names an existing SKU; a SKU the catalogue has not got is refused by line; a storekeeper cannot raise one', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [] })).body.error).toBe('lines_required');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: undefined })).body.error).toBe('lines_required');
    const noSku = await amy('/product-requests', 'POST', { ...NEW_SOFA, requestType: 'REPACK', lines: [LINE_5530, LINE_AURORA] });
    expect(noSku.status).toBe(400);
    expect(noSku.body).toMatchObject({ error: 'item_code_required', message: expect.stringContaining('Line 2') });
    const unknown = await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [LINE_AURORA, { itemCode: 'NOPE-1', qty: 1 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: 'unknown_item', message: expect.stringContaining('Line 2') });
    const ok = await amy('/product-requests', 'POST', { ...NEW_SOFA, requestType: 'REPACK', lines: [{ ...LINE_5530, proposedModelName: 'moot' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    /* The SKU fixes the Model and the category; the proposed name is moot. */
    expect(((ok.body.request as Row).lines as Row[])[0]).toMatchObject({ model_id: 'model-5530', proposed_model_name: null, category: 'SOFA' });
    const nobody = await as(sb, NOBODY)('/product-requests', 'POST', NEW_SOFA);
    expect(nobody.status).toBe(403);
    /* A refused request leaves nothing behind. */
    expect(sb.tables.product_requests).toHaveLength(1);
    expect(sb.tables.product_request_lines).toHaveLength(1);
  });

  test("the supplier rides the header and the agreed price each line; only this company's suppliers; the picker is open to a Sales caller", async () => {
    const sb = world();
    const amy = as(sb, AMY);
    /* The picker: ACTIVE suppliers of this company, id / code / name only. */
    const opts = await amy('/product-requests/supplier-options');
    expect(opts.status).toBe(200);
    expect((opts.body.suppliers as Row[]).map((s) => s.code)).toEqual(['400-D001']);
    expect(Object.keys((opts.body.suppliers as Row[])[0]).sort()).toEqual(['code', 'id', 'name']);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, supplierId: 'sup-other' })).body.error).toBe('unknown_supplier');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [{ ...LINE_AURORA, unitPriceSen: -1 }] })).body).toMatchObject({ error: 'price_invalid', message: expect.stringContaining('Line 1') });
    const ok = await amy('/product-requests', 'POST', { ...NEW_SOFA, supplierId: 'sup-1', lines: [{ ...LINE_AURORA, unitPriceSen: 185_000 }, { ...LINE_5530, unitPriceSen: 120_000 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body.request as Row).supplier).toEqual({ id: 'sup-1', code: '400-D001', name: 'DIGLANT FURNITURE' });
    expect(((ok.body.request as Row).lines as Row[]).map((l) => l.unit_price_sen)).toEqual([185_000, 120_000]);
    /* An edit that says nothing about them keeps the supplier AND the lines. */
    const edited = await amy(`/product-requests/${(ok.body.request as Row).id}`, 'PATCH', { application: 'SAMPLE' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((edited.body.request as Row).supplier_id).toBe('sup-1');
    expect((edited.body.request as Row).application).toBe('SAMPLE');
    expect(((edited.body.request as Row).lines as Row[]).map((l) => l.unit_price_sen)).toEqual([185_000, 120_000]);
  });

  test('an unknown fabric or delivery location is refused by name; the line cap holds', async () => {
    const amy = as(world(), AMY);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [{ ...LINE_AURORA, fabricCode: 'ZZZ' }] })).body).toMatchObject({ error: 'unknown_fabric', message: expect.stringContaining('Line 1') });
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, deliveryLocationId: 'wh-other' })).body.error).toBe('unknown_location');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, application: 'PARTY' })).body.error).toBe('application_invalid');
    /* A fair booth is the fourth use (owner 2026-10-07). */
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, application: 'FAIR_EXHIBITION' })).status).toBe(201);
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [{ ...LINE_AURORA, qty: 0 }] })).body.error).toBe('qty_invalid');
    expect((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: Array.from({ length: 201 }, () => LINE_5530) })).body.error).toBe('too_many_lines');
  });
});

describe('product request — who sees what', () => {
  test('a requester sees their own; another Sales caller sees nothing of it; the Purchaser sees all', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const { body } = await amy('/product-requests', 'POST', NEW_SOFA);
    const id = String((body.request as Row).id);
    const mine = await amy('/product-requests');
    expect((mine.body.requests as Row[]).map((r) => r.id)).toEqual([id]);
    expect(((mine.body.requests as Row[])[0].lines as Row[]).map((l) => l.proposed_model_name)).toEqual(['Aurora']);
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
  test('edits the header and replaces the lines while waiting; another person cannot; withdraws; a withdrawn one cannot change', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const edited = await amy(`/product-requests/${id}`, 'PATCH', { expectedDeliveryDate: '2026-11-01', lines: [{ ...LINE_AURORA, qty: 3, seatSize: '24' }, LINE_5530] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((edited.body.request as Row).expected_delivery_date).toBe('2026-11-01');
    expect(((edited.body.request as Row).lines as Row[]).map((l) => [l.line_no, l.item_code ?? l.proposed_model_name, l.qty, l.seat_size])).toEqual([[1, 'Aurora', 3, '24'], [2, '5530-3S', 1, null]]);
    /* The old lines are gone, not kept beside the new ones. */
    expect(linesOf(sb, id)).toHaveLength(2);
    /* A bad line leaves the stored lines as they were. */
    expect((await amy(`/product-requests/${id}`, 'PATCH', { lines: [{ itemCode: 'NOPE-9' }] })).body.error).toBe('unknown_item');
    expect(linesOf(sb, id)).toHaveLength(2);
    /* The Purchaser may open it, but only the requester changes it. */
    expect((await as(sb, PURCHASER)(`/product-requests/${id}`, 'PATCH', { application: 'SAMPLE' })).status).toBe(403);
    expect((await amy(`/product-requests/${id}/withdraw`, 'POST', {})).status).toBe(200);
    expect(sb.tables.product_requests[0].status).toBe('WITHDRAWN');
    expect((await amy(`/product-requests/${id}`, 'PATCH', { application: 'SAMPLE' })).status).toBe(409);
  });
});

describe('product request — the Purchaser decides', () => {
  test('a Sales caller cannot approve; the Purchaser approves the whole request and is told how many Models to build; approving twice is refused', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [LINE_AURORA, LINE_5530, { ...LINE_AURORA, proposedModelName: 'Boreas' }] })).body.request as Row).id);
    expect((await amy(`/product-requests/${id}/approve`, 'POST', {})).status).toBe(403);
    const purchaser = as(sb, PURCHASER);
    const ok = await purchaser(`/product-requests/${id}/approve`, 'POST', { note: 'Go ahead' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.needsModel).toBe(true);
    expect(ok.body.pendingModels).toBe(2);
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
    const again = await amy(`/product-requests/${id}`, 'PATCH', { lines: [LINE_5530] });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body.request as Row).status).toBe('REQUESTED');
    expect((again.body.request as Row).decision_note).toBeNull();
    expect(((again.body.request as Row).lines as Row[]).map((l) => l.item_code)).toEqual(['5530-3S']);
    expect(sb.tables.entity_audit_log.some((a) => a.action === 'SUBMIT_FOR_APPROVAL')).toBe(true);
  });
});

describe('product request — the new Models, then the PC Order', () => {
  test('no PC Order until every new-Model line is built; each build makes the Model + an off-POS SKU and names it on its line; then the order claims the request', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const raised = (await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [LINE_AURORA, LINE_5530] })).body.request as Row;
    const id = String(raised.id);
    const auroraLine = String((raised.lines as Row[])[0].id);
    const skuLine = String((raised.lines as Row[])[1].id);
    const purchaser = as(sb, PURCHASER);
    /* Not approved yet: the PC Order door refuses. */
    const early = await loadRequestForPco(sb as never, CO, id);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.body.error).toBe('request_not_approved');
    await purchaser(`/product-requests/${id}/approve`, 'POST', {});
    /* Approved, but line 1's Model does not exist: still refused, by name. */
    const noModel = await loadRequestForPco(sb as never, CO, id);
    expect(noModel.ok).toBe(false);
    if (!noModel.ok) expect(noModel.body.error).toBe('model_not_created');
    /* A Sales caller cannot build it; the Purchaser can — the code is required. */
    expect((await amy(`/product-requests/${id}/lines/${auroraLine}/create-model`, 'POST', { modelCode: 'AURORA' })).status).toBe(403);
    expect((await purchaser(`/product-requests/${id}/lines/${auroraLine}/create-model`, 'POST', {})).status).toBe(400);
    /* A line that already names a SKU has no Model to build; a line not on the request is not found. */
    expect((await purchaser(`/product-requests/${id}/lines/${skuLine}/create-model`, 'POST', { modelCode: 'X' })).status).toBe(409);
    expect((await purchaser(`/product-requests/${id}/lines/nope/create-model`, 'POST', { modelCode: 'X' })).status).toBe(404);
    /* A code the catalogue already has is refused, not overwritten. */
    expect((await purchaser(`/product-requests/${id}/lines/${auroraLine}/create-model`, 'POST', { modelCode: '5530', skuCode: '5530-3S' })).status).toBe(409);
    const built = await purchaser(`/product-requests/${id}/lines/${auroraLine}/create-model`, 'POST', { modelCode: 'aurora' });
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    expect(built.body.sku).toMatchObject({ code: 'AURORA-2S' });
    expect(built.body.lineId).toBe(auroraLine);
    const sku = sb.tables.mfg_products.find((p) => p.code === 'AURORA-2S');
    expect(sku).toMatchObject({ company_id: CO, category: 'SOFA', status: 'ACTIVE', pos_active: false, base_model: 'AURORA' });
    const model = sb.tables.product_models.find((m) => m.model_code === 'AURORA');
    expect(model).toMatchObject({ company_id: CO, category: 'SOFA', name: 'Aurora', active: true });
    expect(sku!.model_id).toBe(model!.id);
    const req = (built.body.request as Row);
    expect((req.lines as Row[])[0]).toMatchObject({ item_code: 'AURORA-2S', model_id: model!.id, model: { modelCode: 'AURORA' } });
    expect(req.status).toBe('APPROVED');
    /* Building twice: the line already names its SKU. */
    expect((await purchaser(`/product-requests/${id}/lines/${auroraLine}/create-model`, 'POST', { modelCode: 'AURORA2' })).status).toBe(409);
    /* Now the PC Order door accepts it, with the lines, and the order claims the request once. */
    const ready = await loadRequestForPco(sb as never, CO, id);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect((ready.request.lines as Row[]).map((l) => [l.line_no, l.item_code, l.qty])).toEqual([[1, 'AURORA-2S', 2], [2, '5530-3S', 1]]);
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

  test('a Purchase Order raised instead claims the request (2990-0015): PO_ISSUED with po_id, once, and only for the Purchaser', async () => {
    const sb = world();
    const id = String(((await as(sb, AMY)('/product-requests', 'POST', { ...NEW_SOFA, lines: [LINE_5530] })).body.request as Row).id);
    const purchaser = as(sb, PURCHASER);
    /* Not approved yet: refused, nothing linked. */
    const early = await purchaser(`/product-requests/${id}/link-po`, 'POST', { poId: 'po-1' });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'request_not_approved', message: expect.stringContaining('raises a Purchase Order') });
    expect((await purchaser(`/product-requests/${id}/approve`, 'POST', {})).status).toBe(200);
    /* The requester cannot claim it; a PO in another company is not a PO; the body must name one. */
    expect((await as(sb, AMY)(`/product-requests/${id}/link-po`, 'POST', { poId: 'po-1' })).status).toBe(403);
    expect((await purchaser(`/product-requests/${id}/link-po`, 'POST', { poId: 'po-other' })).status).toBe(404);
    expect((await purchaser(`/product-requests/${id}/link-po`, 'POST', {})).body.error).toBe('po_id_required');
    const linked = await purchaser(`/product-requests/${id}/link-po`, 'POST', { poId: 'po-1' });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.poNumber).toBe('HC-PO-2610-001');
    const after = (await purchaser(`/product-requests/${id}`)).body.request as Row;
    expect(after).toMatchObject({ status: 'PO_ISSUED', po_id: 'po-1', pco: null, po: { id: 'po-1', poNumber: 'HC-PO-2610-001', status: 'SUBMITTED' } });
    expect(sb.tables.entity_audit_log.some((a) => a.entity_type === 'PRODUCT_REQUEST' && a.status_snapshot === 'PO_ISSUED')).toBe(true);
    /* One order per request: a second PO, or a PC Order on top, is refused. */
    expect((await purchaser(`/product-requests/${id}/link-po`, 'POST', { poId: 'po-1' })).body.error).toBe('request_already_issued');
    const pco = await loadRequestForPco(sb as never, CO, id);
    expect(pco.ok).toBe(false);
    if (!pco.ok) expect(pco.body).toMatchObject({ error: 'request_already_issued', message: expect.stringContaining('already has a Purchase Order') });
    expect((await purchaser(`/product-requests/${id}/close`, 'POST', {})).status).toBe(200);
    expect(sb.tables.product_requests[0].status).toBe('CLOSED');
  });

  test('a request in another company is not a request at all', async () => {
    const sb = world();
    sb.tables.product_requests.push({ id: 'pr-x', company_id: 2, request_no: 'OT-PDR-2610-001', status: 'APPROVED', requested_by: AMY.id });
    sb.tables.product_request_lines.push({ id: 'prl-x', company_id: 2, request_id: 'pr-x', line_no: 1, item_code: '5530-3S', qty: 1 });
    const found = await loadRequestForPco(sb as never, CO, 'pr-x');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.status).toBe(404);
    expect((await as(sb, PURCHASER)('/product-requests/pr-x')).status).toBe(404);
  });
});

describe('product request — its files (owner 2026-10-15: 需要可以 attach 文件功能)', () => {
  const PDF = { fileName: 'quotation.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF-1.4 quotation') };
  test('the requester attaches and removes on their own request; another Sales caller sees nothing; the Purchaser reads, attaches and removes', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const up = await amy(`/product-requests/${id}/files`, 'POST', PDF);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect((up.body.file as Row).sort_no).toBe(1);
    const row = sb.tables.product_request_files[0]!;
    expect(row).toMatchObject({ company_id: CO, request_id: id, file_name: 'quotation.pdf', mime: 'application/pdf' });
    expect(String(row.file_key)).toMatch(new RegExp(`^product-request-files/${CO}/${id}/`));
    expect(R2.store.has(String(row.file_key))).toBe(true);
    /* Not an image or a PDF: refused. */
    expect((await amy(`/product-requests/${id}/files`, 'POST', { ...PDF, mime: 'text/plain' })).body.error).toBe('bad_mime');
    /* The two spellings some tools write read as the real one (owner 2026-10-15: attach 不到 pdf). */
    expect((await amy(`/product-requests/${id}/files`, 'POST', { ...PDF, fileName: 'scan.pdf', mime: 'application/x-pdf' })).status).toBe(201);
    expect(sb.tables.product_request_files.at(-1)!.mime).toBe('application/pdf');
    /* Another Sales caller: the request is not theirs to see, so neither are its files. */
    const ben = as(sb, BEN);
    expect((await ben(`/product-requests/${id}/files`)).status).toBe(404);
    expect((await ben(`/product-requests/${id}/files`, 'POST', PDF)).status).toBe(404);
    /* The Purchaser reads the list and adds a photo. */
    const purchaser = as(sb, PURCHASER);
    expect(((await purchaser(`/product-requests/${id}/files`)).body.files as Row[]).map((f) => f.file_name)).toEqual(['quotation.pdf', 'scan.pdf']);
    expect((await purchaser(`/product-requests/${id}/files`, 'POST', { fileName: 'photo.jpg', mime: 'image/jpeg', dataBase64: btoa('jpg') })).status).toBe(201);
    /* A storekeeper holds neither key nor Sales position: refused outright. */
    expect((await as(sb, NOBODY)(`/product-requests/${id}/files`, 'POST', PDF)).status).toBe(403);
    /* The requester removes their own file while the request waits. */
    const fileId = String(row.id);
    expect((await amy(`/product-requests/${id}/files/${fileId}`, 'DELETE')).status).toBe(200);
    expect(sb.tables.product_request_files).toHaveLength(2);
    expect(R2.store.has(String(row.file_key))).toBe(false);
  });

  test("once the Purchaser has decided, the requester's files stay; the Purchaser may still remove one; a closed request takes no more", async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const purchaser = as(sb, PURCHASER);
    const id = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const fileId = String(((await amy(`/product-requests/${id}/files`, 'POST', PDF)).body.file as Row).id);
    await purchaser(`/product-requests/${id}/approve`, 'POST', {});
    expect((await amy(`/product-requests/${id}/files/${fileId}`, 'DELETE')).body.error).toBe('request_decided');
    /* Approved: more evidence may still arrive (a photo of the sample). */
    expect((await amy(`/product-requests/${id}/files`, 'POST', { fileName: 'sample.jpg', mime: 'image/jpeg', dataBase64: btoa('jpg') })).status).toBe(201);
    expect((await purchaser(`/product-requests/${id}/files/${fileId}`, 'DELETE')).status).toBe(200);
    await purchaser(`/product-requests/${id}/close`, 'POST', {});
    expect((await purchaser(`/product-requests/${id}/files`, 'POST', PDF)).body.error).toBe('request_closed');
    /* The list still reads for the Purchaser after closing. */
    expect(((await purchaser(`/product-requests/${id}/files`)).body.files as Row[]).map((f) => f.file_name)).toEqual(['sample.jpg']);
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

/* HC-0136 (Sim): 「have notification alert when have new request order. same
   like SO amendment」 — the Purchaser's bell on raise and resubmit, and the red
   count on their sidebar entry. */
describe('product request — the Purchaser is alerted', () => {
  beforeEach(() => notified.mockClear());

  test('raising one notifies, an edit while waiting does not, a rejected one sent again does', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const raised = (await amy('/product-requests', 'POST', { ...NEW_SOFA, lines: [LINE_AURORA, LINE_5530] })).body.request as Row;
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]).toEqual(['raised', {
      requestNo: raised.request_no, companyId: CO, requesterUserId: AMY.id, requesterName: 'Amy Tan',
      products: 'Aurora (new) ×2; 5530-3S ×1', lineCount: 2,
    }]);
    const id = String(raised.id);
    notified.mockClear();
    expect((await amy(`/product-requests/${id}`, 'PATCH', { specialRemarks: 'Corner by the door' })).status).toBe(200);
    expect(notified).not.toHaveBeenCalled();
    await as(sb, PURCHASER)(`/product-requests/${id}/reject`, 'POST', { note: 'Pick one fabric' });
    expect(notified).not.toHaveBeenCalled();
    expect((await amy(`/product-requests/${id}`, 'PATCH', { lines: [LINE_5530] })).status).toBe(200);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]![0]).toBe('resubmitted');
    expect(notified.mock.calls[0]![1]).toMatchObject({ requestNo: raised.request_no, products: '5530-3S ×1', lineCount: 1 });
  });

  test('a refused request notifies nobody', async () => {
    const sb = world();
    expect((await as(sb, AMY)('/product-requests', 'POST', { ...NEW_SOFA, lines: [] })).status).toBe(400);
    expect(notified).not.toHaveBeenCalled();
  });

  test('pending-count: the Purchaser counts the REQUESTED ones of this company; the requester and the wildcard roles get 0', async () => {
    const sb = world();
    const amy = as(sb, AMY);
    const a = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    await amy('/product-requests', 'POST', NEW_SOFA);
    const c = String(((await amy('/product-requests', 'POST', NEW_SOFA)).body.request as Row).id);
    const purchaser = as(sb, PURCHASER);
    await purchaser(`/product-requests/${a}/approve`, 'POST', {});
    await amy(`/product-requests/${c}/withdraw`, 'POST', {});
    sb.tables.product_requests.push({ id: 'other-co', company_id: 2, request_no: '2990-PDR-2610-001', status: 'REQUESTED', requested_by: 77 });
    expect((await purchaser('/product-requests/pending-count')).body).toEqual({ count: 1 });
    expect((await amy('/product-requests/pending-count')).body).toEqual({ count: 0 });
    const owner: Who = { id: 1, name: 'Owner', perms: ['*'] };
    expect((await as(sb, owner)('/product-requests/pending-count')).body).toEqual({ count: 0 });
  });
});
