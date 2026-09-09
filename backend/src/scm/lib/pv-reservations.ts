// ----------------------------------------------------------------------------
// pv-reservations — what UNPOSTED payment vouchers have already applied to
// each supplier invoice (docs/bugs/0653).
//
// An allocation reserves its invoice the moment the voucher is SAVED, but the
// invoice's paid_sen moves only at Approve (the post path's settle). Between
// the two, the AP Payment picker and the create/edit doors must count what
// other unposted vouchers hold, or the same bill can be paid twice — the
// owner's case: HPV-2604-006 (checked, not approved) had applied all of
// 2990-API-2603-001 and the picker still offered it in full (2026-09-07:
// payment 已经分配了就不要显示).
//
// Nothing is stored: the figures are re-derived from pv_allocations every
// time, so an edit (full replace), a cancel (status leaves DRAFT), a reject
// (stays DRAFT, still reserved) or an approve (paid_sen moves, status POSTED)
// each correct the picture on their own. status 'DRAFT' covers Draft,
// Prepared and Checked. Advance applications (from_advance) settled paid_sen
// the moment they were applied and are NOT pending.
// ----------------------------------------------------------------------------

import { activeCompanyId, requireActiveCompanyId } from './companyScope';
import type { AllocationRow } from '../routes/payment-vouchers';

export type PendingReservations = {
  byPi: Record<string, number>;
  byApInvoice: Record<string, number>;
  /** Which vouchers hold each target, keyed by the PI / AP invoice id. */
  holders: Record<string, string[]>;
};

export async function pendingReservations(
  sb: any,
  companyId: number,
  opts: { supplierId?: string | null; excludePvId?: string | null } = {},
): Promise<{ ok: true; value: PendingReservations } | { ok: false; reason: string }> {
  let q = sb.from('payment_vouchers').select('id, pv_number, supplier_id').eq('company_id', companyId).eq('status', 'DRAFT');
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId);
  if (opts.excludePvId) q = q.neq('id', opts.excludePvId);
  const { data: pvs, error: pvErr } = await q;
  if (pvErr) return { ok: false, reason: pvErr.message };
  const value: PendingReservations = { byPi: {}, byApInvoice: {}, holders: {} };
  const numberOf = new Map<string, string>();
  for (const p of (pvs ?? []) as Array<{ id: string; pv_number: string }>) numberOf.set(String(p.id), String(p.pv_number));
  if (numberOf.size === 0) return { ok: true, value };
  const { data: allocs, error: aErr } = await sb.from('pv_allocations')
    .select('pv_id, pi_id, ap_invoice_id, amount_sen, from_advance')
    .eq('company_id', companyId)
    .in('pv_id', [...numberOf.keys()]);
  if (aErr) return { ok: false, reason: aErr.message };
  type Alloc = { pv_id: string; pi_id: string | null; ap_invoice_id: string | null; amount_sen: number; from_advance: boolean | null };
  for (const a of (allocs ?? []) as Alloc[]) {
    if (a.from_advance === true) continue;
    const sen = Number(a.amount_sen ?? 0);
    if (sen <= 0) continue;
    const target = a.pi_id ? String(a.pi_id) : a.ap_invoice_id ? String(a.ap_invoice_id) : null;
    if (!target) continue;
    const bucket = a.pi_id ? value.byPi : value.byApInvoice;
    bucket[target] = (bucket[target] ?? 0) + sen;
    const holder = numberOf.get(String(a.pv_id)) ?? String(a.pv_id);
    const list = value.holders[target] ?? (value.holders[target] = []);
    if (!list.includes(holder)) list.push(holder);
  }
  return { ok: true, value };
}

export type HeadroomBreach =
  | { error: 'over_allocation'; message: string; invoice: string; leftSen: number }
  | { error: 'load_failed'; reason: string };

/** The headroom door for a voucher's allocations: each target's outstanding
    (total − paid) minus what OTHER unposted vouchers already applied. Answers
    the first breach with the holder named, or null. An id the tables do not
    carry is left to the outside-company / on-hold doors beside this one. */
export async function allocationHeadroomBreach(
  sb: any,
  c: any,
  rows: AllocationRow[],
  excludePvId: string | null,
): Promise<HeadroomBreach | null> {
  if (rows.length === 0) return null;
  const companyId = activeCompanyId(c);
  if (companyId == null) return { error: 'load_failed', reason: 'no active company on the request' };
  const res = await pendingReservations(sb, companyId, { excludePvId });
  if (!res.ok) return { error: 'load_failed', reason: res.reason };
  type Head = { number: string; outstanding: number; reserved: number; holders: string[] };
  const heads = new Map<string, Head>();
  const load = async (table: 'purchase_invoices' | 'ap_invoices', ids: string[], reserved: Record<string, number>): Promise<string | null> => {
    if (ids.length === 0) return null;
    const { data, error } = await sb.from(table).select('id, invoice_number, total_sen, paid_sen').eq('company_id', companyId).in('id', ids);
    if (error) return String(error.message);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const id = String(r.id);
      heads.set(id, {
        number: String(r.invoice_number ?? id),
        outstanding: Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0),
        reserved: reserved[id] ?? 0,
        holders: res.value.holders[id] ?? [],
      });
    }
    return null;
  };
  const piIds = rows.flatMap((r) => (r.pi_id ? [r.pi_id] : []));
  const apiIds = rows.flatMap((r) => (r.ap_invoice_id ? [r.ap_invoice_id] : []));
  const e1 = await load('purchase_invoices', piIds, res.value.byPi);
  if (e1) return { error: 'load_failed', reason: e1 };
  const e2 = await load('ap_invoices', apiIds, res.value.byApInvoice);
  if (e2) return { error: 'load_failed', reason: e2 };
  /* This voucher's own rows per target add up — two rows on one invoice are one claim. */
  const want = new Map<string, number>();
  for (const r of rows) {
    const t = r.pi_id ?? r.ap_invoice_id;
    if (t) want.set(t, (want.get(t) ?? 0) + r.amount_sen);
  }
  for (const [t, sen] of want) {
    const h = heads.get(t);
    if (!h) continue;
    const left = Math.max(0, h.outstanding - h.reserved);
    if (sen > left) {
      const rm = (n: number) => (n / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const who = h.holders.length > 0
        ? ` — ${h.holders.join(', ')} already appl${h.holders.length === 1 ? 'ies' : 'y'} RM ${rm(h.reserved)} and ${h.holders.length === 1 ? 'is' : 'are'} not approved yet`
        : '';
      return {
        error: 'over_allocation',
        invoice: h.number,
        leftSen: left,
        message: `${h.number}: only RM ${rm(left)} is left to apply${who}.`,
      };
    }
  }
  return null;
}

/* GET /payment-vouchers/reservations/list?supplierId=&excludePvId= — the
   picker's other half: what unposted vouchers already applied, per invoice. */
export const pendingReservationsHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const supplierId = String(c.req.query('supplierId') ?? '').trim() || null;
  const excludePvId = String(c.req.query('excludePvId') ?? '').trim() || null;
  const res = await pendingReservations(c.get('supabase'), co.companyId, { supplierId, excludePvId });
  if (!res.ok) return c.json({ error: 'load_failed', reason: res.reason }, 500);
  return c.json(res.value);
};
