// ----------------------------------------------------------------------------
// ar-invoice-queries — the Finance list of the money owed TO the company:
// sales invoices (a read-only mirror of the Sales side's own) BESIDE the other-
// debtor bills, the AP Invoices list's twin (owner 2026-09-29: 可以把 sales
// invoice 和 other debtor bill 做一个类似 ap invoice 这样让我 finance 这边看两个
// 一起吗). Server half: backend/src/scm/routes/ar-invoices.ts (reads only —
// a bill is raised, edited and cancelled through the other-debtor hooks in
// accounting-queries.ts, which invalidate this list too).
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import type { DebtorBill, OtherDebtor } from './accounting-queries';

export type ArListKind = 'ALL' | 'SI' | 'ODB';

/** One row of the Finance list — a sales invoice (read-only mirror) or an
    other-debtor bill raised on the AR Invoices page; `kind` says which. */
export type ArListRow = {
  kind: 'SI' | 'ODB';
  docKind?: 'INV' | 'DN';
  id: string;
  invoiceNumber: string;
  partyKey: string;
  partyCode: string | null;
  partyName: string | null;
  debtorId: string | null;
  ref: string | null;
  description: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  totalSen: number;
  paidSen: number;
  depositAppliedSen: number;
  creditNotesSen?: number;
  outstandingSen: number;
  status: string;
};

/** docKind: 'DN' lists the other debtors' debit notes alone (the CN / DN page's tab). */
export const useArInvoices = (kind: ArListKind = 'ALL', docKind?: 'INV' | 'DN') => useQuery({
  queryKey: ['ar-invoices', kind, docKind ?? 'any'],
  queryFn: () => authedFetch<{ rows: ArListRow[] }>(`/ar-invoices?kind=${kind}${docKind ? `&docKind=${docKind}` : ''}`),
  staleTime: 15_000,
});

/** A debtor bill with its lines and its debtor (the registry row the printed
    invoice's BILL TO reads) — the pop-out over the list. */
export type ArBillDetail = {
  bill: DebtorBill; debtor: OtherDebtor | null;
  receipts?: Array<{ id: string; number: string; date: string | null; status: string; submittedAt: string | null; checkedAt: string | null; approvedAt: string | null; amountSen: number }>;
  creditNotes?: Array<{ id: string; number: string; date: string | null; status: string; reason: string | null; amountSen: number; appliedSen: number }>;
};

/** A credit note on a sales invoice: one knocked off it, or one that closed its
    order's deposit invoice at this final invoice (`closesDeposit` — the
    deposit lowers the invoice, the note is not counted again). */
export type SalesInvoiceCreditNote = { id: string; number: string; date: string | null; what: string; amountSen: number; closesDeposit: boolean };

/** The sales invoice page's Credit notes (GET /ar-invoices/sales/:id/credit-notes). */
export const useSalesInvoiceCreditNotes = (siId: string | null) => useQuery({
  queryKey: ['ar-invoices', 'si-credit-notes', siId],
  queryFn: () => authedFetch<{ creditNotes: SalesInvoiceCreditNote[] }>(`/ar-invoices/sales/${encodeURIComponent(siId ?? '')}/credit-notes`),
  enabled: !!siId,
});

export const useArBillDetail = (id: string | null) => useQuery({
  queryKey: ['ar-bill', id],
  queryFn: () => authedFetch<ArBillDetail>(`/ar-invoices/bills/${id}`),
  enabled: !!id,
});
