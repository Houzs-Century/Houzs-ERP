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
  id: string;
  invoiceNumber: string;
  /** The party as the filter groups it: `C:<debtor code>` for a customer, `D:<debtor id>` for an other debtor. */
  partyKey: string;
  partyCode: string | null;
  partyName: string | null;
  /** The other debtor's registry id (a bill); null on a sales invoice. */
  debtorId: string | null;
  /** The sales order behind a sales invoice; a bill has none. */
  ref: string | null;
  description: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  totalSen: number;
  /** What settles the document: an invoice's own receipts PLUS the order's deposit applied; a bill's money received. */
  paidSen: number;
  /** The slice of the order's deposit applied to a sales invoice (0 on a bill). */
  depositAppliedSen: number;
  outstandingSen: number;
  status: string;
};

export const useArInvoices = (kind: ArListKind = 'ALL') => useQuery({
  queryKey: ['ar-invoices', kind],
  queryFn: () => authedFetch<{ rows: ArListRow[] }>(`/ar-invoices?kind=${kind}`),
  staleTime: 15_000,
});

/** A debtor bill with its lines and its debtor (the registry row the printed
    invoice's BILL TO reads) — the pop-out over the list. */
export type ArBillDetail = { bill: DebtorBill; debtor: OtherDebtor | null };

export const useArBillDetail = (id: string | null) => useQuery({
  queryKey: ['ar-bill', id],
  queryFn: () => authedFetch<ArBillDetail>(`/ar-invoices/bills/${id}`),
  enabled: !!id,
});
