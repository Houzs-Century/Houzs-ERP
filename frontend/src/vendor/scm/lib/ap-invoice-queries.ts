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
/** A supplier's debit note is an AP invoice of its own kind (owner 2026-10-28): it raises what we owe. */
export type ApDocKind = 'INV' | 'DN';

/** One row of the Finance list — a purchase invoice (read-only mirror) or an
    AP invoice raised here; `kind` says which. */
export type ApListRow = {
  kind: 'API' | 'PI';
  /** 'DN' for a supplier's debit note (series {co}SDN-); every other row 'INV'. */
  docKind?: ApDocKind;
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
  /** The control the bill sits on, by the supplier code (the server's rule): AP = 400, AP_OTHER = 405. */
  controlRole?: 'AP' | 'AP_OTHER';
  controlCode?: string;
  /** A purchase invoice held in Procurement — every voucher path refuses it. */
  held?: boolean;
  holdReason?: string | null;
  /** When Finance plans to pay it (step 7) — beside the due date, never instead of it. */
  plannedOn?: string | null;
};

export type ApInvoiceHeader = {
  id: string; invoice_number: string; supplier_id: string; supplier_invoice_ref: string | null;
  invoice_date: string; due_date: string | null; currency: string; total_sen: number; paid_sen: number;
  status: string; notes: string | null; posted_at: string | null; posted_by: string | null;
  /** 欠正式单 (item 3): booked on a proforma — OWED, RECEIVED (to check), CHECKED. */
  official_doc?: string | null; official_doc_note?: string | null;
  doc_kind?: ApDocKind;
  /** Who raised and who cancelled it, and when — the bill page's trail. */
  created_at?: string | null; created_by?: string | null; cancelled_at?: string | null; cancelled_by?: string | null;
  /** The journal its post wrote (the live one when an edit re-posted it); null until posted. */
  je_no?: string | null;
  /** When Finance plans to pay it (step 7); null = by its due date. */
  planned_on?: string | null;
};

/** What paid a bill (the bill page's Payments): a voucher by its stage — its own
    payment or an advance knocked off onto the bill — or a supplier credit note. */
export type BillPayment = { kind: 'PV' | 'SCN'; id: string; number: string; date: string | null; stage: string; amountSen: number; fromAdvance: boolean };
export type ApInvoiceDetail = {
  invoice: ApInvoiceHeader; lines: ApInvoiceLine[]; supplier: { id: string; code: string; name: string } | null;
  payments?: BillPayment[];
  /** The control the bill credits, by the supplier code (the server's rule). */
  controlCode?: string;
};
/** project_id: the event the line's money is for (owner 2026-09-30, 5a). */
export type ApInvoiceLine = { id: string; line_no: number; description: string | null; debit_account_code: string; amount_sen: number; project_id?: number | null };

/** docKind: 'DN' lists the supplier debit notes alone (the CN / DN page's tab). */
export const useApInvoices = (kind: ApListKind = 'ALL', docKind?: ApDocKind) => useQuery({
  queryKey: ['ap-invoices', kind, docKind ?? 'any'],
  queryFn: () => authedFetch<{ rows: ApListRow[] }>(`/ap-invoices?kind=${kind}${docKind ? `&docKind=${docKind}` : ''}`),
  staleTime: 15_000,
});

/** A supplier bill number booked on more than one live invoice of the same
    supplier (server: routes/ap-duplicate-bills.ts). Read-only; Finance cancels
    the wrong copy on its own page. */
export type DuplicateBillSettlement = { kind: 'PV' | 'CN'; id: string; number: string; status: string; amountSen: number };
export type DuplicateBillCopy = {
  id: string; invoiceNumber: string; supplierInvoiceRef: string | null; invoiceDate: string | null;
  currency: string; totalSen: number; paidSen: number; status: string; settlements: DuplicateBillSettlement[];
};
export type DuplicateBillGroup = {
  kind: 'API' | 'PI'; docKind: ApDocKind; supplierId: string; supplierCode: string | null; supplierName: string | null;
  billKey: string; paidMoreThanOnce: boolean; copies: DuplicateBillCopy[];
};

export const useDuplicateSupplierBills = () => useQuery({
  queryKey: ['ap-invoices', 'duplicate-bills'],
  queryFn: () => authedFetch<{ groups: DuplicateBillGroup[] }>('/ap-invoices/duplicate-bills'),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** Plan a bill's payment date, or clear the plan (null) — an AP bill or a purchase invoice; posts nothing. */
export const usePlanBill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { kind: 'API' | 'PI'; id: string; plannedOn: string | null }) =>
      authedFetch<{ ok: boolean; plannedOn: string | null }>('/ap-invoices/plans', { method: 'PUT', body: JSON.stringify(b) }),
    onSuccess: () => invalidate(qc),
  });
};

export const useApInvoiceDetail = (id: string | null) => useQuery({
  queryKey: ['ap-invoice', id],
  queryFn: () => authedFetch<ApInvoiceDetail>(`/ap-invoices/${id}`),
  enabled: !!id,
});

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['ap-invoices'] });
  void qc.invalidateQueries({ queryKey: ['ap-invoice'] });
  void qc.invalidateQueries({ queryKey: ['ap-aging'] });
  /* A bill entered, changed or cancelled is (or stops being) another's same bill. */
  void qc.invalidateQueries({ queryKey: ['payment-request-bill-matches'] });
  /* …and answers (or, cancelled, re-opens) a request on Finance's waiting count. */
  void qc.invalidateQueries({ queryKey: ['payment-requests'] });
  /* …and moves what To do raises (bills due, drafts). */
  void qc.invalidateQueries({ queryKey: ['finance-todo'] });
};

export type ApInvoiceLineInput = { description?: string; debitAccountCode: string; amountSen: number; projectId?: number };

export const useCreateApInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    /* paymentRequestId: the 申请付款 this bill answers (owner 2026-09-30, 6.1) —
       the server claims it and copies its files on (requestFilesCopied). */
    mutationFn: (body: { supplierId: string; supplierInvoiceRef?: string; invoiceDate: string; dueDate?: string | null; notes?: string; lines: ApInvoiceLineInput[]; paymentRequestId?: string; docKind?: ApDocKind }) =>
      authedFetch<{ ok: boolean; invoice: ApInvoiceHeader; requestFilesCopied?: number }>(`/ap-invoices`, { method: 'POST', body: JSON.stringify(body) }),
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
  queryFn: () => authedFetch<{ files: PvFile[]; locked?: boolean }>(`/ap-invoices/${invoiceId}/files`),
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
