// ----------------------------------------------------------------------------
// part-time-pay-queries — a part-time salesperson's pay for an event (owner
// 2026-10-14): the owner keys the sheet, HR confirms, the confirm raises the
// payment request Finance pays. Server: backend/src/scm/routes/hr-part-time-pay.ts.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { fetchDocFileBlobUrl } from './payment-voucher-queries';
import type { EventOption } from './event-queries';
import type { RequestStage } from './payment-request-queries';

export type PartTimeRates = { commissionBps: number; dayRateSen: number; wifiSen: number };

export type WorkDay = {
  date: string;
  /** The first POS login that day (the arrival), null when the day counts from a sale alone. */
  firstLoginAt: string | null;
  lastLogoutAt: string | null;
  logins: number;
  orders: number;
};

export type SlipFile = { id: string; fileName: string; mime: string; sizeBytes: number; createdAt: string };

export type PartTimeAnswer = {
  id: string;
  requestNo: string;
  status: string;
  stage: RequestStage;
  financeNote: string | null;
  voucher: { id: string; pvNumber: string | null; status: string | null; approvedAt: string | null; postedAt: string | null; bankConfirmed: boolean } | null;
  invoice: unknown;
  slips: SlipFile[];
};

export type SavedRow = {
  id: string;
  status: 'DRAFT' | 'CONFIRMED';
  days: number;
  sales_sen: number;
  commission_bps: number;
  commission_sen: number;
  day_rate_sen: number;
  salary_sen: number;
  wifi_sen: number;
  total_sen: number;
  bank_name: string | null;
  bank_account_no: string | null;
  bank_account_name: string | null;
  note: string | null;
  request_id: string | null;
  requested_by_name: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  breakdown: string;
  answer: PartTimeAnswer | null;
};

export type SheetLine = {
  staffId: string;
  staffName: string;
  staffCode: string;
  days: WorkDay[];
  suggestedDays: number;
  salesSen: number;
  orderCount: number;
  saved: SavedRow | null;
  salesChanged: boolean;
};

export type PartTimeSheet = {
  event: EventOption;
  rates: PartTimeRates;
  purpose: string;
  lines: SheetLine[];
  canRequest: boolean;
  canConfirm: boolean;
};

export type RowInput = {
  staffId: string; days: number; wifi: boolean;
  bankName: string | null; bankAccountNo: string | null; bankAccountName: string | null; note: string | null;
};

/** The same arithmetic the server prices with (lib/part-time-pay.ts) — for the
    preview while the owner types; the saved figure is the server's. */
export function previewAmounts(input: { days: number; salesSen: number; wifi: boolean; rates: PartTimeRates }) {
  const days = Number.isInteger(input.days) && input.days > 0 ? input.days : 0;
  const sales = input.salesSen > 0 ? input.salesSen : 0;
  const commissionSen = sales > 0 ? Math.round((sales * input.rates.commissionBps) / 10_000) : 0;
  const salarySen = days * input.rates.dayRateSen;
  const wifiSen = input.wifi ? input.rates.wifiSen : 0;
  return { commissionSen, salarySen, wifiSen, totalSen: commissionSen + salarySen + wifiSen };
}

export const usePartTimeEvents = (q: string) => useQuery({
  queryKey: ['part-time-pay', 'events', q],
  queryFn: () => authedFetch<{ events: EventOption[] }>(`/hr/part-time-pay/events${q.trim().length >= 2 ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
  staleTime: 60_000,
});

export const usePartTimeSheet = (projectId: number | null) => useQuery({
  queryKey: ['part-time-pay', 'sheet', projectId],
  queryFn: () => authedFetch<PartTimeSheet>(`/hr/part-time-pay?projectId=${projectId}`),
  enabled: projectId != null,
  staleTime: 10_000,
});

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['part-time-pay'] });
  void qc.invalidateQueries({ queryKey: ['payment-requests'] });
};

export const useSavePartTimeSheet = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { projectId: number; rows: RowInput[] }) =>
      authedFetch<{ ok: true; rows: SavedRow[] }>('/hr/part-time-pay', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Sheet not saved'),
  });
};

export const useRemovePartTimeRow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/hr/part-time-pay/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Row not removed'),
  });
};

export const useConfirmPartTimeRow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true; request: { id: string; requestNo: string } }>(`/hr/part-time-pay/${id}/confirm`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Not confirmed'),
  });
};

/** A file on the voucher that paid the row — the bank slip. */
export const fetchPartTimeSlipUrl = (rowId: string, fileId: string): Promise<{ url: string; contentType: string }> =>
  fetchDocFileBlobUrl(`/hr/part-time-pay/${rowId}/slip/${fileId}`);
