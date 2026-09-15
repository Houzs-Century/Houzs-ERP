// ----------------------------------------------------------------------------
// so-money-queries — the money on a cancelled Sales Order and its two exits
// (owner 2026-09-15; docs/bugs/0927, the backend; docs/bugs/0931, these
// screens): the panel's read, the refund request, the cancelled orders a new
// order may draw on, Finance's list — and the one vocabulary a CONVERTED
// payment row speaks on the desktop: the method label the select shows, the
// URL parameter the cancelled order's Convert button hands the New SO page,
// and the draft rows that parameter seeds.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type MoneyPayment = {
  id: string; paidOn: string; method: string; provider: string | null; amountSen: number;
  booked: boolean; collectedBy: string | null; convertedFrom: string | null;
};
export type MoneyRefund = { id: string; pvNumber: string; status: string; voucherDate: string; totalSen: number };
export type MoneyConversion = { paymentId: string; toDocNo: string; amountSen: number; paidOn: string; convertedOn: string };
export type OrderMoney = {
  docNo: string;
  status: string | null;
  cancelled: boolean;
  customer: { name: string | null; phone: string | null; customerId: string | null; debtorCode: string | null };
  payments: MoneyPayment[];
  bookedSen: number;
  refunds: MoneyRefund[];
  refundedSen: number;
  conversions: MoneyConversion[];
  convertedSen: number;
  remainingSen: number;
  open: boolean;
  reason: string | null;
};
export type ConvertSource = { docNo: string; customer: string | null; cancelledOn: string | null; remainingSen: number; bookedSen: number };

export const ORDER_MONEY_KEY = (docNo: string) => ['so-money', docNo] as const;

/** The panel's read: what the order collected, what left, what is left, and
    this customer's other cancelled orders with money. */
export const useOrderMoney = (docNo: string | null | undefined) => useQuery({
  queryKey: ORDER_MONEY_KEY(docNo ?? ''),
  queryFn: () => authedFetch<{ money: OrderMoney; others: ConvertSource[] }>(`/mfg-sales-orders/${encodeURIComponent(docNo ?? '')}/money`),
  enabled: Boolean(docNo),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** The cancelled orders THIS order may draw on (its customer's, plus any named outright). */
export const useConvertSources = (docNo: string | null | undefined, also: string[] = []) => useQuery({
  queryKey: ['so-convert-sources', docNo ?? '', also.join(',')],
  queryFn: () => authedFetch<{ sources: ConvertSource[] }>(`/mfg-sales-orders/${encodeURIComponent(docNo ?? '')}/convert-sources${also.length ? `?also=${encodeURIComponent(also.join(','))}` : ''}`),
  enabled: Boolean(docNo),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** Finance's list — every cancelled order still holding money; narrowed to
    one customer's by phone when a phone is given (the New SO page, which has
    no order yet). */
export const useCancelledWithMoney = (phone?: string | null, enabled = true) => useQuery({
  queryKey: ['so-cancelled-with-money', phone ?? ''],
  queryFn: () => authedFetch<{ orders: ConvertSource[]; totalRemainingSen: number }>(`/mfg-sales-orders/cancelled-with-money${phone ? `?phone=${encodeURIComponent(phone)}` : ''}`),
  enabled,
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** The Refund button: a Customer Refund voucher DRAFT for Finance. */
/** One refund draft for each of several cancelled orders (the SO list's bar). */
export const useRequestRefunds = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (asks: Array<{ docNo: string; amountSen: number; note?: string | null }>) => {
      const out: Array<{ docNo: string; pvNumber?: string; error?: string }> = [];
      for (const a of asks) {
        try {
          const r = await authedFetch<{ id: string; pvNumber: string }>(`/mfg-sales-orders/${encodeURIComponent(a.docNo)}/money/refund`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amountSen: a.amountSen, note: a.note ?? null }),
          });
          out.push({ docNo: a.docNo, pvNumber: r.pvNumber });
        } catch (e) {
          out.push({ docNo: a.docNo, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    },
    onSuccess: (out) => {
      for (const o of out) void qc.invalidateQueries({ queryKey: ORDER_MONEY_KEY(o.docNo) });
      void qc.invalidateQueries({ queryKey: ['refund-source'] });
      void qc.invalidateQueries({ queryKey: ['so-cancelled-with-money'] });
    },
  });
};

/** A cancelled order named by number, as a source to take money from — or
    why it cannot be one. */
export const readConvertSource = async (docNo: string): Promise<{ ok: true; source: ConvertSource } | { ok: false; reason: string }> => {
  const clean = docNo.trim();
  if (!clean) return { ok: false, reason: 'Type the order number.' };
  try {
    const r = await authedFetch<{ money: OrderMoney }>(`/mfg-sales-orders/${encodeURIComponent(clean)}/money`);
    const m = r.money;
    if (!m.cancelled) return { ok: false, reason: `${m.docNo} is not cancelled.` };
    if (m.remainingSen <= 0) return { ok: false, reason: m.reason ?? `${m.docNo} has no money left on it.` };
    return { ok: true, source: { docNo: m.docNo, customer: m.customer.name, cancelledOn: null, remainingSen: m.remainingSen, bookedSen: m.bookedSen } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
};

export const useRequestRefund = (docNo: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { amountSen: number; note?: string | null }) =>
      authedFetch<{ id: string; pvNumber: string }>(`/mfg-sales-orders/${encodeURIComponent(docNo)}/money/refund`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ORDER_MONEY_KEY(docNo) });
      void qc.invalidateQueries({ queryKey: ['refund-source'] });
      void qc.invalidateQueries({ queryKey: ['so-cancelled-with-money'] });
    },
  });
};

/* ── The converted row's vocabulary on the desktop ─────────────────────── */

/** The method label the select shows for money moved from a cancelled order —
    not a maintenance row (it is not a way money arrives), a label of its own. */
export const CONVERT_LABEL = 'Convert from cancelled SO';
/** The ledger code the row is stored under (acc/payments.ts CONVERTED_METHOD). */
export const CONVERTED_METHOD = 'converted';

export type ConvertPick = { docNo: string; amountSen: number };

/** `?convert=SO-a:40000,SO-b:30000` — what the cancelled order's Convert
    button hands the New SO page: one pick per cancelled order, in sen. */
export const convertParamOf = (picks: ConvertPick[]): string =>
  picks.filter((p) => p.docNo && p.amountSen > 0).map((p) => `${p.docNo}:${p.amountSen}`).join(',');

export const convertPicksFrom = (param: string | null | undefined): ConvertPick[] =>
  String(param ?? '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    const at = s.lastIndexOf(':');
    if (at <= 0) return [];
    const docNo = s.slice(0, at);
    const amountSen = Number(s.slice(at + 1));
    return Number.isInteger(amountSen) && amountSen > 0 ? [{ docNo, amountSen }] : [];
  });

/** Where the New SO page opens with the money already on it: the cancelled
    order's customer and lines copied (`copyFrom`), one converted row per pick. */
export const newOrderWithMoneyHref = (copyFrom: string, picks: ConvertPick[]): string =>
  `/scm/sales-orders/new?copyFrom=${encodeURIComponent(copyFrom)}&convert=${encodeURIComponent(convertParamOf(picks))}`;
