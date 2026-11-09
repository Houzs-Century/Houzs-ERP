// ----------------------------------------------------------------------------
// GET /payment-vouchers/listing?from=&to=&stages= — the Payment listing (owner
// 2026-11-08: 「每天要过账的listing，就算pv号码，名字，description, purpose，包含
// bank account number」, 「我能自己filter 吗？」).
//
// Every voucher dated up to `to` (today by default) and from `from` when one is
// given, at the stages asked (by default Prepared and Checked: not posted yet),
// oldest first, each with what it is for and the bank it pays into
// (payment-vouchers-describe.ts). Read only, company-scoped, read whole (paged):
// a short listing that looks complete is the defect a payment run cannot afford.
// ----------------------------------------------------------------------------

import { scopeToCompany } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { HEADER } from './payment-vouchers-list';
import { describeVouchers } from './payment-vouchers-describe';

export const LISTING_STAGES = ['DRAFT', 'PREPARED', 'CHECKED', 'POSTED', 'CANCELLED'] as const;
export type ListingStage = typeof LISTING_STAGES[number];
const DEFAULT_STAGES: ListingStage[] = ['PREPARED', 'CHECKED'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The owner's four layers (2026-09-02) as one word: Prepared and Checked are DRAFTs wearing marks. */
export const stageOf = (r: Record<string, unknown>): ListingStage => {
  if (r.status === 'POSTED') return 'POSTED';
  if (r.status === 'CANCELLED') return 'CANCELLED';
  if (r.checked_at) return 'CHECKED';
  return r.submitted_at ? 'PREPARED' : 'DRAFT';
};
const STATUS_OF: Record<ListingStage, string> = { DRAFT: 'DRAFT', PREPARED: 'DRAFT', CHECKED: 'DRAFT', POSTED: 'POSTED', CANCELLED: 'CANCELLED' };

export const paymentListingHandler = async (c: any): Promise<Response> => {
  const sb = c.get('supabase');
  const toQ = String(c.req.query('to') ?? '').trim();
  const fromQ = String(c.req.query('from') ?? '').trim();
  const to = DATE.test(toQ) ? toQ : todayMyt();
  const from = DATE.test(fromQ) ? fromQ : null;
  if (from && from > to) return c.json({ error: 'bad_range', message: 'The first day must be on or before the last.' }, 400);
  const asked = String(c.req.query('stages') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unknown = asked.filter((s) => !(LISTING_STAGES as readonly string[]).includes(s));
  if (unknown.length > 0) return c.json({ error: 'bad_stage', message: `No such stage: ${unknown.join(', ')}.` }, 400);
  const stages = (asked.length > 0 ? LISTING_STAGES.filter((s) => asked.includes(s)) : DEFAULT_STAGES) as ListingStage[];
  const statuses = [...new Set(stages.map((s) => STATUS_OF[s]))];

  const { data, error } = await paginateAll<Record<string, unknown> & { id: string }>((f, t) => {
    let q = sb.from('payment_vouchers')
      .select(`${HEADER}, supplier:suppliers(id, code, name, bank_name, bank_account_no, bank_account_name)`)
      .in('status', statuses).lte('voucher_date', to);
    if (from) q = q.gte('voucher_date', from);
    return scopeToCompany(q, c).order('voucher_date').order('pv_number').range(f, t);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? [])
    .filter((r) => stages.includes(stageOf(r)))
    .sort((a, b) => String(a.voucher_date ?? '').localeCompare(String(b.voucher_date ?? '')) || String(a.pv_number).localeCompare(String(b.pv_number)));
  const described = await describeVouchers(sb, c, rows);
  if (!described.ok) return c.json({ error: 'load_failed', reason: described.reason }, 500);
  return c.json({
    from, to, stages,
    vouchers: rows.map((r) => ({ ...r, stage: stageOf(r), ...described.byId.get(r.id) })),
  });
};
