// /product-requests — a request for a new product or a repack (owner 2026-10-06:
// to request new product / repack product — Application, Model, Compartment,
// Fabric, Sofa size, Leg size, Special remarks, Delivery location, Expected
// delivery date; 要审批, Purchaser 批; Sales 都能提; 然后这个会连接 purchase
// consignment order).
//
//   GET    /                  requests: a requester's own; the Purchaser's all
//   GET    /:id               one request, its PC Order and where it stands
//   POST   /                  raise a request (REQUESTED)
//   PATCH  /:id               the requester changes it — or sends a rejected one again
//   POST   /:id/withdraw      the requester takes it back
//   POST   /:id/approve       the Purchaser says yes
//   POST   /:id/reject        the Purchaser says no, saying why
//   POST   /:id/create-model  the Purchaser builds the new Model + SKU from it
//   POST   /:id/close         the Purchaser ends it
//
// The product is an existing SKU (item_code, picked from the catalogue) or a
// Model the catalogue does not have yet (proposed_model_name). A repack always
// names an existing SKU (it re-packs something). An approved new-Model request
// cannot raise a PC Order until the Purchaser has built the Model and SKU from
// it (POST /:id/create-model — the SKU lands ACTIVE but not on POS until
// someone turns it on): a consignment receive books stock by item code, and a
// code the catalogue has not got would be stock nothing can sell.
//
// The PC Order is raised on PC Order New (?fromProductRequest=); its create
// door reads the request through lib/product-request-link.ts and, once the
// order stands, the request reads PCO_ISSUED with pco_id.
//
// NO area guard (scm/index.ts): a salesperson has no consignment or procurement
// area, and the Purchaser has no sales area. requireScmAccess admits a Sales
// caller and the two flat keys for this prefix; each handler checks the caller
// against the real Houzs user — a requester sees their own requests only.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm, isSalesCaller } from '../lib/houzs-perms';
import { docMonthTag, mintMonthlyDocNo } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { ensureModelForSku } from '../lib/ensure-model-for-sku';
import { callerUserId } from '../lib/payment-request';
import { MFG_PRODUCT_CATEGORIES } from '../shared/product-categories';
import {
  PRODUCT_REQUEST_APPLICATIONS, PRODUCT_REQUEST_TYPES, canTransition, defaultSkuCode, productRefusal, requesterMayChange,
  type ProductRequestStatus,
} from '../shared/product-request';

type Row = Record<string, any>;

export const PRODUCT_REQUEST_CREATE_KEY = 'scm.product_request.create';
export const PRODUCT_REQUEST_APPROVE_KEY = 'scm.product_request.approve';

export const productRequests = new Hono<{ Bindings: Env; Variables: Variables }>();
productRequests.use('*', supabaseAuth);

const COLS = 'id, company_id, request_no, request_type, application, requested_by, requested_by_name, item_code, proposed_model_name, model_id, category, compartment, fabric_code, seat_size, leg_size, qty, special_remarks, delivery_location_id, expected_delivery_date, status, decision_note, decided_by, decided_at, pco_id, created_at, updated_at';
const NO_PERM = { error: "You don't have permission to do that." };
/** Special remarks are a few lines to the Purchaser, not a document. */
export const REMARKS_MAX = 2000;

/** The Purchaser, for a request: whoever holds the approve key. */
const isApprover = (c: any): boolean => hasHouzsPerm(c, PRODUCT_REQUEST_APPROVE_KEY);
/** Sales 都能提: any Sales caller, or a holder of the create key. */
const mayRequest = (c: any): boolean => hasHouzsPerm(c, PRODUCT_REQUEST_CREATE_KEY) || isSalesCaller(c);
const mayOpen = (c: any): boolean => mayRequest(c) || isApprover(c);

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};
const actorName = (c: any): string => String(c.get('houzsUser')?.name ?? c.get('houzsUser')?.email ?? '');

/** The request under the active company that the caller may see — the
    requester's own, or any for the Purchaser — else a 404 that names nothing. */
async function loadVisible(c: any, id: string): Promise<{ req: Row } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(sb.from('product_requests').select(COLS).eq('id', id), c).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  const me = callerUserId(c);
  if (!data || (!isApprover(c) && Number(data.requested_by) !== me)) {
    return { resp: c.json({ error: 'not_found', message: 'That product request is not one you can open.' }, 404) };
  }
  return { req: data as Row };
}

/** Each request with what it links to: the PC Order raised from it, the
    delivery location's name, and the Model's code. */
async function withLinks(c: any, companyId: number, rows: Row[]): Promise<{ rows: Row[] } | { resp: Response }> {
  const sb = c.get('supabase');
  const pcoIds = [...new Set(rows.map((r) => r.pco_id).filter(Boolean))] as string[];
  const pcos = new Map<string, Row>();
  if (pcoIds.length > 0) {
    const { data, error } = await sb.from('purchase_consignment_orders').select('id, pc_number, status, expected_at')
      .eq('company_id', companyId).in('id', pcoIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const p of (data ?? []) as Row[]) pcos.set(String(p.id), p);
  }
  const whIds = [...new Set(rows.map((r) => r.delivery_location_id).filter(Boolean))] as string[];
  const warehouses = new Map<string, Row>();
  if (whIds.length > 0) {
    const { data, error } = await sb.from('warehouses').select('id, code, name').eq('company_id', companyId).in('id', whIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const w of (data ?? []) as Row[]) warehouses.set(String(w.id), w);
  }
  const modelIds = [...new Set(rows.map((r) => r.model_id).filter(Boolean))] as string[];
  const models = new Map<string, Row>();
  if (modelIds.length > 0) {
    const { data, error } = await sb.from('product_models').select('id, model_code, name').eq('company_id', companyId).in('id', modelIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const m of (data ?? []) as Row[]) models.set(String(m.id), m);
  }
  return {
    rows: rows.map((r) => {
      const pco = r.pco_id ? pcos.get(String(r.pco_id)) ?? null : null;
      const wh = r.delivery_location_id ? warehouses.get(String(r.delivery_location_id)) ?? null : null;
      const model = r.model_id ? models.get(String(r.model_id)) ?? null : null;
      return {
        ...r,
        pco: pco ? { id: pco.id, pcNumber: pco.pc_number, status: pco.status, expectedAt: pco.expected_at ?? null } : null,
        deliveryLocation: wh ? { id: wh.id, code: wh.code, name: wh.name } : null,
        model: model ? { id: model.id, modelCode: model.model_code, name: model.name } : null,
      };
    }),
  };
}

/* ── GET / ─────────────────────────────────────────────────────────────────── */
export const listProductRequestsHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const approver = isApprover(c);
  const me = callerUserId(c);
  if (!approver && me == null) return c.json(NO_PERM, 403);
  const sb = c.get('supabase');
  let q = scopeToCompany(sb.from('product_requests').select(COLS), c);
  if (!approver || c.req.query('mine') === '1') q = q.eq('requested_by', me);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const linked = await withLinks(c, co.companyId, (data ?? []) as Row[]);
  if ('resp' in linked) return linked.resp;
  return c.json({ requests: linked.rows, approver, mayRequest: mayRequest(c) });
};
productRequests.get('/', listProductRequestsHandler);

/* ── GET /:id ──────────────────────────────────────────────────────────────── */
export const getProductRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const linked = await withLinks(c, co.companyId, [found.req]);
  if ('resp' in linked) return linked.resp;
  return c.json({ request: linked.rows[0], approver: isApprover(c), mayRequest: mayRequest(c) });
};
productRequests.get('/:id', getProductRequestHandler);

/* ── The requester's fields, as the body sends them ───────────────────────── */
type Fields = {
  request_type: string; application: string;
  item_code: string | null; proposed_model_name: string | null; model_id: string | null; category: string;
  compartment: string | null; fabric_code: string | null; seat_size: string | null; leg_size: string | null;
  qty: number; special_remarks: string | null; delivery_location_id: string | null; expected_delivery_date: string | null;
};

function readFields(body: Row): { fields: Fields } | { error: string; message: string } {
  const requestType = String(body.requestType ?? '').trim().toUpperCase();
  if (!(PRODUCT_REQUEST_TYPES as readonly string[]).includes(requestType)) {
    return { error: 'request_type_invalid', message: 'Is this a new product or a repack?' };
  }
  const application = String(body.application ?? '').trim().toUpperCase();
  if (!(PRODUCT_REQUEST_APPLICATIONS as readonly string[]).includes(application)) {
    return { error: 'application_invalid', message: 'Say what it is for — showroom, a customer order, or a sample.' };
  }
  const itemCode = text(body.itemCode);
  const proposed = text(body.proposedModelName);
  const product = productRefusal({ request_type: requestType, item_code: itemCode, proposed_model_name: proposed });
  if (product) return product;
  const category = String(body.category ?? 'SOFA').trim().toUpperCase();
  if (!(MFG_PRODUCT_CATEGORIES as readonly string[]).includes(category)) {
    return { error: 'invalid_category', message: `Category must be one of ${MFG_PRODUCT_CATEGORIES.join(', ')}.` };
  }
  const qty = body.qty === undefined || body.qty === null || body.qty === '' ? 1 : Number(body.qty);
  if (!Number.isInteger(qty) || qty <= 0) return { error: 'qty_invalid', message: 'The quantity must be a whole number above zero.' };
  const remarks = text(body.specialRemarks);
  if (remarks && remarks.length > REMARKS_MAX) return { error: 'remarks_too_long', message: `Keep the special remarks to ${REMARKS_MAX.toLocaleString('en-MY')} characters.` };
  const expected = body.expectedDeliveryDate == null || body.expectedDeliveryDate === '' ? null : dateOrNull(body.expectedDeliveryDate);
  if (body.expectedDeliveryDate && !expected) return { error: 'date_invalid', message: 'The expected delivery date is not a date.' };
  return {
    fields: {
      request_type: requestType, application,
      /* An existing SKU names the product; the proposed name is then moot. */
      item_code: itemCode, proposed_model_name: itemCode ? null : proposed, model_id: null, category,
      compartment: text(body.compartment), fabric_code: text(body.fabricCode), seat_size: text(body.seatSize), leg_size: text(body.legSize),
      qty, special_remarks: remarks, delivery_location_id: text(body.deliveryLocationId), expected_delivery_date: expected,
    },
  };
}

/** What the fields name must exist in this company: the SKU (which also fixes
    the category and the Model), the fabric, the delivery location. */
async function resolveFields(c: any, companyId: number, f: Fields): Promise<{ error: string; message: string } | null> {
  const sb = c.get('supabase');
  if (f.item_code) {
    const { data, error } = await sb.from('mfg_products').select('id, code, category, model_id').eq('company_id', companyId).eq('code', f.item_code).maybeSingle();
    if (error) return { error: 'load_failed', message: error.message };
    if (!data) return { error: 'unknown_item', message: `${f.item_code} is not in the catalogue — pick a SKU from the list, or name the new Model instead.` };
    f.item_code = String(data.code);
    f.category = String(data.category ?? f.category).toUpperCase();
    f.model_id = data.model_id ? String(data.model_id) : null;
  }
  if (f.fabric_code) {
    const { data, error } = await sb.from('fabric_trackings').select('fabric_code').eq('company_id', companyId).eq('fabric_code', f.fabric_code).maybeSingle();
    if (error) return { error: 'load_failed', message: error.message };
    if (!data) return { error: 'unknown_fabric', message: `${f.fabric_code} is not a fabric in the Fabric Converter — pick one from the list.` };
  }
  if (f.delivery_location_id) {
    const { data, error } = await sb.from('warehouses').select('id').eq('company_id', companyId).eq('id', f.delivery_location_id).maybeSingle();
    if (error) return { error: 'load_failed', message: error.message };
    if (!data) return { error: 'unknown_location', message: 'The delivery location is not a warehouse of this company.' };
  }
  return null;
}

/* ── POST / ────────────────────────────────────────────────────────────────── */
export const createProductRequestHandler = async (c: any): Promise<Response> => {
  if (!mayRequest(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const me = callerUserId(c);
  if (me == null) return c.json({ error: 'no_user', message: 'Sign in again — the request needs to know who is asking.' }, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const read = readFields(body);
  if ('error' in read) return c.json(read, 400);
  const resolved = await resolveFields(c, co.companyId, read.fields);
  if (resolved) return c.json(resolved, resolved.error === 'load_failed' ? 500 : 400);

  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', action: 'CREATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const requestNo = await mintMonthlyDocNo(sb, 'product_requests', 'request_no', `${companyDocPrefix(c)}PDR-${docMonthTag(todayMyt())}`);
  const { data: row, error } = await sb.from('product_requests').insert({
    company_id: co.companyId,
    request_no: requestNo,
    requested_by: me,
    requested_by_name: actorName(c) || null,
    ...read.fields,
    status: 'REQUESTED',
  }).select(COLS).single();
  if (error || !row) return c.json({ error: 'save_failed', reason: error?.message ?? 'insert returned nothing' }, 500);
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(row.id), entityDocNo: requestNo, action: 'CREATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'REQUESTED',
    fieldChanges: compactChanges([
      fieldChange('requestType', null, read.fields.request_type), fieldChange('itemCode', null, read.fields.item_code),
      fieldChange('proposedModelName', null, read.fields.proposed_model_name), fieldChange('qty', null, read.fields.qty),
    ]),
  });
  const linked = await withLinks(c, co.companyId, [row as Row]);
  if ('resp' in linked) return linked.resp;
  return c.json({ ok: true, request: linked.rows[0] }, 201);
};
productRequests.post('/', createProductRequestHandler);

/* ── PATCH /:id — the requester's change; a rejected request goes back in ─── */
export const updateProductRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const before = found.req;
  if (Number(before.requested_by) !== callerUserId(c)) {
    return c.json({ error: 'not_yours', message: 'Only the person who asked can change a request — the Purchaser rejects it instead.' }, 403);
  }
  if (!requesterMayChange(String(before.status) as ProductRequestStatus)) {
    return c.json({ error: 'request_locked', message: `${before.request_no} is ${String(before.status).toLowerCase().replace('_', ' ')} — it can no longer change.` }, 409);
  }
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const keep = (k: string, stored: unknown) => (body[k] !== undefined ? body[k] : stored);
  const read = readFields({
    requestType: keep('requestType', before.request_type), application: keep('application', before.application),
    itemCode: keep('itemCode', before.item_code), proposedModelName: keep('proposedModelName', before.proposed_model_name),
    category: keep('category', before.category), compartment: keep('compartment', before.compartment),
    fabricCode: keep('fabricCode', before.fabric_code), seatSize: keep('seatSize', before.seat_size), legSize: keep('legSize', before.leg_size),
    qty: keep('qty', before.qty), specialRemarks: keep('specialRemarks', before.special_remarks),
    deliveryLocationId: keep('deliveryLocationId', before.delivery_location_id), expectedDeliveryDate: keep('expectedDeliveryDate', before.expected_delivery_date),
  });
  if ('error' in read) return c.json(read, 400);
  const resolved = await resolveFields(c, co.companyId, read.fields);
  if (resolved) return c.json(resolved, resolved.error === 'load_failed' ? 500 : 400);
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(before.id), action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const resubmit = before.status === 'REJECTED';
  const { data: row, error } = await sb.from('product_requests')
    .update({ ...read.fields, ...(resubmit ? { status: 'REQUESTED', decision_note: null, decided_by: null, decided_at: null } : {}), updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', before.id).eq('status', String(before.status)).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'request_moved', message: `${before.request_no} changed a moment ago — open it again.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(before.id), entityDocNo: before.request_no, action: resubmit ? 'SUBMIT_FOR_APPROVAL' : 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: String(row.status),
    fieldChanges: compactChanges((Object.keys(read.fields) as Array<keyof Fields>).map((k) => fieldChange(k, before[k] ?? null, read.fields[k] ?? null))),
  });
  const linked = await withLinks(c, co.companyId, [row as Row]);
  if ('resp' in linked) return linked.resp;
  return c.json({ ok: true, request: linked.rows[0] });
};
productRequests.patch('/:id', updateProductRequestHandler);

/* ── One status move, guarded on the status the row was read in ─────────────
   so two decisions at once cannot both land. */
async function moveStatus(c: any, companyId: number, r: Row, to: ProductRequestStatus, extra: Row): Promise<{ ok: true } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('product_requests')
    .update({ status: to, ...extra, updated_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('id', r.id).eq('status', String(r.status)).select('id').maybeSingle();
  if (error) return { resp: c.json({ error: 'save_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'request_moved', message: `${r.request_no} changed a moment ago — open it again.` }, 409) };
  return { ok: true };
}

/* ── POST /:id/withdraw ────────────────────────────────────────────────────── */
export const withdrawProductRequestHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (Number(r.requested_by) !== callerUserId(c)) return c.json({ error: 'not_yours', message: 'Only the person who asked can withdraw a request.' }, 403);
  if (r.status === 'WITHDRAWN') return c.json({ ok: true, already: true });
  if (!canTransition(String(r.status) as ProductRequestStatus, 'withdraw')) {
    return c.json({ error: 'request_decided', message: `${r.request_no} is ${String(r.status).toLowerCase().replace('_', ' ')} — ask the Purchaser to close it instead.` }, 409);
  }
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(r.id), action: 'CANCEL', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const moved = await moveStatus(c, co.companyId, r, 'WITHDRAWN', {});
  if ('resp' in moved) return moved.resp;
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'CANCEL',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'WITHDRAWN',
  });
  return c.json({ ok: true });
};
productRequests.post('/:id/withdraw', withdrawProductRequestHandler);

/* ── POST /:id/approve — the Purchaser's yes ───────────────────────────────── */
export const approveProductRequestHandler = async (c: any): Promise<Response> => {
  if (!isApprover(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (!canTransition(String(r.status) as ProductRequestStatus, 'approve')) {
    return c.json({ error: 'bad_transition', message: `${r.request_no} is ${String(r.status).toLowerCase().replace('_', ' ')} — only a waiting request is approved.` }, 409);
  }
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(r.id), action: 'APPROVE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const note = text(body.note);
  const moved = await moveStatus(c, co.companyId, r, 'APPROVED', { decision_note: note, decided_by: actorName(c) || null, decided_at: new Date().toISOString() });
  if ('resp' in moved) return moved.resp;
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'APPROVE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'APPROVED',
    fieldChanges: compactChanges([fieldChange('decisionNote', r.decision_note ?? null, note)]),
  });
  return c.json({ ok: true, needsModel: !r.item_code });
};
productRequests.post('/:id/approve', approveProductRequestHandler);

/* ── POST /:id/reject — the Purchaser's no, with the why ───────────────────── */
export const rejectProductRequestHandler = async (c: any): Promise<Response> => {
  if (!isApprover(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const note = text(body.note);
  if (!note) return c.json({ error: 'note_required', message: 'Say why it is rejected — the requester reads it.' }, 400);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (!canTransition(String(r.status) as ProductRequestStatus, 'reject')) {
    return c.json({ error: 'bad_transition', message: `${r.request_no} is ${String(r.status).toLowerCase().replace('_', ' ')} — only a waiting request is rejected.` }, 409);
  }
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(r.id), action: 'REJECT', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const moved = await moveStatus(c, co.companyId, r, 'REJECTED', { decision_note: note, decided_by: actorName(c) || null, decided_at: new Date().toISOString() });
  if ('resp' in moved) return moved.resp;
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'REJECT',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'REJECTED',
    fieldChanges: compactChanges([fieldChange('decisionNote', r.decision_note ?? null, note)]),
  });
  return c.json({ ok: true });
};
productRequests.post('/:id/reject', rejectProductRequestHandler);

/* ── POST /:id/create-model — the new Model + its first SKU, from the request ─
   Body: { modelCode, skuCode?, name? }. The Model is found-or-created on
   (company, model_code, category) through the ONE helper every SKU-create
   path shares (lib/ensure-model-for-sku.ts); the SKU lands ACTIVE and
   pos_active=false — the catalogue has it, POS does not offer it until someone
   turns it on. The request then names the SKU (item_code / model_id), which is
   what lets a PC Order be raised from it. */
export const createModelFromRequestHandler = async (c: any): Promise<Response> => {
  if (!isApprover(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (r.status !== 'APPROVED') {
    return c.json({ error: 'request_not_approved', message: `${r.request_no} is ${String(r.status).toLowerCase().replace('_', ' ')} — approve it first, then build the Model.` }, 409);
  }
  if (r.item_code) return c.json({ error: 'model_exists', message: `${r.request_no} already names ${r.item_code} — there is no Model to build.` }, 409);
  const modelCode = (text(body.modelCode) ?? '').toUpperCase().replace(/\s+/g, '-');
  if (!modelCode) return c.json({ error: 'model_code_required', message: 'Give the new Model a code (e.g. 5530).' }, 400);
  if (modelCode.length > 32) return c.json({ error: 'model_code_too_long', message: 'A Model code is at most 32 characters.' }, 400);
  const category = String(r.category ?? 'SOFA').toUpperCase();
  const skuCode = (text(body.skuCode) ?? defaultSkuCode(modelCode, category, r.compartment ?? null)).toUpperCase().replace(/\s+/g, '-');
  if (skuCode.length > 30) return c.json({ error: 'sku_code_too_long', message: 'A SKU code is at most 30 characters (AutoCount item code).' }, 400);
  const name = text(body.name) ?? String(r.proposed_model_name ?? modelCode);

  const sb = c.get('supabase');
  const { data: taken, error: tErr } = await sb.from('mfg_products').select('id').eq('company_id', co.companyId).eq('code', skuCode).maybeSingle();
  if (tErr) return c.json({ error: 'load_failed', reason: tErr.message }, 500);
  if (taken) return c.json({ error: 'duplicate_code', message: `${skuCode} is already a SKU — pick it on the request instead, or give the new one another code.` }, 409);
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(r.id), action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  /* A sofa / bedframe / mattress SKU is a variant of its Model (base_model); a
     flat product is its own 1:1 Model — mfg-products.ts POST / draws the line the
     same way through ensureModelForSku. */
  const variantCategory = category === 'SOFA' || category === 'BEDFRAME' || category === 'MATTRESS';
  const ensured = await ensureModelForSku(sb, { companyId: co.companyId, code: skuCode, name, category, baseModel: variantCategory ? modelCode : null });
  if (!ensured.ok) return c.json({ error: 'model_ensure_failed', reason: ensured.reason }, 500);

  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const skuId = `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;
  const { error: sErr } = await sb.from('mfg_products').insert({
    id: skuId, company_id: co.companyId, code: skuCode, name, category, status: 'ACTIVE', pos_active: false,
    base_model: variantCategory ? modelCode : null, model_id: ensured.modelId,
    description: r.special_remarks ?? null, cost_price_sen: 0, unit_m3_milli: 0,
  });
  if (sErr) {
    if (String(sErr.code) === '23505') return c.json({ error: 'duplicate_code', message: `${skuCode} was taken a moment ago — give the new SKU another code.` }, 409);
    return c.json({ error: 'sku_insert_failed', reason: sErr.message }, 500);
  }
  const { data: row, error } = await sb.from('product_requests')
    .update({ item_code: skuCode, model_id: ensured.modelId, updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', r.id).eq('status', 'APPROVED').select(COLS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'request_moved', message: `${r.request_no} changed a moment ago — the SKU ${skuCode} was created; open the request again.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'APPROVED',
    fieldChanges: compactChanges([fieldChange('modelCode', null, modelCode), fieldChange('itemCode', null, skuCode), fieldChange('modelCreated', null, ensured.created)]),
  });
  const linked = await withLinks(c, co.companyId, [row as Row]);
  if ('resp' in linked) return linked.resp;
  return c.json({ ok: true, model: { id: ensured.modelId, modelCode, created: ensured.created }, sku: { id: skuId, code: skuCode }, request: linked.rows[0] }, 201);
};
productRequests.post('/:id/create-model', createModelFromRequestHandler);

/* ── POST /:id/close — the Purchaser ends it ───────────────────────────────── */
export const closeProductRequestHandler = async (c: any): Promise<Response> => {
  if (!isApprover(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (r.status === 'CLOSED') return c.json({ ok: true, already: true });
  if (!canTransition(String(r.status) as ProductRequestStatus, 'close')) {
    return c.json({ error: 'bad_transition', message: `${r.request_no} is ${String(r.status).toLowerCase().replace('_', ' ')} — only an approved or issued request is closed.` }, 409);
  }
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(r.id), action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const note = text(body.note);
  const moved = await moveStatus(c, co.companyId, r, 'CLOSED', note ? { decision_note: note } : {});
  if ('resp' in moved) return moved.resp;
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'CLOSED',
    fieldChanges: compactChanges([fieldChange('closeNote', null, note)]),
  });
  return c.json({ ok: true });
};
productRequests.post('/:id/close', closeProductRequestHandler);
