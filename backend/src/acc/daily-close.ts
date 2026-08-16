// ----------------------------------------------------------------------------
// acc/daily-close — the daily cashup (brief §3.5 layer 2).
//
// "当天不结，隔天就查不出是哪一笔" — the close compares what the SYSTEM says
// came in today (the sales panels' payment rows, bucketed cash / transfer /
// per-acquirer) against what was actually COUNTED, per company per day.
//
// Confirming the close posts the CASH difference immediately through the one
// gate (over/short, 946-0000): a drawer that is short books the loss the day
// it happened, never "later". Card/transfer differences are settlement timing
// — the layer-3 acquirer reconciliation owns those, so the close RECORDS them
// and refuses to invent an entry for them.
// ----------------------------------------------------------------------------

import { postJournal } from './engine';
import { resolveRoles } from './rules';

export type CloseBucketRow = {
  bucket: string; // 'cash' | 'transfer' | acquirer code
  systemSen: number;
  countedSen: number | null;
  diffSen: number;
  status: 'DRAFT' | 'CONFIRMED';
  notes: string | null;
};

/** Bucket a day's payment rows the way the drawer is counted. */
export function bucketPayments(
  rows: Array<{ method: string; merchant_provider: string | null; amount_centi: number }>,
): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const r of rows) {
    if (r.method === 'imported') continue; // migration-era, never part of a day's takings
    const key =
      r.method === 'cash' ? 'cash'
      : r.method === 'transfer' ? 'transfer'
      : (r.merchant_provider?.trim() || 'UNMAPPED');
    buckets.set(key, (buckets.get(key) ?? 0) + Number(r.amount_centi || 0));
  }
  return buckets;
}

/** System-side takings for one company+date, from BOTH sales panels. */
export async function systemTakings(
  sb: any,
  companyId: number,
  date: string,
): Promise<{ ok: true; buckets: Map<string, number> } | { ok: false; reason: string }> {
  const dayStart = date;
  const dayEnd = `${date}T23:59:59.999`;
  const { data: soPays, error: soErr } = await sb
    .from('mfg_sales_order_payments')
    .select('method, merchant_provider, amount_centi')
    .eq('company_id', companyId)
    .gte('paid_at', dayStart)
    .lte('paid_at', dayEnd);
  if (soErr) return { ok: false, reason: `so payments: ${soErr.message}` };
  const { data: siPays, error: siErr } = await sb
    .from('sales_invoice_payments')
    .select('method, merchant_provider, amount_centi')
    .eq('company_id', companyId)
    .gte('paid_at', dayStart)
    .lte('paid_at', dayEnd);
  if (siErr) return { ok: false, reason: `si payments: ${siErr.message}` };
  const all = [
    ...((soPays ?? []) as Array<{ method: string; merchant_provider: string | null; amount_centi: number }>),
    ...((siPays ?? []) as Array<{ method: string; merchant_provider: string | null; amount_centi: number }>),
  ];
  return { ok: true, buckets: bucketPayments(all) };
}

/**
 * Confirm the CASH bucket of a day's close: post the over/short and mark the
 * row confirmed. Idempotent through the gate — source SOPAY-style key
 * 'CASHUP' + company/date, and the one-active index refuses a double post.
 * A zero difference confirms with NO entry (nothing happened; §2.14 is about
 * failures, not silence about nothing).
 */
export async function postCashOverShort(
  sb: any,
  companyId: number,
  date: string,
  diffSen: number,
): Promise<{ ok: true; status: 'posted' | 'already_posted' | 'zero_diff'; jeNo?: string } | { ok: false; status: string; reason?: string }> {
  if (diffSen === 0) return { ok: true, status: 'zero_diff' };
  const roles = await resolveRoles(sb, companyId);
  // Counted < system → money is missing → expense (Dr over/short, Cr cash).
  // Counted > system → drawer is over → the reverse.
  const short = diffSen < 0;
  const amount = Math.abs(diffSen);
  const r = await postJournal(sb, {
    companyId,
    entryDate: date,
    sourceType: 'CASHUP',
    sourceDocNo: `${companyId}-${date}-cash`,
    narration: `Daily cash close ${date} — drawer ${short ? 'short' : 'over'} by ${(amount / 100).toFixed(2)}`,
    lines: short
      ? [
          { accountCode: roles.OVER_SHORT, debitSen: amount, creditSen: 0, notes: `Cash short on ${date}` },
          { accountCode: roles.CASH, debitSen: 0, creditSen: amount, notes: `Cash short on ${date}` },
        ]
      : [
          { accountCode: roles.CASH, debitSen: amount, creditSen: 0, notes: `Cash over on ${date}` },
          { accountCode: roles.OVER_SHORT, debitSen: 0, creditSen: amount, notes: `Cash over on ${date}` },
        ],
  });
  if (r.ok) {
    if (r.status === 'already_posted') return { ok: true, status: 'already_posted', jeNo: r.jeNo };
    return { ok: true, status: 'posted', jeNo: r.jeNo };
  }
  return { ok: false, status: r.status, reason: r.reason };
}
