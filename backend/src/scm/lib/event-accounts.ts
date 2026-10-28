// ----------------------------------------------------------------------------
// event-accounts.ts — 需要 Event, decided by FINANCE on the chart (owner
// 2026-10-01, payment-request item 4: 申请人不用选类型，我定好哪里一些类型需要就一定
// 要选event). The requester never picks a type: the account Finance books a line
// to IS the type. An account ticked "needs Event" (scm.accounts.needs_event)
// cannot carry money out of the company without the event it was for — so a
// voucher or AP invoice line on one is refused at APPROVAL (the step that posts)
// until it has its Event. A company that runs no events (2990) is never asked.
//
// pms_row (the same chart, the second column) says which row of the PMS event
// page the money fills — read by the event page itself (payment-request item 5).
// ----------------------------------------------------------------------------

import { activeCompanySql, scopeToCompanyId } from './companyScope';
import { companyHasEvents } from './event-tags';

type Row = Record<string, any>;

/** The PMS event page's rows a Finance account can fill (item 5). */
export const PMS_ROWS = ['rental', 'setup', 'transport_setup_dismantle', 'transport_fee', 'commission', 'others'] as const;
export type PmsRow = (typeof PMS_ROWS)[number];
export const isPmsRow = (v: unknown): v is PmsRow => typeof v === 'string' && (PMS_ROWS as readonly string[]).includes(v);

/** Each row as the PMS event page names it — the chart's picker reads these. */
export const PMS_ROW_LABELS: Record<PmsRow, string> = {
  rental: 'Rental',
  setup: 'Setup',
  transport_setup_dismantle: 'Transport Setup & Dismantle',
  transport_fee: 'Transport Fee',
  commission: 'Commission',
  others: 'Others Costing',
};

export type EventLine = { debit_account_code: string; project_id?: number | null; line_no?: number | null };

/** The first line on a needs-Event account without its Event, as a refusal —
    or null when every such line has one (or the company runs no events). A
    failed read refuses: approving on a guess would post untagged money. */
export async function eventAccountRefusal(c: any, companyId: number, lines: EventLine[]): Promise<Response | null> {
  const untagged = lines.filter((l) => l.project_id == null);
  const codes = [...new Set(untagged.map((l) => String(l.debit_account_code)))];
  if (codes.length === 0) return null;
  const sb = c.get('supabase');
  const { data, error } = await sb.from('accounts').select('account_code, account_name, needs_event').eq('company_id', companyId).in('account_code', codes);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const needing = new Map(((data ?? []) as Row[]).filter((a) => a.needs_event === true).map((a) => [String(a.account_code), a]));
  if (needing.size === 0) return null;
  let hasEvents = true;
  try { hasEvents = await companyHasEvents(c.env.DB, activeCompanySql(c, 'p.company_id')); } catch { hasEvents = true; }
  if (!hasEvents) return null;
  const at = lines.findIndex((l) => l.project_id == null && needing.has(String(l.debit_account_code)));
  if (at < 0) return null;
  const line = lines[at]!;
  const acct = needing.get(String(line.debit_account_code))!;
  return c.json({
    error: 'event_required_on_line',
    message: `Line ${line.line_no ?? at + 1} (${acct.account_code} ${acct.account_name}) needs its Event — pick it, or untick 需要 Event on the account.`,
  }, 409);
}

/** The same check over a voucher's stored lines. */
export async function pvEventAccountRefusal(c: any, companyId: number, pvId: string): Promise<Response | null> {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompanyId(sb.from('payment_voucher_lines').select('line_no, debit_account_code, project_id').eq('pv_id', pvId), companyId).order('line_no');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return eventAccountRefusal(c, companyId, (data ?? []) as EventLine[]);
}
