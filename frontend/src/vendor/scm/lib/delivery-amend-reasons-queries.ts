
// Owner-managed amend / postpone reason list (owner 2026-11-27). Backed by
// scm.delivery_amend_reasons (route /delivery-amend-reasons). The board's Amend
// Reason column and the Set-job-date drawer read the ACTIVE labels for their
// dropdown via useAmendReasonOptions; the admin editor (Coverage & Fleet tab)
// reads every row via useDeliveryAmendReasons and creates / edits / deletes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { AMEND_REASONS } from './delivery-planning-queries';

export type AmendReasonRow = {
  id: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type NewAmendReason = {
  label: string;
  sortOrder?: number;
  isActive?: boolean;
};

export type AmendReasonPatch = Partial<NewAmendReason> & { id: string };

const REASONS_KEY = ['delivery-amend-reasons'] as const;

export function useDeliveryAmendReasons() {
  return useQuery({
    queryKey: REASONS_KEY,
    queryFn: () =>
      authedFetch<{ reasons: AmendReasonRow[] }>('/delivery-amend-reasons')
        .then((r) => r.reasons),
    staleTime: 60_000,
  });
}

export function useCreateDeliveryAmendReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewAmendReason) =>
      authedFetch<{ reason: AmendReasonRow }>('/delivery-amend-reasons', {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: REASONS_KEY }),
  });
}

export function useUpdateDeliveryAmendReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: AmendReasonPatch) =>
      authedFetch<{ reason: AmendReasonRow }>(`/delivery-amend-reasons/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: REASONS_KEY }),
    onError: writeFailed,
  });
}

export function useDeleteDeliveryAmendReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/delivery-amend-reasons/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: REASONS_KEY }),
  });
}

/** Active reason labels, sorted for the dropdown (sort_order, then label). Pure,
    so the ordering is unit-testable without react-query. */
export function pickActiveReasonLabels(rows: readonly AmendReasonRow[]): string[] {
  return rows
    .filter((r) => r.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map((r) => r.label);
}

/** The reason options for the pickers: the managed ACTIVE labels for the active
    company. Falls back to the hardcoded AMEND_REASONS only while the list is
    loading or the fetch failed — once the managed list has loaded, it is the
    single source of truth, so a removed reason stays removed (an empty list is
    respected, never re-seeded from the constant). */
export function useAmendReasonOptions(): readonly string[] {
  const q = useDeliveryAmendReasons();
  return q.data ? pickActiveReasonLabels(q.data) : AMEND_REASONS;
}
