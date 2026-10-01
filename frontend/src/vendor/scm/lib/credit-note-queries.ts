/* Credit and debit notes (owner 2026-09-05 / 2026-09-12; docs/bugs/0827):
   CN and DN to a customer, SCN from a supplier — raised as drafts, posted
   through the one gate, cancelled by contra. The server half is
   backend/src/scm/routes/credit-notes.ts. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { fetchDocFileBlobUrl, type PvFile, type PvFilePayload } from './payment-voucher-queries';

export type NoteKind = 'CN' | 'DN' | 'SCN';
export type NoteStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';

export type CreditNote = {
  id: string; note_number: string; kind: NoteKind;
  party_type: 'CUSTOMER' | 'SUPPLIER'; party_code: string | null; party_name: string | null;
  supplier_id: string | null; so_doc_no: string | null; sales_invoice_id: string | null;
  ap_invoice_id: string | null; purchase_invoice_id: string | null; source_doc_no: string | null;
  /** The final invoice's number when the note answers one — read for the print (docs/bugs/0834). */
  sales_invoice_number?: string | null;
  /** The purchase invoice or AP invoice a supplier note credits (2026-10-01). */
  purchase_invoice_number?: string | null;
  ap_invoice_number?: string | null;
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
  /** The supplier's invoice a supplier note credits — one of that supplier's own (2026-10-01). */
  purchaseInvoiceId?: string | null; apInvoiceId?: string | null;
};

/* A scanned supplier credit note (owner 2026-10-01: supplier 给我 cn，我要做 ocr for
   cn；这个 cn 可能会 link 去相对应的 supplier invoice) — what POST /credit-notes/scan
   reads. Nothing is saved by the scan; the page fills the New note form with it. */
export type ScnScanLine = {
  description: string | null; itemCode: string | null; qty: number | null;
  /** As printed, before tax; amountSen is what the note credits (tax spread in). */
  printedSen: number | null; amountSen: number;
  accountCode: string | null; accountName: string | null; rule: string | null;
  creditsDocId: string | null;
};
export type ScnScanDoc = {
  kind: 'PI' | 'API'; id: string; number: string; invoiceRef: string | null; invoiceDate: string | null;
  totalSen: number; paidSen: number; status: string; outstandingSen: number;
};
export type ScnScan = {
  ok: true;
  read: {
    isCreditNote: boolean; vendorName: string | null; vendorRegNo: string | null; cnNumber: string | null; cnDate: string | null;
    invoiceNumbers: string[]; subtotalSen: number | null; sstSen: number | null; totalSen: number | null; remark: string | null;
  };
  supplier: { id: string; code: string | null; name: string; confidence: 'exact' | 'contains' } | null;
  lines: ScnScanLine[];
  invoices: ScnScanDoc[];
  suggested: { kind: 'PI' | 'API'; id: string; number: string } | null;
  duplicates: Array<{ noteNumber: string; status: string }>;
  notes: string[];
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

/** Read a supplier credit note (its pages) — POST /credit-notes/scan. */
export const useScanSupplierCreditNote = () => useMutation({
  mutationFn: (files: PvFilePayload[]) => authedFetch<ScnScan>('/credit-notes/scan', {
    method: 'POST', body: JSON.stringify({ files: files.map((f) => ({ name: f.name, mime: f.mime, dataBase64: f.dataBase64 })) }),
  }),
});

/* The note's paper (2026-10-01, mig 20261001T2355): the scanned credit note and
   anything else attached — the AP invoice's files card, bound to this document. */
export const useCreditNoteFiles = (noteId: string | null) => useQuery({
  queryKey: ['credit-note-files', noteId],
  queryFn: () => authedFetch<{ files: PvFile[] }>(`/credit-notes/${noteId}/files`),
  enabled: !!noteId,
  retry: retryUnlessClientError,
});

export const useUploadCreditNoteFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, file }: { noteId: string; file: PvFilePayload }) =>
      authedFetch<{ ok: true; file: PvFile }>(`/credit-notes/${noteId}/files`, {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }),
      }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ['credit-note-files', vars.noteId] }); },
  });
};

export const useDeleteCreditNoteFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, fileId }: { noteId: string; fileId: string }) =>
      authedFetch<{ ok: true }>(`/credit-notes/${noteId}/files/${fileId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ['credit-note-files', vars.noteId] }); },
  });
};

export const fetchCreditNoteFileBlobUrl = (noteId: string, fileId: string): Promise<{ url: string; contentType: string }> =>
  fetchDocFileBlobUrl(`/credit-notes/${noteId}/files/${fileId}`);

export const useCancelCreditNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: boolean }>(`/credit-notes/${id}/cancel`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};
