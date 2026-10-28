// Vendored VERBATIM (minus the unused supabase import) from
// apps/backend/src/lib/so-dropdown-options-queries.ts — DB-backed SO dropdowns
// (customer type / building type / relationship / payment method cascade /
// venue). authedFetch-based already; the FALLBACK_OPTIONS keep the selects
// populated even before the API resolves (and when /api/scm/so-dropdown-options
// isn't mounted yet — flag for backend confirm).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type SoDropdownCategory =
  | 'customer_type'
  | 'building_type'
  | 'relationship'
  | 'payment_method'
  | 'payment_merchant'
  | 'online_type'
  | 'installment_plan'
  | 'venue';

export type SoDropdownOption = {
  id:        string;
  category:  SoDropdownCategory;
  value:     string;
  label:     string;
  sortOrder: number;
  active:    boolean;
};

const STALE = 30 * 60 * 1000;

type GroupedOptions = Record<SoDropdownCategory, SoDropdownOption[]>;

/* HOUZS VENDOR PERF DEVIATION (perf/so-waterfall, 2026-07-17 — keep when
   re-syncing this file from 2990).

   WHY: every SO/DO/CN/SI form calls useSoDropdownOptions once PER DROPDOWN, and
   the hook used to fetch one category per call — so opening a Sales Order fired
   3 requests for the header selects and 4 more from PaymentsTable, 7 round trips
   for one small, stable picklist table. The owner's capture (2026-07-17) shows
   three of them side by side, each taking 13.4s under load.

   The grouped endpoint already returned every category in ONE response and had
   NO callers. So the fix is transport-only: ONE shared query, and each hook
   select()s its own category out of it. React Query dedupes on the shared key,
   so all 7 collapse into a single request that the whole page (and the next
   page) reuses. No call site changes; desktop and mobile converge together
   because both already route through this hook. */
function useGroupedSoDropdownOptions<T>(select: (all: GroupedOptions) => T) {
  return useQuery({
    // The ['so-dropdown-options'] prefix is load-bearing: the CRUD mutations
    // below invalidate on it, and must keep reaching this query.
    queryKey: ['so-dropdown-options', 'all', 'active'],
    staleTime: STALE,
    queryFn: () =>
      authedFetch<{ options: GroupedOptions }>('/so-dropdown-options').then((r) => r.options),
    select,
  });
}

export function useSoDropdownOptions(category: SoDropdownCategory) {
  /* No `?? []` on the lookup: an absent category means the response did not
     answer for it, which is NOT "this picklist is empty". Leave it undefined and
     let optionsOrFallback below make that call — it is the one place that owns
     the empty-vs-fallback decision, and it already treats a not-yet-loaded query
     the same way. */
  return useGroupedSoDropdownOptions((all) => all[category]);
}

/* Every category INCLUDING deactivated rows — the Maintenance page, which has to
   show an inactive option to flip it back on. Kept on its own cache key so it can
   never serve those rows to an order form's dropdown. */
export function useAllSoDropdownOptions() {
  return useQuery({
    queryKey: ['so-dropdown-options', 'all', 'with-inactive'],
    staleTime: STALE,
    queryFn: () =>
      authedFetch<{ options: GroupedOptions }>(
        '/so-dropdown-options?includeInactive=1',
      ).then((r) => r.options),
  });
}

const invalidateAll = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['so-dropdown-options'] });
};

export function useCreateSoDropdownOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      category:  SoDropdownCategory;
      value:     string;
      label:     string;
      sortOrder?: number;
      active?:   boolean;
    }) =>
      authedFetch<{ option: SoDropdownOption }>('/so-dropdown-options', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateSoDropdownOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: {
      id:        string;
      value?:    string;
      label?:    string;
      sortOrder?: number;
      active?:   boolean;
    }) =>
      authedFetch<{ option: SoDropdownOption }>(`/so-dropdown-options/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteSoDropdownOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/so-dropdown-options/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateAll(qc),
  });
}

export const FALLBACK_OPTIONS: Record<SoDropdownCategory, SoDropdownOption[]> = {
  customer_type: [
    { id: 'fallback-ct-new',  category: 'customer_type', value: 'NEW',      label: 'New customer',      sortOrder: 1, active: true },
    { id: 'fallback-ct-exi',  category: 'customer_type', value: 'EXISTING', label: 'Existing customer', sortOrder: 2, active: true },
  ],
  building_type: [
    { id: 'fallback-bt-condo',     category: 'building_type', value: 'Condo',     label: 'Condo',     sortOrder: 1, active: true },
    { id: 'fallback-bt-landed',    category: 'building_type', value: 'Landed',    label: 'Landed',    sortOrder: 2, active: true },
    { id: 'fallback-bt-apartment', category: 'building_type', value: 'Apartment', label: 'Apartment', sortOrder: 3, active: true },
    { id: 'fallback-bt-office',    category: 'building_type', value: 'Office',    label: 'Office',    sortOrder: 4, active: true },
    { id: 'fallback-bt-shop',      category: 'building_type', value: 'Shop',      label: 'Shop',      sortOrder: 5, active: true },
    { id: 'fallback-bt-other',     category: 'building_type', value: 'Other',     label: 'Other',     sortOrder: 6, active: true },
  ],
  relationship: [
    { id: 'fallback-rel-spouse',    category: 'relationship', value: 'Spouse',    label: 'Spouse',    sortOrder: 1, active: true },
    { id: 'fallback-rel-parent',    category: 'relationship', value: 'Parent',    label: 'Parent',    sortOrder: 2, active: true },
    { id: 'fallback-rel-child',     category: 'relationship', value: 'Child',     label: 'Child',     sortOrder: 3, active: true },
    { id: 'fallback-rel-sibling',   category: 'relationship', value: 'Sibling',   label: 'Sibling',   sortOrder: 4, active: true },
    { id: 'fallback-rel-relative',  category: 'relationship', value: 'Relative',  label: 'Relative',  sortOrder: 5, active: true },
    { id: 'fallback-rel-friend',    category: 'relationship', value: 'Friend',    label: 'Friend',    sortOrder: 6, active: true },
    { id: 'fallback-rel-colleague', category: 'relationship', value: 'Colleague', label: 'Colleague', sortOrder: 7, active: true },
    { id: 'fallback-rel-other',     category: 'relationship', value: 'Other',     label: 'Other',     sortOrder: 8, active: true },
  ],
  /* THREE, not four. Mig 0037 DEACTIVATED the L1 'Installment' row — an EPP
     receipt is Method = Merchant plus an installment_plan tenure — so the API
     serves three. This list is what every surface shows while that API is
     loading or empty, and it offered a fourth, retired method the operator
     could pick and save. The row itself still exists (deactivated) and stays
     locked by PAYMENT_METHOD_CORE_VALUES, which is why that list is still four:
     the lock is about what may be DELETED, this is about what may be CHOSEN.
     Pinned against the migration by so-dropdown-options-queries.test.ts. */
  payment_method: [
    { id: 'fallback-pm-merchant',    category: 'payment_method', value: 'Merchant',    label: 'Merchant',                sortOrder: 1, active: true },
    { id: 'fallback-pm-online',      category: 'payment_method', value: 'Online',      label: 'Bank transfer / DuitNow', sortOrder: 2, active: true },
    { id: 'fallback-pm-cash',        category: 'payment_method', value: 'Cash',        label: 'Cash',                    sortOrder: 3, active: true },
  ],
  /* The twelve banks mig 0037 seeds, in ITS sort order. This list held nine and
     was missing Pinelabs / AEON / HSBC — all three appear on real receipts, and
     an operator on a cold load simply could not choose them. Pinned against the
     migration by so-dropdown-options-queries.test.ts. */
  payment_merchant: [
    { id: 'fallback-pmer-mbb',        category: 'payment_merchant', value: 'MBB',        label: 'MBB',         sortOrder: 1,  active: true },
    { id: 'fallback-pmer-cimb',       category: 'payment_merchant', value: 'CIMB',       label: 'CIMB',        sortOrder: 2,  active: true },
    { id: 'fallback-pmer-public',     category: 'payment_merchant', value: 'Public',     label: 'Public',      sortOrder: 3,  active: true },
    { id: 'fallback-pmer-hlb',        category: 'payment_merchant', value: 'HLB',        label: 'HLB',         sortOrder: 4,  active: true },
    { id: 'fallback-pmer-alliance',   category: 'payment_merchant', value: 'Alliance',   label: 'Alliance',    sortOrder: 5,  active: true },
    { id: 'fallback-pmer-pinelabs',   category: 'payment_merchant', value: 'Pinelabs',   label: 'Pinelabs',    sortOrder: 6,  active: true },
    { id: 'fallback-pmer-rhb',        category: 'payment_merchant', value: 'RHB',        label: 'RHB',         sortOrder: 7,  active: true },
    { id: 'fallback-pmer-bankislam',  category: 'payment_merchant', value: 'Bank Islam', label: 'Bank Islam',  sortOrder: 8,  active: true },
    { id: 'fallback-pmer-bsn',        category: 'payment_merchant', value: 'BSN',        label: 'BSN',         sortOrder: 9,  active: true },
    { id: 'fallback-pmer-ambank',     category: 'payment_merchant', value: 'AmBank',     label: 'AmBank',      sortOrder: 10, active: true },
    { id: 'fallback-pmer-aeon',       category: 'payment_merchant', value: 'AEON',       label: 'AEON',        sortOrder: 11, active: true },
    { id: 'fallback-pmer-hsbc',       category: 'payment_merchant', value: 'HSBC',       label: 'HSBC',        sortOrder: 12, active: true },
  ],
  online_type: [
    { id: 'fallback-ot-banktransfer', category: 'online_type', value: 'Bank Transfer', label: 'Bank Transfer', sortOrder: 1, active: true },
    { id: 'fallback-ot-tng',          category: 'online_type', value: 'TNG',           label: 'TNG',           sortOrder: 2, active: true },
    { id: 'fallback-ot-cheque',       category: 'online_type', value: 'Cheque',        label: 'Cheque',        sortOrder: 3, active: true },
    { id: 'fallback-ot-duitnow',      category: 'online_type', value: 'DuitNow',       label: 'DuitNow',       sortOrder: 4, active: true },
  ],
  installment_plan: [
    { id: 'fallback-ip-oneoff', category: 'installment_plan', value: 'One-off',    label: 'One-off',    sortOrder: 1, active: true },
    { id: 'fallback-ip-3m',     category: 'installment_plan', value: '3 months',   label: '3 months',   sortOrder: 2, active: true },
    { id: 'fallback-ip-6m',     category: 'installment_plan', value: '6 months',   label: '6 months',   sortOrder: 3, active: true },
    { id: 'fallback-ip-12m',    category: 'installment_plan', value: '12 months',  label: '12 months',  sortOrder: 4, active: true },
    { id: 'fallback-ip-24m',    category: 'installment_plan', value: '24 months',  label: '24 months',  sortOrder: 5, active: true },
    { id: 'fallback-ip-36m',    category: 'installment_plan', value: '36 months',  label: '36 months',  sortOrder: 6, active: true },
  ],
  venue: [],
};

export function optionsOrFallback(
  category: SoDropdownCategory,
  data: SoDropdownOption[] | undefined,
): SoDropdownOption[] {
  if (!data || data.length === 0) return FALLBACK_OPTIONS[category];
  return data;
}

/* HOUZS ADDITION (not in the 2990 original — keep when re-syncing this file).
   The Customer Type default for a NEW SO, owned in ONE place so desktop
   (SalesOrderNew) and mobile (MobileNewSO) can never drift apart. Owner
   2026-07-16: "customer type default new customer".

   Resolves against the LIVE so_dropdown_options catalog rather than asserting a
   literal 'NEW' — the option list is maintenance-editable, so we match the real
   row whose label reads "New Customer" (case-insensitively) and fall back to the
   first option when the catalog has no such row. Never fabricates a value. */
export function preferredCustomerTypeValue(opts: SoDropdownOption[]): string {
  const preferred =
    opts.find((o) => o.label.trim().toLowerCase() === 'new customer') ?? opts[0];
  return preferred?.value ?? '';
}
