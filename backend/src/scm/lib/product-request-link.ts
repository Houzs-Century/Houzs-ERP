// The Purchase Consignment Order's door for a product request (owner
// 2026-10-06: 然后这个会连接 purchase consignment order). The PC Order's create
// handler calls these two; the request's own routes live in
// routes/product-requests.ts. Here because the create door is in the PC Order
// route and the rule must not be re-typed there.

import type { SupabaseClient } from '@supabase/supabase-js';
import { orderFromRequestRefusal } from '../shared/product-request';
import { recordEntityAudit, compactChanges, fieldChange, type AuditActor } from './entity-audit';

type Row = Record<string, any>;

export const PRODUCT_REQUEST_LINK_COLS = 'id, request_no, status, company_id, pco_id';
export const PRODUCT_REQUEST_LINE_LINK_COLS = 'id, line_no, item_code, qty';

/** The approved request a PC Order is being raised from, with its lines,
    company-scoped — or the refusal the create door answers with. */
export async function loadRequestForPco(
  sb: SupabaseClient,
  companyId: number,
  requestId: string,
): Promise<{ ok: true; request: Row } | { ok: false; status: 404 | 409 | 500; body: Record<string, unknown> }> {
  const { data, error } = await sb.from('product_requests').select(PRODUCT_REQUEST_LINK_COLS)
    .eq('company_id', companyId).eq('id', requestId).maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: 'load_failed', reason: error.message } };
  if (!data) return { ok: false, status: 404, body: { error: 'request_not_found', message: 'That product request is not in the company you are working in.' } };
  const { data: lines, error: lErr } = await sb.from('product_request_lines').select(PRODUCT_REQUEST_LINE_LINK_COLS)
    .eq('company_id', companyId).eq('request_id', requestId).order('line_no');
  if (lErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: lErr.message } };
  const request = { ...(data as Row), lines: (lines ?? []) as Row[] };
  const refusal = orderFromRequestRefusal(request as { status: string; request_no: string; lines: Array<{ item_code: string | null }> }, 'PCO');
  if (refusal) return { ok: false, status: 409, body: refusal };
  return { ok: true, request };
}

/** After the PC Order stands: the request points at it and reads PCO_ISSUED.
    Guarded on the status it was read in, so two orders raised at once from one
    request cannot both claim it — the loser's order stays, unlinked, and is
    reported back so the caller can say so. */
export async function markRequestPcoIssued(
  sb: SupabaseClient,
  companyId: number,
  request: Row,
  pco: { id: string; pc_number: string },
  actor: AuditActor | null | undefined,
): Promise<{ claimed: boolean }> {
  const { data, error } = await sb.from('product_requests')
    .update({ status: 'PCO_ISSUED', pco_id: pco.id, updated_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('id', request.id).eq('status', 'APPROVED').select('id').maybeSingle();
  if (error || !data) return { claimed: false };
  await recordEntityAudit(sb, {
    entityType: 'PRODUCT_REQUEST', entityId: String(request.id), entityDocNo: String(request.request_no), action: 'UPDATE',
    actor, companyId, statusSnapshot: 'PCO_ISSUED',
    fieldChanges: compactChanges([fieldChange('pcoNumber', null, pco.pc_number)]),
  });
  return { claimed: true };
}

/** A cancelled Purchase Order lets go of the request it was raised from: the
    request reads APPROVED again, with no po_id, so the Purchaser can raise
    another order from it (2990-0027 — PDR2610-009 stayed "PO raised" on a
    cancelled PO2610-068 and nothing could be raised again). Guarded on the
    request still naming this PO. A reopened PO does not take it back. */
export async function releaseRequestFromCancelledPo(
  sb: SupabaseClient,
  companyId: number,
  po: { id: string; po_number: string | null },
  actor: AuditActor | null | undefined,
): Promise<void> {
  const { data, error } = await sb.from('product_requests').select('id, request_no')
    .eq('company_id', companyId).eq('po_id', po.id).eq('status', 'PO_ISSUED');
  if (error) return;
  for (const r of (data ?? []) as Row[]) {
    const { data: moved, error: mErr } = await sb.from('product_requests')
      .update({ status: 'APPROVED', po_id: null, updated_at: new Date().toISOString() })
      .eq('company_id', companyId).eq('id', r.id).eq('po_id', po.id).eq('status', 'PO_ISSUED').select('id').maybeSingle();
    if (mErr || !moved) continue;
    await recordEntityAudit(sb, {
      entityType: 'PRODUCT_REQUEST', entityId: String(r.id), entityDocNo: String(r.request_no), action: 'UPDATE',
      actor, companyId, statusSnapshot: 'APPROVED',
      fieldChanges: compactChanges([fieldChange('status', 'PO_ISSUED', 'APPROVED'), fieldChange('poNumber', po.po_number, null)]),
      note: `${po.po_number ?? 'Purchase Order'} cancelled`,
    });
  }
}
