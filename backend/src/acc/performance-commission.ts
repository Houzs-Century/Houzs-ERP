// ----------------------------------------------------------------------------
// acc/performance-commission — the Performance P&L's commission (owner
// 2026-11-25: 「如果performance PNL就remain invoice amount，因为这个是
// performance」). The actual P&L shows the commission as the monthly release
// moves it to cost (acc/commission-release.ts); the Performance P&L shows each
// month's commission BILLS — the month they pay for, whenever they were booked —
// on the commission expense account, in place of what the release booked there.
//
// Read once per report source (the Dashboard asks for many periods): every bill
// line on the prepayment (acc/commission-bills.ts) and every release line on the
// expense; a period takes the bills whose month starts inside it (so periods that
// follow each other never count a bill twice) and the release lines dated in it.
// ----------------------------------------------------------------------------

import { paginateAll } from '../scm/lib/paginate-all';
import { resolveRoles } from './rules';
import { countsInTheBooks } from './reversal-pairs';
import { loadPrepaidLines, RELEASE_SOURCE } from './commission-bills';
import type { Ym } from './commission-release-plan';

type Row = Record<string, unknown>;

export type CommissionFacts = {
  code: string;
  name: string | null;
  bills: Array<{ month: Ym; amountSen: number }>;
  releases: Array<{ day: string; sen: number }>;
};

/** The period's commission for the Performance P&L. */
export type PeriodCommission = {
  code: string;
  name: string | null;
  billSen: number;
  months: Ym[];
  releaseSen: number;
};

type Db = Parameters<typeof resolveRoles>[0];

export async function loadCommissionFacts(sb: Db, companyId: number): Promise<{ ok: true; facts: CommissionFacts | null } | { ok: false; reason: string }> {
  const roles = await resolveRoles(sb, companyId);
  const prepaid = await loadPrepaidLines(sb, companyId, roles.COMMISSION_PREPAID);
  if (!prepaid.ok) return prepaid;
  const code = roles.COMMISSION_EXPENSE;
  const { data, error } = await paginateAll<Row>((f, t) => sb.from('v_gl_entries')
    .select('line_id, entry_date, source_type, debit_sen, credit_sen, posted, reversed, reversed_by_je')
    .eq('company_id', companyId).eq('account_code', code).in('source_type', [RELEASE_SOURCE, `${RELEASE_SOURCE}_REVERSAL`])
    .order('line_id').range(f, t));
  if (error) return { ok: false, reason: `commission release lines: ${String((error as { message?: string }).message ?? error)}` };
  const releases = (data ?? [])
    .filter((r) => countsInTheBooks(r as { posted?: boolean | null; reversed?: boolean | null; reversed_by_je?: string | null }))
    .map((r) => ({ day: String(r.entry_date ?? '').slice(0, 10), sen: Number(r.debit_sen ?? 0) - Number(r.credit_sen ?? 0) }));
  const bills = prepaid.lines.filter((l) => l.month != null).map((l) => ({ month: l.month as Ym, amountSen: l.amountSen }));
  if (bills.length === 0 && releases.length === 0) return { ok: true, facts: null };
  const { data: acct, error: acctErr } = await sb.from('accounts').select('account_name').eq('company_id', companyId).eq('account_code', code).maybeSingle();
  if (acctErr) return { ok: false, reason: `commission account: ${String(acctErr.message ?? acctErr)}` };
  return { ok: true, facts: { code, name: (acct as { account_name?: string | null } | null)?.account_name ?? null, bills, releases } };
}

export function commissionForPeriod(facts: CommissionFacts | null, from: string, to: string): PeriodCommission | null {
  if (!facts) return null;
  const inside = facts.bills.filter((b) => `${b.month}-01` >= from && `${b.month}-01` <= to);
  const billSen = inside.reduce((s, b) => s + b.amountSen, 0);
  const releaseSen = facts.releases.filter((r) => r.day >= from && r.day <= to).reduce((s, r) => s + r.sen, 0);
  const months = [...new Set(inside.map((b) => b.month))].sort();
  if (billSen === 0 && releaseSen === 0 && months.length === 0) return null;
  return { code: facts.code, name: facts.name, billSen, months, releaseSen };
}
