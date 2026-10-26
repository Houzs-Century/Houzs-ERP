// /product-requests — a request for new products or repacks (owner 2026-10-06:
// to request new product / repack product — Application, Model, Compartment,
// Fabric, Sofa size, Leg size, Special remarks, Delivery location, Expected
// delivery date; 要审批, Purchaser 批; Sales 都能提; 然后这个会连接 purchase
// consignment order. 2026-10-15, 方案 A: a request is a HEADER plus LINES, the
// shape a Purchase Consignment Order has, so dozens of showroom pieces go in
// one request and come out as one PC Order).
//
//   GET    /                                 requests: a requester's own; the Purchaser's all
//   GET    /pending-count                    the Purchaser's REQUESTED count (sidebar badge)
//   GET    /:id                              one request, its lines, its PC Order and where it stands
//   POST   /                                 raise a request (REQUESTED) — header + lines
//   PATCH  /:id                              the requester changes it (lines replaced as a set) — or sends a rejected one again
//   POST   /:id/withdraw                     the requester takes it back
//   POST   /:id/approve                      the Purchaser says yes — to the whole request
//   POST   /:id/reject                       the Purchaser says no, saying why
//   POST   /:id/lines/:lineId/create-model   the Purchaser builds a line's new Model + SKU
//   POST   /:id/close                        the Purchaser ends it
//   POST   /:id/link-po                      a Purchase Order raised from it claims it (PO_ISSUED)
//   POST   /:id/files, GET /:id/files, GET + DELETE /:id/files/:fileId
//                                            the request's evidence (quotation, photos) — lib/doc-files.ts
//
// Each line's product is an existing SKU (item_code, picked from the catalogue)
// or a Model the catalogue does not have yet (proposed_model_name). A repack
// always names an existing SKU (it re-packs something). An approved request
// cannot raise a PC Order until EVERY line names a SKU — the Purchaser builds
// the Model and SKU per new-Model line (POST /:id/lines/:lineId/create-model;
// the SKU lands ACTIVE but not on POS until someone turns it on): a
// consignment receive books stock by item code, and a code the catalogue has
// not got would be stock nothing can sell.
//
// The PC Order is raised on PC Order New (?fromProductRequest=), one order line
// per request line; its create door reads the request through
// lib/product-request-link.ts and, once the order stands, the request reads
// PCO_ISSUED with pco_id. Goods bought outright go on a Purchase Order instead
// (2990-0015): PO New (?fromProductRequest=) seeds the same way and, once the
// PO stands, claims the request through POST /:id/link-po — PO_ISSUED with
// po_id. A request carries one order, of either kind.
//
// NO area guard (scm/index.ts): a salesperson has no consignment or procurement
// area, and the Purchaser has no sales area. requireScmAccess admits a Sales
// caller and the two flat keys for this prefix; each handler checks the caller
// against the real Houzs user — a requester sees their own requests only.
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm, holdsHouzsPermLiterally, isSalesCaller } from '../lib/houzs-perms';
import { docMonthTag, mintMonthlyDocNo } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { ensureModelForSku } from '../lib/ensure-model-for-sku';
import { makeDocFileHandlers, type DocFilesSpec } from '../lib/doc-files';
import { callerUserId } from '../lib/payment-request';
import { notifyProductRequest } from '../../services/productRequestNotify';
import { MFG_PRODUCT_CATEGORIES } from '../shared/product-categories';
import {
  PRODUCT_REQUEST_APPLICATIONS, PRODUCT_REQUEST_TYPES, canTransition, defaultSkuCode, linesRefusal, orderFromRequestRefusal, productRefusal, requesterMayChange,
  type ProductRequestStatus,
} from '../shared/product-request';

type Row = Record<string, any>;

export const PRODUCT_REQUEST_CREATE_KEY = 'scm.product_request.create';
export const PRODUCT_REQUEST_APPROVE_KEY = 'scm.product_request.approve';

export const productRequests = new Hono<{ Bindings: Env; Variables: Variables }>();
productRequests.use('*', supabaseAuth);

const COLS = 'id, company_id, request_no, request_type, application, requested_by, requested_by_name, special_remarks, delivery_location_id, expected_delivery_date, supplier_id, status, decision_note, decided_by, decided_at, pco_id, po_id, created_at, updated_at';
const LINE_COLS = 'id, company_id, request_id, line_no, item_code, proposed_model_name, model_id, category, compartment, fabric_code, seat_size, leg_size, qty, unit_price_sen, remarks, created_at, updated_at';
const NO_PERM = { error: "You don't have permission to do that." };
/** Special remarks are a few lines to the Purchaser, not a document. */
export const REMARKS_MAX = 2000;
/** A line remark is one line. */
export const LINE_REMARKS_MAX = 500;

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
const statusWords = (s: unknown): string => String(s).toLowerCase().replace('_', ' ');

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

/** The lines of these requests, company-scoped, in line order, grouped by request. */
async function loadLines(c: any, companyId: number, requestIds: string[]): Promise<{ byRequest: Map<string, Row[]> } | { resp: Response }> {
  const byRequest = new Map<string, Row[]>();
  if (requestIds.length === 0) return { byRequest };
  const sb = c.get('supabase');
  const { data, error } = await sb.from('product_request_lines').select(LINE_COLS)
    .eq('company_id', companyId).in('request_id', requestIds).order('line_no');
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  for (const l of (data ?? []) as Row[]) {
    const key = String(l.request_id);
    if (!byRequest.has(key)) byRequest.set(key, []);
    byRequest.get(key)!.push(l);
  }
  return { byRequest };
}

/** Each request with its lines and what it links to: the PC Order or the
    Purchase Order raised from it, the delivery location's name, the supplier,
    and each line's Model. */
async function withLinks(c: any, companyId: number, rows: Row[]): Promise<{ rows: Row[] } | { resp: Response }> {
  const sb = c.get('supabase');
  const lines = await loadLines(c, companyId, rows.map((r) => String(r.id)));
  if ('resp' in lines) return lines;
  const pcoIds = [...new Set(rows.map((r) => r.pco_id).filter(Boolean))] as string[];
  const pcos = new Map<string, Row>();
  if (pcoIds.length > 0) {
    const { data, error } = await sb.from('purchase_consignment_orders').select('id, pc_number, status, expected_at')
      .eq('company_id', companyId).in('id', pcoIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const p of (data ?? []) as Row[]) pcos.set(String(p.id), p);
  }
  const poIds = [...new Set(rows.map((r) => r.po_id).filter(Boolean))] as string[];
  const pos = new Map<string, Row>();
  if (poIds.length > 0) {
    const { data, error } = await sb.from('purchase_orders').select('id, po_number, status, expected_at')
      .eq('company_id', companyId).in('id', poIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const p of (data ?? []) as Row[]) pos.set(String(p.id), p);
  }
  const whIds = [...new Set(rows.map((r) => r.delivery_location_id).filter(Boolean))] as string[];
  const warehouses = new Map<string, Row>();
  if (whIds.length > 0) {
    const { data, error } = await sb.from('warehouses').select('id, code, name').eq('company_id', companyId).in('id', whIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const w of (data ?? []) as Row[]) warehouses.set(String(w.id), w);
  }
  const allLines = [...lines.byRequest.values()].flat();
  const modelIds = [...new Set(allLines.map((l) => l.model_id).filter(Boolean))] as string[];
  const models = new Map<string, Row>();
  if (modelIds.length > 0) {
    const { data, error } = await sb.from('product_models').select('id, model_code, name').eq('company_id', companyId).in('id', modelIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const m of (data ?? []) as Row[]) models.set(String(m.id), m);
  }
  const supplierIds = [...new Set(rows.map((r) => r.supplier_id).filter(Boolean))] as string[];
  const suppliers = new Map<string, Row>();
  if (supplierIds.length > 0) {
    const { data, error } = await sb.from('suppliers').select('id, code, name').eq('company_id', companyId).in('id', supplierIds);
    if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
    for (const s of (data ?? []) as Row[]) suppliers.set(String(s.id), s);
  }
  return {
    rows: rows.map((r) => {
      const pco = r.pco_id ? pcos.get(String(r.pco_id)) ?? null : null;
      const po = r.po_id ? pos.get(String(r.po_id)) ?? null : null;
      const wh = r.delivery_location_id ? warehouses.get(String(r.delivery_location_id)) ?? null : null;
      const supplier = r.supplier_id ? suppliers.get(String(r.supplier_id)) ?? null : null;
      return {
        ...r,
        lines: (lines.byRequest.get(String(r.id)) ?? []).map((l) => {
          const model = l.model_id ? models.get(String(l.model_id)) ?? null : null;
          return { ...l, model: model ? { id: model.id, modelCode: model.model_code, name: model.name } : null };
        }),
        pco: pco ? { id: pco.id, pcNumber: pco.pc_number, status: pco.status, expectedAt: pco.expected_at ?? null } : null,
        po: po ? { id: po.id, poNumber: po.po_number, status: po.status, expectedAt: po.expected_at ?? null } : null,
        deliveryLocation: wh ? { id: wh.id, code: wh.code, name: wh.name } : null,
        supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.name } : null,
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

/* ── GET /supplier-options — the supplier picker for a requester ───────────────
   A salesperson holds no procurement area, so /suppliers (scm.procurement.
   suppliers) is closed to them; this answers id / code / name of the ACTIVE
   suppliers of the active company and nothing else (no terms, no bank, no
   finance part). Before GET /:id so the path is not read as an id. */
export const productRequestSupplierOptionsHandler = async (c: any): Promise<Response> => {
  if (!mayOpen(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await sb.from('suppliers').select('id, code, name, status').eq('company_id', co.companyId).order('name');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const suppliers = ((data ?? []) as Row[]).filter((s) => s.status == null || String(s.status).toUpperCase() === 'ACTIVE')
    .map((s) => ({ id: String(s.id), code: String(s.code ?? ''), name: String(s.name ?? '') }));
  return c.json({ suppliers });
};
productRequests.get('/supplier-options', productRequestSupplierOptionsHandler);

/* ── GET /pending-count — the red count on the Purchaser's sidebar entry ──────
   HC-0136: same as the SO amendment badge. Literal holders only — the `*`
   roles see every request inside the module, and a badge carrying every
   desk's backlog is one its reader learns to ignore (so-amendments.ts).
   Registered before /:id, which would read "pending-count" as an id. Fails
   soft with 0: a badge must not turn the sidebar into an error. */
export const productRequestPendingCountHandler = async (c: any): Promise<Response> => {
  if (!holdsHouzsPermLiterally(c, PRODUCT_REQUEST_APPROVE_KEY)) return c.json({ count: 0 });
  const { count, error } = await scopeToCompany(
    c.get('supabase').from('product_requests').select('id', { count: 'exact', head: true }).eq('status', 'REQUESTED'),
    c,
  );
  if (error) {
    console.error('[product-requests] pending-count failed:', error.message);
    return c.json({ count: 0 });
  }
  return c.json({ count: count ?? 0 });
};
productRequests.get('/pending-count', productRequestPendingCountHandler);

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

/* ── The request's files (owner 2026-10-15: 需要可以 attach 文件功能) ──────────
   The ONE file factory every money document rides (doc-files.ts), fed this
   document's rules: the requester attaches to their own request, the Purchaser
   to any; a withdrawn or closed request takes no more; once the Purchaser has
   decided, the requester's files stay (the Purchaser may still remove one). */
export const PRODUCT_REQUEST_FILES: DocFilesSpec = {
  table: 'product_request_files',
  fkColumn: 'request_id',
  keyPrefix: 'product-request-files',
  writePerms: [PRODUCT_REQUEST_CREATE_KEY, PRODUCT_REQUEST_APPROVE_KEY],
  mayWrite: (c: any) => mayRequest(c) || isApprover(c),
  scanKind: null,
  load: async (c: any) => {
    const found = await loadVisible(c, c.req.param('id'));
    if ('resp' in found) return found;
    const r = found.req;
    const status = String(r.status) as ProductRequestStatus;
    return {
      doc: {
        id: String(r.id),
        closed: status === 'WITHDRAWN' || status === 'CLOSED',
        /* Decided: the requester's evidence stays as the Purchaser read it. */
        locked: !isApprover(c) && !requesterMayChange(status),
      },
    };
  },
  closedRefusal: { error: 'request_closed', message: 'A withdrawn or closed request takes no more files.' },
  lockedRefusal: { error: 'request_decided', message: 'The Purchaser has decided this request — its files stay. Ask the Purchaser to remove one.' },
  keepOne: undefined,
};
const fileHandlers = makeDocFileHandlers(PRODUCT_REQUEST_FILES);
export const uploadProductRequestFileHandler = fileHandlers.upload;
export const listProductRequestFilesHandler = fileHandlers.list;
export const streamProductRequestFileHandler = fileHandlers.stream;
export const deleteProductRequestFileHandler = fileHandlers.remove;
productRequests.post('/:id/files', uploadProductRequestFileHandler);
productRequests.get('/:id/files', listProductRequestFilesHandler);
productRequests.get('/:id/files/:fileId', streamProductRequestFileHandler);
productRequests.delete('/:id/files/:fileId', deleteProductRequestFileHandler);

/* ── The requester's fields, as the body sends them ───────────────────────── */
type HeaderFields = {
  request_type: string; application: string;
  special_remarks: string | null; delivery_location_id: string | null; expected_delivery_date: string | null;
  /** The supplier the requester names (owner 2026-10-08, 方案 C: the Sales
      Director names the supplier and the agreed prices, the Purchaser records
      them). Optional; the agreed price sits on each line. */
  supplier_id: string | null;
};
type LineFields = {
  line_no: number;
  item_code: string | null; proposed_model_name: string | null; model_id: string | null; category: string;
  compartment: string | null; fabric_code: string | null; seat_size: string | null; leg_size: string | null;
  qty: number; unit_price_sen: number | null; remarks: string | null;
};

function readLine(body: Row, lineNo: number, requestType: string): { line: LineFields } | { error: string; message: string } {
  const itemCode = text(body.itemCode);
  const proposed = text(body.proposedModelName);
  const product = productRefusal(requestType, { item_code: itemCode, proposed_model_name: proposed }, lineNo);
  if (product) return product;
  const category = String(body.category ?? 'SOFA').trim().toUpperCase();
  if (!(MFG_PRODUCT_CATEGORIES as readonly string[]).includes(category)) {
    return { error: 'invalid_category', message: `Line ${lineNo}: category must be one of ${MFG_PRODUCT_CATEGORIES.join(', ')}.` };
  }
  const qty = body.qty === undefined || body.qty === null || body.qty === '' ? 1 : Number(body.qty);
  if (!Number.isInteger(qty) || qty <= 0) return { error: 'qty_invalid', message: `Line ${lineNo}: the quantity must be a whole number above zero.` };
  const price = body.unitPriceSen === undefined || body.unitPriceSen === null || body.unitPriceSen === '' ? null : Number(body.unitPriceSen);
  if (price !== null && (!Number.isInteger(price) || price < 0)) return { error: 'price_invalid', message: `Line ${lineNo}: the unit price must be zero or more, in sen.` };
  const remarks = text(body.remarks);
  if (remarks && remarks.length > LINE_REMARKS_MAX) return { error: 'remarks_too_long', message: `Line ${lineNo}: keep the remark to ${LINE_REMARKS_MAX} characters.` };
  return {
    line: {
      line_no: lineNo,
      /* An existing SKU names the product; the proposed name is then moot. */
      item_code: itemCode, proposed_model_name: itemCode ? null : proposed, model_id: null, category,
      compartment: text(body.compartment), fabric_code: text(body.fabricCode), seat_size: text(body.seatSize), leg_size: text(body.legSize),
      qty, unit_price_sen: price, remarks,
    },
  };
}

function readFields(body: Row): { header: HeaderFields; lines: LineFields[] } | { error: string; message: string } {
  const requestType = String(body.requestType ?? '').trim().toUpperCase();
  if (!(PRODUCT_REQUEST_TYPES as readonly string[]).includes(requestType)) {
    return { error: 'request_type_invalid', message: 'Is this a new product or a repack?' };
  }
  const application = String(body.application ?? '').trim().toUpperCase();
  if (!(PRODUCT_REQUEST_APPLICATIONS as readonly string[]).includes(application)) {
    return { error: 'application_invalid', message: 'Say what it is for — showroom, a customer order, a sample or a fair.' };
  }
  const rawLines = Array.isArray(body.lines) ? (body.lines as Row[]) : [];
  const count = linesRefusal(rawLines.length);
  if (count) return count;
  const lines: LineFields[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const read = readLine(rawLines[i] ?? {}, i + 1, requestType);
    if ('error' in read) return read;
    lines.push(read.line);
  }
  const remarks = text(body.specialRemarks);
  if (remarks && remarks.length > REMARKS_MAX) return { error: 'remarks_too_long', message: `Keep the special remarks to ${REMARKS_MAX.toLocaleString('en-MY')} characters.` };
  const expected = body.expectedDeliveryDate == null || body.expectedDeliveryDate === '' ? null : dateOrNull(body.expectedDeliveryDate);
  if (body.expectedDeliveryDate && !expected) return { error: 'date_invalid', message: 'The expected delivery date is not a date.' };
  return {
    header: {
      request_type: requestType, application,
      special_remarks: remarks, delivery_location_id: text(body.deliveryLocationId), expected_delivery_date: expected,
      supplier_id: text(body.supplierId),
    },
    lines,
  };
}

/** What the fields name must exist in this company: each line's SKU (which
    also fixes the line's category and Model) and fabric; the delivery
    location; the supplier. */
async function resolveFields(c: any, companyId: number, header: HeaderFields, lines: LineFields[]): Promise<{ error: string; message: string } | null> {
  const sb = c.get('supabase');
  for (const l of lines) {
    if (l.item_code) {
      const { data, error } = await sb.from('mfg_products').select('id, code, category, model_id').eq('company_id', companyId).eq('code', l.item_code).maybeSingle();
      if (error) return { error: 'load_failed', message: error.message };
      if (!data) return { error: 'unknown_item', message: `Line ${l.line_no}: ${l.item_code} is not in the catalogue — pick a SKU from the list, or name the new Model instead.` };
      l.item_code = String(data.code);
      l.category = String(data.category ?? l.category).toUpperCase();
      l.model_id = data.model_id ? String(data.model_id) : null;
    }
    if (l.fabric_code) {
      const { data, error } = await sb.from('fabric_trackings').select('fabric_code').eq('company_id', companyId).eq('fabric_code', l.fabric_code).maybeSingle();
      if (error) return { error: 'load_failed', message: error.message };
      if (!data) return { error: 'unknown_fabric', message: `Line ${l.line_no}: ${l.fabric_code} is not a fabric in the Fabric Converter — pick one from the list.` };
    }
  }
  if (header.delivery_location_id) {
    const { data, error } = await sb.from('warehouses').select('id').eq('company_id', companyId).eq('id', header.delivery_location_id).maybeSingle();
    if (error) return { error: 'load_failed', message: error.message };
    if (!data) return { error: 'unknown_location', message: 'The delivery location is not a warehouse of this company.' };
  }
  if (header.supplier_id) {
    const { data, error } = await sb.from('suppliers').select('id').eq('company_id', companyId).eq('id', header.supplier_id).maybeSingle();
    if (error) return { error: 'load_failed', message: error.message };
    if (!data) return { error: 'unknown_supplier', message: 'The supplier is not a supplier of this company — pick one from the list.' };
  }
  return null;
}

/** The lines in one line, for the audit trail: `5530-3S ×2; Aurora (new) ×1`. */
const linesSummary = (lines: ReadonlyArray<{ item_code: string | null; proposed_model_name: string | null; qty: number }>): string =>
  lines.map((l) => `${l.item_code ?? `${l.proposed_model_name ?? '?'} (new)`} ×${l.qty}`).join('; ');

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
  const resolved = await resolveFields(c, co.companyId, read.header, read.lines);
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
    ...read.header,
    status: 'REQUESTED',
  }).select(COLS).single();
  if (error || !row) return c.json({ error: 'save_failed', reason: error?.message ?? 'insert returned nothing' }, 500);
  const { error: lErr } = await sb.from('product_request_lines')
    .insert(read.lines.map((l) => ({ ...l, company_id: co.companyId, request_id: row.id })));
  if (lErr) {
    /* The header without its lines is not a request: take it back so the
       number is not spent on an empty document. */
    await sb.from('product_requests').delete().eq('company_id', co.companyId).eq('id', row.id);
    return c.json({ error: 'save_failed', reason: lErr.message }, 500);
  }
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(row.id), entityDocNo: requestNo, action: 'CREATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'REQUESTED',
    fieldChanges: compactChanges([
      fieldChange('requestType', null, read.header.request_type), fieldChange('lineCount', null, read.lines.length),
      fieldChange('products', null, linesSummary(read.lines)),
    ]),
  });
  await notifyProductRequest(c.env, 'raised', {
    requestNo, companyId: co.companyId, requesterUserId: me, requesterName: actorName(c) || null,
    products: linesSummary(read.lines), lineCount: read.lines.length,
  });
  const linked = await withLinks(c, co.companyId, [row as Row]);
  if ('resp' in linked) return linked.resp;
  return c.json({ ok: true, request: linked.rows[0] }, 201);
};
productRequests.post('/', createProductRequestHandler);

/* ── PATCH /:id — the requester's change; a rejected request goes back in ───
   Header fields not in the body keep their stored value; `lines`, when sent,
   REPLACES the set (every line re-read and re-resolved), when absent the stored
   lines stay. */
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
    return c.json({ error: 'request_locked', message: `${before.request_no} is ${statusWords(before.status)} — it can no longer change.` }, 409);
  }
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const storedLines = await loadLines(c, co.companyId, [String(before.id)]);
  if ('resp' in storedLines) return storedLines.resp;
  const beforeLines = storedLines.byRequest.get(String(before.id)) ?? [];
  const replaceLines = body.lines !== undefined;
  const keep = (k: string, stored: unknown) => (body[k] !== undefined ? body[k] : stored);
  const read = readFields({
    requestType: keep('requestType', before.request_type), application: keep('application', before.application),
    specialRemarks: keep('specialRemarks', before.special_remarks),
    deliveryLocationId: keep('deliveryLocationId', before.delivery_location_id), expectedDeliveryDate: keep('expectedDeliveryDate', before.expected_delivery_date),
    supplierId: keep('supplierId', before.supplier_id),
    lines: replaceLines ? body.lines : beforeLines.map((l) => ({
      itemCode: l.item_code, proposedModelName: l.proposed_model_name, category: l.category, compartment: l.compartment,
      fabricCode: l.fabric_code, seatSize: l.seat_size, legSize: l.leg_size, qty: l.qty, unitPriceSen: l.unit_price_sen, remarks: l.remarks,
    })),
  });
  if ('error' in read) return c.json(read, 400);
  const resolved = await resolveFields(c, co.companyId, read.header, read.lines);
  if (resolved) return c.json(resolved, resolved.error === 'load_failed' ? 500 : 400);
  const sb = c.get('supabase');
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(before.id), action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const resubmit = before.status === 'REJECTED';
  const { data: row, error } = await sb.from('product_requests')
    .update({ ...read.header, ...(resubmit ? { status: 'REQUESTED', decision_note: null, decided_by: null, decided_at: null } : {}), updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', before.id).eq('status', String(before.status)).select(COLS).maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'request_moved', message: `${before.request_no} changed a moment ago — open it again.` }, 409);
  if (replaceLines) {
    const { error: dErr } = await sb.from('product_request_lines').delete().eq('company_id', co.companyId).eq('request_id', before.id);
    if (dErr) return c.json({ error: 'save_failed', reason: dErr.message }, 500);
    const { error: lErr } = await sb.from('product_request_lines')
      .insert(read.lines.map((l) => ({ ...l, company_id: co.companyId, request_id: before.id })));
    if (lErr) return c.json({ error: 'save_failed', reason: lErr.message }, 500);
  }
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(before.id), entityDocNo: before.request_no, action: resubmit ? 'SUBMIT_FOR_APPROVAL' : 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: String(row.status),
    fieldChanges: compactChanges([
      ...(Object.keys(read.header) as Array<keyof HeaderFields>).map((k) => fieldChange(k, before[k] ?? null, read.header[k] ?? null)),
      fieldChange('lineCount', beforeLines.length, read.lines.length),
      fieldChange('products', linesSummary(beforeLines as LineFields[]), linesSummary(read.lines)),
    ]),
  });
  if (resubmit) {
    await notifyProductRequest(c.env, 'resubmitted', {
      requestNo: String(before.request_no), companyId: co.companyId, requesterUserId: callerUserId(c), requesterName: actorName(c) || null,
      products: linesSummary(read.lines), lineCount: read.lines.length,
    });
  }
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
    return c.json({ error: 'request_decided', message: `${r.request_no} is ${statusWords(r.status)} — ask the Purchaser to close it instead.` }, 409);
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

/* ── POST /:id/approve — the Purchaser's yes, to the whole request ─────────── */
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
    return c.json({ error: 'bad_transition', message: `${r.request_no} is ${statusWords(r.status)} — only a waiting request is approved.` }, 409);
  }
  const lines = await loadLines(c, co.companyId, [String(r.id)]);
  if ('resp' in lines) return lines.resp;
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
  /* How many lines still need a Model built before a PC Order can be raised. */
  const pendingModels = (lines.byRequest.get(String(r.id)) ?? []).filter((l) => !l.item_code).length;
  return c.json({ ok: true, needsModel: pendingModels > 0, pendingModels });
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
    return c.json({ error: 'bad_transition', message: `${r.request_no} is ${statusWords(r.status)} — only a waiting request is rejected.` }, 409);
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

/* ── POST /:id/lines/:lineId/create-model — a line's new Model + its first SKU ─
   Body: { modelCode, skuCode?, name? }. The Model is found-or-created on
   (company, model_code, category) through the ONE helper every SKU-create
   path shares (lib/ensure-model-for-sku.ts); the SKU lands ACTIVE and
   pos_active=false — the catalogue has it, POS does not offer it until someone
   turns it on. The line then names the SKU (item_code / model_id); once every
   line does, a PC Order can be raised from the request. */
export const createModelFromRequestLineHandler = async (c: any): Promise<Response> => {
  if (!isApprover(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  if (r.status !== 'APPROVED') {
    return c.json({ error: 'request_not_approved', message: `${r.request_no} is ${statusWords(r.status)} — approve it first, then build the Model.` }, 409);
  }
  const sb = c.get('supabase');
  const { data: line, error: lineErr } = await sb.from('product_request_lines').select(LINE_COLS)
    .eq('company_id', co.companyId).eq('request_id', r.id).eq('id', c.req.param('lineId')).maybeSingle();
  if (lineErr) return c.json({ error: 'load_failed', reason: lineErr.message }, 500);
  if (!line) return c.json({ error: 'line_not_found', message: `That line is not on ${r.request_no}.` }, 404);
  if (line.item_code) return c.json({ error: 'model_exists', message: `Line ${line.line_no} already names ${line.item_code} — there is no Model to build.` }, 409);
  const modelCode = (text(body.modelCode) ?? '').toUpperCase().replace(/\s+/g, '-');
  if (!modelCode) return c.json({ error: 'model_code_required', message: 'Give the new Model a code (e.g. 5530).' }, 400);
  if (modelCode.length > 32) return c.json({ error: 'model_code_too_long', message: 'A Model code is at most 32 characters.' }, 400);
  const category = String(line.category ?? 'SOFA').toUpperCase();
  const skuCode = (text(body.skuCode) ?? defaultSkuCode(modelCode, category, line.compartment ?? null)).toUpperCase().replace(/\s+/g, '-');
  if (skuCode.length > 30) return c.json({ error: 'sku_code_too_long', message: 'A SKU code is at most 30 characters (AutoCount item code).' }, 400);
  const name = text(body.name) ?? String(line.proposed_model_name ?? modelCode);

  const { data: taken, error: tErr } = await sb.from('mfg_products').select('id').eq('company_id', co.companyId).eq('code', skuCode).maybeSingle();
  if (tErr) return c.json({ error: 'load_failed', reason: tErr.message }, 500);
  if (taken) return c.json({ error: 'duplicate_code', message: `${skuCode} is already a SKU — pick it on the line instead, or give the new one another code.` }, 409);
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
    description: line.remarks ?? r.special_remarks ?? null, cost_price_sen: 0, unit_m3_milli: 0,
  });
  if (sErr) {
    if (String(sErr.code) === '23505') return c.json({ error: 'duplicate_code', message: `${skuCode} was taken a moment ago — give the new SKU another code.` }, 409);
    return c.json({ error: 'sku_insert_failed', reason: sErr.message }, 500);
  }
  /* Guarded on the line still having no SKU, so two builds at once cannot both
     name it — the second one's SKU stands in the catalogue, unattached. */
  const { data: updated, error } = await sb.from('product_request_lines')
    .update({ item_code: skuCode, model_id: ensured.modelId, updated_at: new Date().toISOString() })
    .eq('company_id', co.companyId).eq('id', line.id).is('item_code', null).select('id').maybeSingle();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!updated) return c.json({ error: 'request_moved', message: `Line ${line.line_no} changed a moment ago — the SKU ${skuCode} was created; open the request again.` }, 409);
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'APPROVED',
    fieldChanges: compactChanges([
      fieldChange('lineNo', null, line.line_no), fieldChange('modelCode', null, modelCode),
      fieldChange('itemCode', null, skuCode), fieldChange('modelCreated', null, ensured.created),
    ]),
  });
  const linked = await withLinks(c, co.companyId, [r]);
  if ('resp' in linked) return linked.resp;
  return c.json({ ok: true, model: { id: ensured.modelId, modelCode, created: ensured.created }, sku: { id: skuId, code: skuCode }, lineId: String(line.id), request: linked.rows[0] }, 201);
};
productRequests.post('/:id/lines/:lineId/create-model', createModelFromRequestLineHandler);

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
    return c.json({ error: 'bad_transition', message: `${r.request_no} is ${statusWords(r.status)} — only an approved or issued request is closed.` }, 409);
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

/* ── POST /:id/link-po — a Purchase Order raised from it claims it ────────────
   Body: { poId }. Called by PO New (?fromProductRequest=) once the PO stands:
   the PO route is not touched, so the PO is created first and claims the
   request after. The same rules as the PC Order's door (approved, every line a
   SKU, no order yet); a refusal leaves the PO standing, unlinked, and says so.
   Guarded on APPROVED, so a PC Order and a PO raised at once cannot both claim it. */
export const linkPurchaseOrderHandler = async (c: any): Promise<Response> => {
  if (!isApprover(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const poId = text(body.poId);
  if (!poId) return c.json({ error: 'po_id_required', message: 'Say which Purchase Order was raised from the request.' }, 400);
  const found = await loadVisible(c, c.req.param('id'));
  if ('resp' in found) return found.resp;
  const r = found.req;
  const lines = await loadLines(c, co.companyId, [String(r.id)]);
  if ('resp' in lines) return lines.resp;
  const refusal = orderFromRequestRefusal({ status: String(r.status), request_no: String(r.request_no), lines: (lines.byRequest.get(String(r.id)) ?? []).map((l) => ({ item_code: l.item_code ?? null })) }, 'PO');
  if (refusal) return c.json(refusal, 409);
  const sb = c.get('supabase');
  const { data: po, error: poErr } = await sb.from('purchase_orders').select('id, po_number')
    .eq('company_id', co.companyId).eq('id', poId).maybeSingle();
  if (poErr) return c.json({ error: 'load_failed', reason: poErr.message }, 500);
  if (!po) return c.json({ error: 'po_not_found', message: 'That Purchase Order is not in the company you are working in.' }, 404);
  const pf = await assertAuditWritable(sb, { entityType: 'PRODUCT_REQUEST', entityId: String(r.id), action: 'UPDATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const moved = await moveStatus(c, co.companyId, r, 'PO_ISSUED', { po_id: po.id });
  if ('resp' in moved) return moved.resp;
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: r.request_no, action: 'UPDATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'PO_ISSUED',
    fieldChanges: compactChanges([fieldChange('poNumber', null, po.po_number)]),
  });
  return c.json({ ok: true, poNumber: po.po_number });
};
productRequests.post('/:id/link-po', linkPurchaseOrderHandler);
