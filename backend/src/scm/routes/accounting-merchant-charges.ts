/* The Merchant charges report (owner 2026-09-12: 我需要知道 merchant charge 多少
   %，就是 charge / received amount，每个月的然后每个 merchant … 每个不同 merchant
   都要能看到，我指的是 gross … 每个月全部 merchant 加起来的%). Per month, per
   acquirer: the gross the merchant reports carry, the fee they took, the net,
   the fee as a % of gross; the bank's own charge on a payout day (docs/bugs/0787)
   beside it, and the two together as a % of gross; a total line per month
   across acquirers, and a grand total. Each month-and-acquirer opens to the
   reports (files) behind it. GET /accounting/reports/merchant-charges; see
   accounting.md (docs/bugs/0826).

   CASH AND ONLINE ARE ROWS TOO (owner 2026-09-14, docs/bugs/0900: 这个 merchant
   charge 其实会包括 cash online，只是 % 是 0 percent). The question the report
   answers is "of the money received, what did each channel cost" — and cash
   at the counter and online transfers are channels that cost nothing. No
   merchant carries them, so they are read where they live: the payments keyed
   on sales orders (`mfg_sales_order_payments`, method cash / transfer), by the
   day the payment was made, a cancelled order's money left out. They stand
   under each month as CASH and ONLINE, at 0.0%, opening to the payments
   themselves rather than to report files, and they count in the month's line
   and the grand total — so Charge % reads against everything received. The
   confirmed-only tick does not reach them: a keyed payment has nothing to
   confirm. Two sources, two calendars: a merchant row is dated by the
   report's trading day, a keyed payment by its own date, so a month's card
   figure and the ledger's card total can differ by a report that straddles
   the month end. */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const MONTH = /^\d{4}-\d{2}$/;

/** The two channels no merchant carries, as the rows name them. */
export const CASH_CHANNEL = 'CASH';
export const ONLINE_CHANNEL = 'ONLINE';
/** Payment methods behind each channel — `transfer` is every online kind
    (DuitNow, TNG, bank transfer …); `merchant` and `installment` ride the
    acquirers' reports and are never counted here. */
const CHANNEL_METHODS: Record<string, string> = { cash: CASH_CHANNEL, transfer: ONLINE_CHANNEL };
/** Acquirers first, alphabetically; then cash, then online. */
const channelRank = (acquirer: string): number => (acquirer === CASH_CHANNEL ? 1 : acquirer === ONLINE_CHANNEL ? 2 : 0);

type LineRow = { batch_id: number | null; acquirer_code: string | null; txn_date: string; gross_sen: number | null; fee_sen: number | null; net_sen: number | null; confirmed_at: string | null };
type BatchRow = { id: number; acquirer_code: string | null; file_name: string | null; period_from: string | null; period_to: string | null };
type PayoutRow = { batch_id: number | null; settled_on: string; charge_sen: number | null };
type PaymentRow = { id: string; so_doc_no: string; paid_at: string; method: string; online_type: string | null; amount_sen: number | null };

export type ChargeFigures = {
  lines: number; grossSen: number; feeSen: number; netSen: number; feePct: number;
  bankChargeSen: number; chargeSen: number; chargePct: number;
};
export type ChargeReport = ChargeFigures & { batchId: number; fileName: string | null; periodFrom: string | null; periodTo: string | null };
/** A payment keyed on a sales order that no merchant carried — listed under
    the CASH / ONLINE rows in place of report files. */
export type ChargePayment = { id: string; docNo: string; paidOn: string; amountSen: number; subType: string | null };
export type ChargeAcquirer = ChargeFigures & { month: string; acquirer: string; reports: ChargeReport[]; payments?: ChargePayment[] };
export type ChargeMonth = ChargeFigures & { month: string; acquirers: ChargeAcquirer[] };

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};
const emptyFigures = (): ChargeFigures => ({ lines: 0, grossSen: 0, feeSen: 0, netSen: 0, feePct: 0, bankChargeSen: 0, chargeSen: 0, chargePct: 0 });
const finish = <T extends ChargeFigures>(f: T): T => {
  f.chargeSen = f.feeSen + f.bankChargeSen;
  f.feePct = pct(f.feeSen, f.grossSen);
  f.chargePct = pct(f.chargeSen, f.grossSen);
  return f;
};
const addLine = (f: ChargeFigures, l: LineRow) => {
  f.lines += 1; f.grossSen += Number(l.gross_sen ?? 0); f.feeSen += Number(l.fee_sen ?? 0); f.netSen += Number(l.net_sen ?? 0);
};
/** A keyed payment costs nothing: gross and net are the amount, no fee. */
const addPayment = (f: ChargeFigures, p: ChargePayment) => {
  f.lines += 1; f.grossSen += p.amountSen; f.netSen += p.amountSen;
};

export const merchantChargesReport = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!MONTH.test(from) || !MONTH.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM, from on or before to.' }, 400);
  }
  const onlyAcquirer = String(c.req.query('acquirer') ?? '').trim().toUpperCase() || null;
  const confirmedOnly = String(c.req.query('confirmed') ?? '') === '1';
  const fromDay = `${from}-01`;
  const toDay = lastDayOf(to);
  const sb = c.get('supabase');
  const companyId = co.companyId;
  const failed = (what: string, e: unknown) =>
    c.json({ error: 'load_failed', reason: `${what}: ${String((e as { message?: string })?.message ?? e)}` }, 500);

  const lines = await paginateAll<LineRow>((f, t) =>
    sb.from('acc_settlement_rows')
      .select('batch_id, acquirer_code, txn_date, gross_sen, fee_sen, net_sen, confirmed_at')
      .eq('company_id', companyId).gte('txn_date', fromDay).lte('txn_date', toDay)
      .order('txn_date').order('id').range(f, t));
  if (lines.error) return failed('lines', lines.error);
  const kept = ((lines.data ?? []) as LineRow[])
    .filter((l) => !confirmedOnly || l.confirmed_at != null)
    .filter((l) => onlyAcquirer == null || String(l.acquirer_code ?? '').toUpperCase() === onlyAcquirer);

  /* The bank's own charge on a payout day, by the day the payout landed. */
  const payouts = await paginateAll<PayoutRow>((f, t) =>
    sb.from('acc_settlement_payout_batches')
      .select('batch_id, settled_on, charge_sen')
      .eq('company_id', companyId).gte('settled_on', fromDay).lte('settled_on', toDay)
      .order('settled_on').order('id').range(f, t));
  if (payouts.error) return failed('payouts', payouts.error);
  const charged = ((payouts.data ?? []) as PayoutRow[]).filter((p) => Number(p.charge_sen ?? 0) !== 0 && p.batch_id != null);

  const batchIds = [...new Set([...kept.map((l) => l.batch_id), ...charged.map((p) => p.batch_id)].filter((x): x is number => typeof x === 'number'))];
  const batches = new Map<number, BatchRow>();
  for (let i = 0; i < batchIds.length; i += 150) {
    const { data, error } = await sb.from('acc_settlement_batches')
      .select('id, acquirer_code, file_name, period_from, period_to')
      .eq('company_id', companyId).in('id', batchIds.slice(i, i + 150));
    if (error) return failed('reports', error);
    for (const b of (Array.isArray(data) ? data : []) as BatchRow[]) batches.set(Number(b.id), b);
  }

  /* The channels no merchant carries: the payments keyed on sales orders, by
     the day they were paid. Read only when the caller wants them — a merchant
     filter names one acquirer, and cash is not it. A cancelled order's money
     is not a collection (docs/bugs/0837) and is left out. */
  const wantedChannels = new Set(
    Object.values(CHANNEL_METHODS).filter((ch) => onlyAcquirer == null || onlyAcquirer === ch),
  );
  let keyed: PaymentRow[] = [];
  if (wantedChannels.size > 0) {
    const methods = Object.entries(CHANNEL_METHODS).filter(([, ch]) => wantedChannels.has(ch)).map(([m]) => m);
    const pays = await paginateAll<PaymentRow>((f, t) =>
      sb.from('mfg_sales_order_payments')
        .select('id, so_doc_no, paid_at, method, online_type, amount_sen')
        .eq('company_id', companyId).in('method', methods).gte('paid_at', fromDay).lte('paid_at', toDay)
        .order('paid_at').order('id').range(f, t));
    if (pays.error) return failed('payments', pays.error);
    keyed = (pays.data ?? []) as PaymentRow[];
    const docs = [...new Set(keyed.map((p) => p.so_doc_no))];
    const cancelled = new Set<string>();
    for (let i = 0; i < docs.length; i += 150) {
      const { data, error } = await sb.from('mfg_sales_orders')
        .select('doc_no, status')
        .eq('company_id', companyId).in('doc_no', docs.slice(i, i + 150));
      if (error) return failed('orders', error);
      for (const r of (Array.isArray(data) ? data : []) as Array<{ doc_no: string; status: string | null }>) {
        if (String(r.status ?? '').toUpperCase() === 'CANCELLED') cancelled.add(r.doc_no);
      }
    }
    keyed = keyed.filter((p) => !cancelled.has(p.so_doc_no));
  }

  /* month → acquirer → report. */
  const months = new Map<string, Map<string, Map<number, ChargeReport>>>();
  const at = (month: string, acquirer: string, batchId: number): ChargeReport => {
    const byAcq = months.get(month) ?? new Map<string, Map<number, ChargeReport>>();
    months.set(month, byAcq);
    const byBatch = byAcq.get(acquirer) ?? new Map<number, ChargeReport>();
    byAcq.set(acquirer, byBatch);
    const b = batches.get(batchId);
    const report = byBatch.get(batchId) ?? {
      ...emptyFigures(), batchId, fileName: b?.file_name ?? null, periodFrom: b?.period_from ?? null, periodTo: b?.period_to ?? null,
    };
    byBatch.set(batchId, report);
    return report;
  };
  for (const l of kept) {
    if (l.batch_id == null) continue;
    addLine(at(String(l.txn_date).slice(0, 7), String(l.acquirer_code ?? batches.get(l.batch_id)?.acquirer_code ?? '?').toUpperCase(), l.batch_id), l);
  }
  for (const p of charged) {
    const acquirer = String(batches.get(Number(p.batch_id))?.acquirer_code ?? '?').toUpperCase();
    if (onlyAcquirer != null && acquirer !== onlyAcquirer) continue;
    at(String(p.settled_on).slice(0, 7), acquirer, Number(p.batch_id)).bankChargeSen += Number(p.charge_sen ?? 0);
  }

  /* month → channel → the payments. */
  const channels = new Map<string, Map<string, ChargePayment[]>>();
  for (const p of keyed) {
    const channel = CHANNEL_METHODS[String(p.method)];
    if (!channel) continue;
    const month = String(p.paid_at).slice(0, 7);
    const byChannel = channels.get(month) ?? new Map<string, ChargePayment[]>();
    channels.set(month, byChannel);
    const list = byChannel.get(channel) ?? [];
    byChannel.set(channel, list);
    list.push({
      id: String(p.id), docNo: p.so_doc_no, paidOn: String(p.paid_at).slice(0, 10),
      amountSen: Number(p.amount_sen ?? 0), subType: p.online_type == null || p.online_type === '' ? null : String(p.online_type),
    });
  }

  const roll = (into: ChargeFigures, from_: ChargeFigures) => {
    into.lines += from_.lines; into.grossSen += from_.grossSen; into.feeSen += from_.feeSen; into.netSen += from_.netSen; into.bankChargeSen += from_.bankChargeSen;
  };
  const totals = emptyFigures();
  const monthKeys = [...new Set([...months.keys(), ...channels.keys()])].sort((a, b) => a.localeCompare(b));
  const out: ChargeMonth[] = monthKeys.map((month) => {
    const m: ChargeMonth = { ...emptyFigures(), month, acquirers: [] };
    const byAcq = months.get(month) ?? new Map<string, Map<number, ChargeReport>>();
    for (const [acquirer, byBatch] of [...byAcq.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const a: ChargeAcquirer = { ...emptyFigures(), month, acquirer, reports: [] };
      for (const r of [...byBatch.values()].sort((x, y) => String(x.periodFrom ?? '').localeCompare(String(y.periodFrom ?? '')) || x.batchId - y.batchId)) {
        a.reports.push(finish(r));
        roll(a, r);
      }
      m.acquirers.push(finish(a));
      roll(m, a);
    }
    const byChannel = channels.get(month) ?? new Map<string, ChargePayment[]>();
    for (const [channel, list] of [...byChannel.entries()].sort(([a], [b]) => channelRank(a) - channelRank(b))) {
      const a: ChargeAcquirer = { ...emptyFigures(), month, acquirer: channel, reports: [], payments: [] };
      for (const p of [...list].sort((x, y) => x.paidOn.localeCompare(y.paidOn) || x.docNo.localeCompare(y.docNo) || x.id.localeCompare(y.id))) {
        a.payments!.push(p);
        addPayment(a, p);
      }
      m.acquirers.push(finish(a));
      roll(m, a);
    }
    roll(totals, m);
    return finish(m);
  });
  return c.json({ from, to, confirmedOnly, acquirer: onlyAcquirer, months: out, totals: finish(totals) });
};
