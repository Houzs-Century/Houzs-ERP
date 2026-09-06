// ----------------------------------------------------------------------------
// ap-invoice-queries — the AP Invoice (the non-stock supplier bill) and the
// Finance list that shows it BESIDE the operational purchase invoices (owner
// 2026-09-06: 我想要两个都看到, 现有的 purchase invoice remain). Server half:
// backend/src/scm/routes/ap-invoices.ts.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { fetchDocFileBlobUrl, type PvFile, type PvFilePayload } from './payment-voucher-queries';

export type ApListKind = 'ALL' | 'API' | 'PI';

/** One row of the Finance list — a purchase invoice (read-only mirror) or an
    AP invoice raised here; `kind` says which. */
export type ApListRow = {
  kind: 'API' | 'PI';
  id: string;
  invoiceNumber: string;
  supplierId: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  supplierInvoiceRef: string | null;
  /** The overall description (the notes column) — shown on the list and printed on the listing. */
  description: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  totalSen: number;
  paidSen: number;
  outstandingSen: number;
  status: string;
};

export type ApInvoiceHeader = {
  id: string; invoice_number: string; supplier_id: string; supplier_invoice_ref: string | null;
  invoice_date: string; due_date: string | null; currency: string; total_sen: number; paid_sen: number;
  status: string; notes: string | null; posted_at: string | null; posted_by: string | null;
};
export type ApInvoiceLine = { id: string; line_no: number; description: string | null; debit_account_code: string; amount_sen: number };

export const useApInvoices = (kind: ApListKind = 'ALL') => useQuery({
  queryKey: ['ap-invoices', kind],
  queryFn: () => authedFetch<{ rows: ApListRow[] }>(`/ap-invoices?kind=${kind}`),
  staleTime: 15_000,
});

export const useApInvoiceDetail = (id: string | null) => useQuery({
  queryKey: ['ap-invoice', id],
  queryFn: () => authedFetch<{ invoice: ApInvoiceHeader; lines: ApInvoiceLine[]; supplier: { id: string; code: string; name: string } | null }>(`/ap-invoices/${id}`),
  enabled: !!id,
});

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['ap-invoices'] });
  void qc.invalidateQueries({ queryKey: ['ap-invoice'] });
  void qc.invalidateQueries({ queryKey: ['ap-aging'] });
};

export type ApInvoiceLineInput = { description?: string; debitAccountCode: string; amountSen: number };

export const useCreateApInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { supplierId: string; supplierInvoiceRef?: string; invoiceDate: string; dueDate?: string | null; notes?: string; lines: ApInvoiceLineInput[] }) =>
      authedFetch<{ ok: boolean; invoice: ApInvoiceHeader }>(`/ap-invoices`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
  });
};

/** Edit — every field (owner 2026-09-06); a posted bill re-posts server-side
    (contra + fresh entry), which the reply says with `reposted`. */
export const useUpdateApInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ supplierId: string; supplierInvoiceRef: string | null; invoiceDate: string; dueDate: string | null; notes: string | null; lines: ApInvoiceLineInput[] }> }) =>
      authedFetch<{ ok: boolean; invoice: ApInvoiceHeader; reposted?: boolean; jeNo?: string }>(`/ap-invoices/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
  });
};

export const usePostApInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: boolean; jeNo: string; status: string }>(`/ap-invoices/${id}/post`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};

export const useCancelApInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: boolean }>(`/ap-invoices/${id}/cancel`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};

/* ── The bill's files (2026-09-06, owner: 附件也一起做) — the supplier's bill
   LIVES with the AP invoice as the scanned bill lives with its voucher: same
   row shape (scm.acc_ap_invoice_files), same R2 bucket, same reader; only the
   path differs. The AP Payment's print bundle appends these after the
   voucher's own files. Server: backend/src/scm/routes/ap-invoice-files.ts. */
export const useApInvoiceFiles = (invoiceId: string | null) => useQuery({
  queryKey: ['ap-invoice-files', invoiceId],
  queryFn: () => authedFetch<{ files: PvFile[] }>(`/ap-invoices/${invoiceId}/files`),
  enabled: !!invoiceId,
  retry: retryUnlessClientError,
});

export const useUploadApInvoiceFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, file }: { invoiceId: string; file: PvFilePayload }) =>
      authedFetch<{ ok: true; file: PvFile }>(`/ap-invoices/${invoiceId}/files`, {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }),
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['ap-invoice-files', vars.invoiceId] });
    },
  });
};

export const useDeleteApInvoiceFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, fileId }: { invoiceId: string; fileId: string }) =>
      authedFetch<{ ok: true }>(`/ap-invoices/${invoiceId}/files/${fileId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['ap-invoice-files', vars.invoiceId] });
    },
  });
};

export const fetchApInvoiceFileBlobUrl = (invoiceId: string, fileId: string): Promise<{ url: string; contentType: string }> =>
  fetchDocFileBlobUrl(`/ap-invoices/${invoiceId}/files/${fileId}`);
