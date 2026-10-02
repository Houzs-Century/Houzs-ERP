// ----------------------------------------------------------------------------
// supplier-maintenance-queries — Finance's own supplier list (owner 2026-10-02:
// A1 Finance › Money out › Supplier Maintenance; A2a a supplier Finance opens is
// Finance's alone; A3a the supplier's bank, which a payment carries).
// Server: backend/src/scm/routes/supplier-maintenance.ts (the list and one
// supplier) — reads only; a supplier is opened and changed through /suppliers.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { SupplierRow } from './suppliers-queries';

export type SupplierMaintenanceRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  paymentTerms: string | null;
  /** TRADE posts to the AP control (400-0000), OTHER to other creditors (405-0000). */
  controlKind: 'TRADE' | 'OTHER';
  controlCode: string;
  /* The Finance part — absent for a caller who is not Finance. */
  tinNumber?: string | null;
  businessRegNo?: string | null;
  registrationNo?: string | null;
  missingTax?: boolean;
  bankName?: string | null;
  bankAccountNo?: string | null;
  bankAccountName?: string | null;
  forPurchasing?: boolean;
  /** What the books say is owed to the supplier (credit less debit on its AP lines). */
  owedSen: number;
  advanceSen: number;
  creditSen: number;
  openInvoices: number;
  openSen: number;
  /** Purchase invoices brought over from AutoCount — open, never booked here. */
  preErpSen: number;
};

export type SupplierOpenInvoice = {
  kind: 'PI' | 'API';
  id: string;
  number: string;
  supplierRef: string | null;
  date: string | null;
  dueDate: string | null;
  currency: string;
  totalSen: number;
  outstandingSen: number;
  outstandingMyrSen: number;
  status: string;
  preErp: boolean;
};

export type SupplierMaintenanceDetail = {
  supplier: SupplierRow;
  finance: boolean;
  controlCode: string;
  balanceSen: number;
  openInvoices: SupplierOpenInvoice[];
  advances: Array<{ pvId: string; pvNumber: string; date: string; leftSen: number }>;
  credits: Array<{ id: string; noteNumber: string; date: string | null; leftSen: number }>;
  payments: Array<{ id: string; pvNumber: string | null; date: string | null; purpose: string; status: string; totalSen: number; totalMyrSen: number }>;
};

export const useSupplierMaintenance = () => useQuery({
  queryKey: ['supplier-maintenance'],
  queryFn: () => authedFetch<{ rows: SupplierMaintenanceRow[]; finance: boolean; controls: { trade: string; other: string } }>('/supplier-maintenance'),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSupplierMaintenanceDetail = (id: string | null) => useQuery({
  queryKey: ['supplier-maintenance', 'detail', id],
  queryFn: () => authedFetch<SupplierMaintenanceDetail>(`/supplier-maintenance/${id}`),
  enabled: Boolean(id),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** The body a Supplier Maintenance save sends — /suppliers' create and update
    keys. Finance's form, so the Finance part rides along. */
export type SupplierMaintenanceBody = {
  code?: string;
  name?: string;
  status?: string;
  currency?: string;
  paymentTerms?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  tinNumber?: string | null;
  businessRegNo?: string | null;
  registrationNo?: string | null;
  exemptionNo?: string | null;
  creditLimitSen?: number;
  statementType?: string;
  agingBasis?: string;
  bankName?: string | null;
  bankAccountNo?: string | null;
  bankAccountName?: string | null;
  forPurchasing?: boolean;
};

const refreshSuppliers = (qc: ReturnType<typeof useQueryClient>, id?: string) => {
  void qc.invalidateQueries({ queryKey: ['supplier-maintenance'] });
  void qc.invalidateQueries({ queryKey: ['suppliers'] });
  if (id) void qc.invalidateQueries({ queryKey: ['supplier-detail', id] });
};

export const useCreateMaintainedSupplier = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SupplierMaintenanceBody) =>
      authedFetch<{ supplier: SupplierRow }>('/suppliers', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res) => refreshSuppliers(qc, res.supplier.id),
    onError: writeFailedAs('Supplier not saved'),
  });
};

export const useUpdateMaintainedSupplier = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SupplierMaintenanceBody & { id: string }) =>
      authedFetch<{ supplier: SupplierRow }>(`/suppliers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_res, vars) => refreshSuppliers(qc, vars.id),
    onError: writeFailedAs('Supplier not saved'),
  });
};

/** The supplier's bank in one line — what a payment carries. Null when none is kept. */
export function supplierBankLine(s: { bank_name?: string | null; bank_account_no?: string | null; bank_account_name?: string | null } | null | undefined): string | null {
  if (!s) return null;
  const parts = [s.bank_name, s.bank_account_no, s.bank_account_name].map((v) => String(v ?? '').trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
