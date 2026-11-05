// ----------------------------------------------------------------------------
// A supplier bill's planned payment date (the owner's Claude Design, Money out
// batch 4 step 7; table scm.acc_bill_plans, mig 20261103T0700). Finance plans
// when it will pay a bill — beside the supplier's due date, never instead of
// it: Overdue still counts by the due date. The calendar and Daily Bank's
// upcoming payments read the plan, else the due date. Posts nothing.
//
// PUT /ap-invoices/plans {kind: 'API' | 'PI', id, plannedOn: 'YYYY-MM-DD' | null}
// — the keys that raise bills may plan them (owner question e7's default).
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';

type Row = Record<string, any>;

/** Every plan of the company, by `${kind}:${id}` — a small table, read whole. */
export async function billPlans(sb: any, companyId: number): Promise<{ ok: true; byBill: Map<string, string> } | { ok: false; reason: string }> {
  const r = await paginateAll<Row>((lo, hi) => sb.from('acc_bill_plans').select('bill_kind, bill_id, planned_on')
    .eq('company_id', companyId).order('bill_id').range(lo, hi));
  if (r.error) return { ok: false, reason: `bill plans: ${r.error.message}` };
  return { ok: true, byBill: new Map((r.data ?? []).map((p) => [`${String(p.bill_kind)}:${String(p.bill_id)}`, String(p.planned_on).slice(0, 10)])) };
}

const TABLE = { API: 'ap_invoices', PI: 'purchase_invoices' } as const;

export const putBillPlanHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create') && !hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to plan a bill's payment." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const kind = String(body?.kind ?? '').toUpperCase();
  if (kind !== 'API' && kind !== 'PI') return c.json({ error: 'bad_kind', message: 'kind is API (an AP bill) or PI (a purchase invoice).' }, 400);
  const id = String(body?.id ?? '').trim();
  if (!id) return c.json({ error: 'id_required', message: 'Name the bill to plan.' }, 400);
  const raw = body?.plannedOn;
  const plannedOn = raw == null || raw === '' ? null : String(raw);
  if (plannedOn != null && !/^\d{4}-\d{2}-\d{2}$/.test(plannedOn)) return c.json({ error: 'bad_date', message: 'plannedOn is a date, YYYY-MM-DD.' }, 400);

  const sb = c.get('supabase');
  const { data: bill, error } = await scopeToCompany(sb.from(TABLE[kind]).select('id, invoice_number, status, total_sen, paid_sen').eq('id', id), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!bill) return c.json({ error: 'not_found', message: 'That bill is not in the company you are working in.' }, 404);
  const b = bill as Row;
  const owed = Number(b.total_sen ?? 0) - Number(b.paid_sen ?? 0);
  if (b.status === 'DRAFT' || b.status === 'CANCELLED' || owed <= 0) {
    return c.json({ error: 'not_open', message: `${b.invoice_number} is not a posted bill still owed — only those are planned.` }, 409);
  }

  if (plannedOn == null) {
    const { error: delErr } = await sb.from('acc_bill_plans').delete().eq('company_id', co.companyId).eq('bill_kind', kind).eq('bill_id', id);
    if (delErr) return c.json({ error: 'save_failed', reason: delErr.message }, 500);
    return c.json({ ok: true, plannedOn: null });
  }
  if (plannedOn < todayMyt()) return c.json({ error: 'past_day', message: 'A bill cannot be planned on a past day.' }, 400);
  const who = String(c.get('houzsUser')?.name ?? c.get('user')?.id ?? '');
  const { error: upErr } = await sb.from('acc_bill_plans').upsert(
    { company_id: co.companyId, bill_kind: kind, bill_id: id, planned_on: plannedOn, planned_by: who || null, planned_at: new Date().toISOString() },
    { onConflict: 'company_id,bill_kind,bill_id' },
  );
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  return c.json({ ok: true, plannedOn });
};
