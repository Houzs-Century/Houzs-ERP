// ----------------------------------------------------------------------------
// official-doc-queries — 欠正式单 (owner 2026-10-01, payment-request item 3): the
// payments made on a proforma or a quotation that still owe the official
// invoice. Server: backend/src/scm/routes/official-docs.ts (Finance's list and
// marks) and POST /payment-requests/:id/official-doc (the requester's upload).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

export type OfficialState = 'OWED' | 'RECEIVED' | 'CHECKED';

/** Each state in the owner's words, and the colour it reads in. */
export const OFFICIAL_LABEL: Record<OfficialState, { label: string; tone: string }> = {
  OWED: { label: 'Official invoice owed · 欠正式单', tone: 'var(--c-festive-b, #B8331F)' },
  RECEIVED: { label: 'Official invoice received — to check · 待核对', tone: 'var(--c-orange)' },
  CHECKED: { label: 'Official invoice checked · 已核对', tone: 'var(--c-green, #2f7d32)' },
};
export const isOfficialState = (v: unknown): v is OfficialState => v === 'OWED' || v === 'RECEIVED' || v === 'CHECKED';

export type OfficialDocRow = {
  kind: 'PV' | 'API';
  id: string;
  number: string | null;
  payee: string | null;
  totalSen: number;
  status: string;
  paidAt: string | null;
  documentDate: string | null;
  state: OfficialState;
  note: string | null;
  since: string | null;
  by: string | null;
  request: { id: string; requestNo: string; requestedBy: string | null } | null;
};

export const useOfficialDocs = (all = false) => useQuery({
  queryKey: ['official-docs', all ? 'all' : 'open'],
  queryFn: () => authedFetch<{ rows: OfficialDocRow[] }>(`/official-docs${all ? '?all=1' : ''}`),
  staleTime: 15_000,
});

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['official-docs'] });
  void qc.invalidateQueries({ queryKey: ['payment-requests'] });
  void qc.invalidateQueries({ queryKey: ['payment-request'] });
  void qc.invalidateQueries({ queryKey: ['payment-voucher-detail'] });
  void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
  void qc.invalidateQueries({ queryKey: ['ap-invoices'] });
  void qc.invalidateQueries({ queryKey: ['ap-invoice'] });
};

/** Finance marks a payment owed, checks the official invoice that came, or clears the mark. */
export const useMarkOfficialDoc = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, state, note }: { kind: 'PV' | 'API'; id: string; state: 'OWED' | 'CHECKED' | null; note?: string | null }) =>
      authedFetch<{ ok: true; state: OfficialState | null }>(`/official-docs/${kind}/${id}`, { method: 'POST', body: JSON.stringify({ state, note: note ?? null }) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Not marked'),
  });
};

/** 补正式单 — the official invoice, uploaded on the request after the proforma was paid. */
export const useUploadOfficialDoc = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, file }: { requestId: string; file: { name: string; mime: string; dataBase64: string } }) =>
      authedFetch<{ ok: true; received: Array<{ kind: 'PV' | 'API'; number: string | null }>; note: string | null }>(
        `/payment-requests/${requestId}/official-doc`,
        { method: 'POST', body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }) },
      ),
    onSuccess: (_d, vars) => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: ['payment-request-files', vars.requestId] });
    },
    onError: writeFailedAs('Official invoice not uploaded'),
  });
};
