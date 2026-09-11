/* Credit and debit notes (owner 2026-09-05 / 2026-09-12; docs/bugs/0827):
   CN and DN to a customer, SCN from a supplier — raised as drafts, posted
   through the one gate, cancelled by contra. The server half is
   backend/src/scm/routes/credit-notes.ts. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type NoteKind = 'CN' | 'DN' | 'SCN';
export type NoteStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';

export type CreditNote = {
  id: string; note_number: string; kind: NoteKind;
  party_type: 'CUSTOMER' | 'SUPPLIER'; party_code: string | null; party_name: string | null;
  supplier_id: string | null; so_doc_no: string | null; sales_invoice_id: string | null;
  ap_invoice_id: string | null; purchase_invoice_id: string | null; source_doc_no: string | null;
  note_date: string; total_sen: number; reason: string | null; notes: string | null;
  status: NoteStatus; je_no: string | null;
  created_at: string; created_by: string | null; posted_at: string | null; cancelled_at: string | null;
};
export type CreditNoteLine = { id: string; line_no: number; description: string | null; account_code: string; amount_sen: number };
export type CreditNoteLineInput = { description?: string | null; accountCode?: string | null; amountSen: number };
export type CreditNoteCreate = {
  kind: NoteKind; noteDate: string; reason?: string | null; sourceDocNo?: string | null; notes?: string | null;
  soDocNo?: string | null; salesInvoiceId?: string | null; partyName?: string | null; partyCode?: string | null;
  supplierId?: string | null; lines: CreditNoteLineInput[];
};

const KEY = 'credit-notes';
const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: [KEY] });
  void qc.invalidateQueries({ queryKey: ['journal-entries'] });
  void qc.invalidateQueries({ queryKey: ['gl-entries'] });
};

export const useCreditNotes = (kind: NoteKind | 'ALL', status: NoteStatus | 'ALL') => useQuery({
  queryKey: [KEY, kind, status],
  queryFn: () => authedFetch<{ rows: CreditNote[] }>(`/credit-notes?kind=${kind === 'ALL' ? '' : kind}&status=${status === 'ALL' ? '' : status}`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

export const useCreditNoteDetail = (id: string | null) => useQuery({
  queryKey: [KEY, 'detail', id],
  enabled: id != null,
  queryFn: () => authedFetch<{ note: CreditNote; lines: CreditNoteLine[] }>(`/credit-notes/${id}`),
  staleTime: 0,
  retry: retryUnlessClientError,
});

export const useCreateCreditNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreditNoteCreate) =>
      authedFetch<{ ok: boolean; note: CreditNote }>('/credit-notes', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
  });
};

export const useUpdateCreditNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; noteDate?: string; reason?: string | null; sourceDocNo?: string | null; notes?: string | null; lines?: CreditNoteLineInput[] }) =>
      authedFetch<{ ok: boolean; note: CreditNote }>(`/credit-notes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
  });
};

export const usePostCreditNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: boolean; jeNo: string; status: string }>(`/credit-notes/${id}/post`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};

export const useCancelCreditNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: boolean }>(`/credit-notes/${id}/cancel`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};
