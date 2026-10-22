// ----------------------------------------------------------------------------
// /official-docs — the payments still owing their official invoice (owner
// 2026-10-01, payment-request item 3 → 做: 他们有时是给 proforma invoice, 这样我要
// follow up 回 original 单, 所以我有一个 list 看到这些要 follow up 的).
//
//   GET  /             every voucher and AP invoice OWED or RECEIVED (all=1 adds
//                      CHECKED), the longest waiting first, with the payment
//                      request it answered and who asked
//   POST /:kind/:id    { state: 'OWED' | 'CHECKED' | null, note? } — Finance marks
//                      a payment as owing its official invoice, checks the one
//                      that came, or clears the mark (kind PV | API)
//
// FINANCE ONLY (scm.payment_voucher.create, and the finance area guard in
// scm/index.ts). The requester's side reads OWED off the answer to their own
// request and uploads the official invoice there (routes/payment-request-bill.ts
// — RECEIVED is only ever set by that upload). The ledger is never touched.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { isRequestFinance } from '../lib/payment-request';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { OFFICIAL_DOC_TABLES, OFFICIAL_STATES, isOfficialDocKind, isOfficialState, officialActor, officialNoteOf } from '../lib/official-doc';

type Row = Record<string, any>;
const NO_PERM = { error: "You don't have permission to do that." };

export const officialDocs = new Hono<{ Bindings: Env; Variables: Variables }>();
officialDocs.use('*', supabaseAuth);

/* ── GET / ─────────────────────────────────────────────────────────────────── */
export const listOfficialDocsHandler = async (c: any): Promise<Response> => {
  if (!isRequestFinance(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* Open = still owed or waiting to be checked; all=1 adds the checked ones. */
  const states = c.req.query('all') === '1' ? [...OFFICIAL_STATES] : OFFICIAL_STATES.filter((s) => s !== 'CHECKED');
  const sb = c.get('supabase');
  const [pvs, apis] = await Promise.all([
    sb.from('payment_vouchers')
      .select('id, pv_number, payee_name, total_sen, status, voucher_date, approved_at, posted_at, official_doc, official_doc_note, official_doc_at, official_doc_by')
      .eq('company_id', co.companyId).in('official_doc', states),
    sb.from('ap_invoices')
      .select('id, invoice_number, supplier_id, total_sen, paid_sen, status, invoice_date, posted_at, official_doc, official_doc_note, official_doc_at, official_doc_by, supplier:suppliers(name)')
      .eq('company_id', co.companyId).in('official_doc', states),
  ]);
  const err = pvs.error ?? apis.error;
  if (err) return c.json({ error: 'load_failed', reason: err.message }, 500);
  const pvRows = ((pvs.data ?? []) as Row[]).filter((v) => v.status !== 'CANCELLED');
  const apiRows = ((apis.data ?? []) as Row[]).filter((i) => i.status !== 'CANCELLED');

  /* The payment request each one answered, and who asked — a voucher Finance
     made on its own answers none. */
  const byPv = new Map<string, Row>();
  const byApi = new Map<string, Row>();
  if (pvRows.length > 0 || apiRows.length > 0) {
    const [rp, ra] = await Promise.all([
      pvRows.length > 0
        ? sb.from('acc_payment_requests').select('id, request_no, requested_by, requested_by_name, pv_id').eq('company_id', co.companyId).in('pv_id', pvRows.map((v) => String(v.id)))
        : Promise.resolve({ data: [], error: null }),
      apiRows.length > 0
        ? sb.from('acc_payment_requests').select('id, request_no, requested_by, requested_by_name, ap_invoice_id').eq('company_id', co.companyId).in('ap_invoice_id', apiRows.map((i) => String(i.id)))
        : Promise.resolve({ data: [], error: null }),
    ]);
    const rErr = rp.error ?? ra.error;
    if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
    for (const r of (rp.data ?? []) as Row[]) byPv.set(String(r.pv_id), r);
    for (const r of (ra.data ?? []) as Row[]) byApi.set(String(r.ap_invoice_id), r);
  }
  const request = (r: Row | undefined) => (r ? { id: String(r.id), requestNo: String(r.request_no), requestedBy: r.requested_by_name ?? null } : null);
  const rows = [
    ...pvRows.map((v) => ({
      kind: 'PV' as const, id: String(v.id), number: v.pv_number ?? null, payee: v.payee_name ?? null, totalSen: Number(v.total_sen ?? 0),
      status: String(v.status), paidAt: v.status === 'POSTED' ? (v.approved_at ?? v.posted_at ?? null) : null, documentDate: v.voucher_date ?? null,
      state: String(v.official_doc), note: v.official_doc_note ?? null, since: v.official_doc_at ?? null, by: v.official_doc_by ?? null,
      request: request(byPv.get(String(v.id))),
    })),
    ...apiRows.map((i) => ({
      kind: 'API' as const, id: String(i.id), number: i.invoice_number ?? null, payee: i.supplier?.name ?? null, totalSen: Number(i.total_sen ?? 0),
      status: String(i.status), paidAt: i.status === 'PAID' ? (i.posted_at ?? null) : null, documentDate: i.invoice_date ?? null,
      state: String(i.official_doc), note: i.official_doc_note ?? null, since: i.official_doc_at ?? null, by: i.official_doc_by ?? null,
      request: request(byApi.get(String(i.id))),
    })),
  ].sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
  return c.json({ rows });
};
officialDocs.get('/', listOfficialDocsHandler);

/* ── POST /:kind/:id — mark owed, checked, or clear ────────────────────────── */
export const markOfficialDocHandler = async (c: any): Promise<Response> => {
  if (!isRequestFinance(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const kind = c.req.param('kind');
  if (!isOfficialDocKind(kind)) return c.json({ error: 'bad_kind', message: 'Name a voucher (PV) or an AP invoice (API).' }, 400);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const state = body.state === null ? null : body.state;
  /* RECEIVED is the upload's alone: Finance marks owed, checks, or clears. */
  if (state !== null && (!isOfficialState(state) || state === 'RECEIVED')) {
    return c.json({ error: 'bad_state', message: 'Mark it owed, checked, or clear the mark.' }, 400);
  }
  const t = OFFICIAL_DOC_TABLES[kind];
  const sb = c.get('supabase');
  const { data: doc, error } = await scopeToCompany(sb.from(t.table).select(`id, ${t.number}, status, official_doc, official_doc_note`).eq('id', c.req.param('id')), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!doc) return c.json({ error: 'not_found', message: 'That document is not in the company you are working in.' }, 404);
  const number = String((doc as Row)[t.number] ?? 'It');
  if (doc.status === 'CANCELLED') return c.json({ error: 'doc_cancelled', message: `${number} is cancelled — nothing is owed on it.` }, 409);
  if (state === 'CHECKED' && !doc.official_doc) {
    return c.json({ error: 'nothing_owed', message: `${number} was never marked as owing its official invoice.` }, 409);
  }
  const note = officialNoteOf(body.note);
  if (t.entityType) {
    const pf = await assertAuditWritable(sb, { entityType: t.entityType, entityId: String(doc.id), action: 'UPDATE', companyId: co.companyId });
    if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  }
  const { data: row, error: upErr } = await sb.from(t.table).update({
    official_doc: state,
    official_doc_note: state === null ? null : (note ?? doc.official_doc_note ?? null),
    official_doc_at: new Date().toISOString(),
    official_doc_by: officialActor(c),
  }).eq('company_id', co.companyId).eq('id', doc.id).select('id, official_doc').maybeSingle();
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (t.entityType) {
    await recordEntityAudit(sb, {
      entityType: t.entityType, entityId: String(doc.id), entityDocNo: number, action: 'UPDATE',
      actor: c.get('houzsUser'), companyId: co.companyId,
      fieldChanges: compactChanges([fieldChange('officialDoc', doc.official_doc ?? null, state)]),
    });
  }
  return c.json({ ok: true, state });
};
officialDocs.post('/:kind/:id', markOfficialDocHandler);
