// Delivery Residence Rules CONFIG hooks — the owner-maintained per-residence /
// building-type delivery rules (migration 0196 / route
// delivery-residence-rules.ts). Each building type (Condo / Landed / Apartment /
// Office / Shop / Other) carries a service duration (minutes) and optional
// delivery-access rules (no-delivery time windows, service-lift booking, gated-
// community registration). The Phase 3 scheduler will read this; this slice is
// the admin config CRUD only.
//
// The API emits camelCase already (the route shapes rows out); everything goes
// through authedFetch → /api/scm.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type ResidenceRuleRow = {
  id: string;
  buildingType: string;
  serviceDurationMinutes: number;
  earliestDeliveryTime: string | null; // HH:MM, or null (no restriction)
  latestDeliveryTime: string | null;   // HH:MM, or null (no restriction)
  requiresLiftBooking: boolean;
  requiresRegistration: boolean;
  notes: string | null;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type NewResidenceRule = {
  buildingType: string;
  serviceDurationMinutes?: number;
  earliestDeliveryTime?: string | null;
  latestDeliveryTime?: string | null;
  requiresLiftBooking?: boolean;
  requiresRegistration?: boolean;
  notes?: string | null;
  isActive?: boolean;
};

export type ResidenceRulePatch = Partial<NewResidenceRule> & { id: string };

const RULES_KEY = ['delivery-residence-rules'] as const;

export function useDeliveryResidenceRules() {
  return useQuery({
    queryKey: RULES_KEY,
    queryFn: () =>
      authedFetch<{ rules: ResidenceRuleRow[] }>('/delivery-residence-rules')
        .then((r) => r.rules),
    staleTime: 60_000,
  });
}

export function useCreateDeliveryResidenceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewResidenceRule) =>
      authedFetch<{ rule: ResidenceRuleRow }>('/delivery-residence-rules', {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });
}

export function useUpdateDeliveryResidenceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ResidenceRulePatch) =>
      authedFetch<{ rule: ResidenceRuleRow }>(`/delivery-residence-rules/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
    onError: writeFailed,
  });
}

export function useDeleteDeliveryResidenceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/delivery-residence-rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });
}

/* ── Duration presentation helpers — store minutes, show hours. ───────────── */

/** Minutes → a compact hours label: 90 -> "1.5h", 60 -> "1h", 45 -> "45m". */
export function durationLabel(mins: number): string {
  const m = Number.isFinite(mins) ? Math.max(0, Math.round(mins)) : 0;
  if (m === 0) return '0m';
  if (m % 60 === 0) return `${m / 60}h`;
  if (m < 60) return `${m}m`;
  // Round the hours to at most 2 decimals, trimming trailing zeros (90 -> 1.5).
  const hours = Math.round((m / 60) * 100) / 100;
  return `${hours}h`;
}

/** Parse an hours input (e.g. "1.5") to whole minutes. Returns null when blank
    or not a finite non-negative number, so the caller can reject it. */
export function hoursToMinutes(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours < 0) return null;
  return Math.round(hours * 60);
}

/** Minutes → an hours string for an editable input: 90 -> "1.5", 60 -> "1". */
export function minutesToHours(mins: number): string {
  const m = Number.isFinite(mins) ? Math.max(0, Math.round(mins)) : 0;
  const hours = Math.round((m / 60) * 100) / 100;
  return String(hours);
}
