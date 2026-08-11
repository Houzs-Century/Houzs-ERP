// Fleet Module C hooks — delivery RATE CARDS + the pure cost calculator + the
// 3PL charge reconciliation (migration 0207 / route delivery-rate-cards.ts).
//
// The API emits camelCase already (the route shapes rows out); everything goes
// through authedFetch -> /api/scm/delivery-rate-cards.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type RateBasis = 'ITEM' | 'SET';
/** What the tier ladder COUNTS (mig 0244). UNIT = sets/items per `basis`;
 *  DROP = delivery orders; CUSTOMER = distinct doorstep; TRIP = 1, a flat
 *  price for the whole trip. Was 'DROP' | 'CUSTOMER' while the field was inert
 *  and the calculator counted sets regardless of it. */
export type RateAggregation = 'UNIT' | 'DROP' | 'CUSTOMER' | 'TRIP';
export type RateRounding = 'NONE' | 'NEAREST_10C' | 'NEAREST_RM';
export type RateRuleType =
  | 'POSITIONAL_TIER' | 'OVERAGE' | 'SOFA_BRACKET' | 'OUTSTATION' | 'OUTSTATION_TRIP'
  | 'DISPOSE' | 'SETUP' | 'DISMANTLE' | 'SERVICE' | 'PICKUP' | 'INSPECTION' | 'TRANSFER';

export type RateCard = {
  id: string;
  name: string;
  carrierLorryId: string | null;
  carrierCompanyId: string | null;
  carrierLabel: string | null;
  isOwnFleet: boolean;
  basis: RateBasis;
  aggregation: RateAggregation;
  minChargeCenti: number | null;
  capCenti: number | null;
  rounding: RateRounding;
  isActive: boolean;
  notes: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  ruleCount?: number;
};

export type RateRule = {
  id: string;
  cardId: string;
  ruleType: RateRuleType;
  tierPosition: number | null;
  bracketMin: number | null;
  bracketMax: number | null;
  zone: string | null;
  amountCenti: number;
  params: Record<string, unknown> | null;
  sortOrder: number;
};

export type RateCardMeta = {
  carriers: { id: string; plate: string; type: string | null; isInternal: boolean }[];
  companies: { id: string; name: string }[];
  ruleTypes: RateRuleType[];
  zones: string[];
};

export type CostLine = {
  ruleType: string;
  label: string;
  amountCenti: number;
  detail?: Record<string, unknown>;
};
export type CostBreakdown = { totalCenti: number; subtotalCenti: number; lines: CostLine[] };

export type DeliveryFacts = {
  setCount?: number | null;
  itemCount?: number | null;
  sofaCompartments?: number[] | null;
  destinationZone?: string | null;
  disposeCount?: number | null;
  setupCount?: number | null;
  dismantleCount?: number | null;
  serviceCount?: number | null;
  pickupCount?: number | null;
  inspectionCount?: number | null;
  transferCount?: number | null;
};

export type ReconcileRow = {
  tripId: string;
  tripNo: string | null;
  tripDate: string | null;
  lorryId: string | null;
  status: string | null;
  company_code?: string | null;
  cardId: string | null;
  cardName: string | null;
  matched: boolean;
  dropCount: number;
  derivedSetCount: number;
  derivedZone: string | null;
  billedCenti: number;
  expectedCenti: number | null;
  deltaCenti: number | null;
  flagged: boolean;
  factsComplete: boolean;
  breakdown: CostBreakdown | null;
};

const CARDS_KEY = ['delivery-rate-cards'] as const;

// ── Cards ────────────────────────────────────────────────────────────────────
export function useRateCards() {
  return useQuery({
    queryKey: CARDS_KEY,
    queryFn: () => authedFetch<{ cards: RateCard[] }>('/delivery-rate-cards').then((r) => r.cards),
    staleTime: 60_000,
  });
}

export function useRateCard(id: string | null) {
  return useQuery({
    queryKey: ['delivery-rate-card', id],
    enabled: !!id,
    queryFn: () => authedFetch<{ card: RateCard; rules: RateRule[] }>(`/delivery-rate-cards/${id}`),
    staleTime: 30_000,
  });
}

export function useRateCardMeta() {
  return useQuery({
    queryKey: ['delivery-rate-card-meta'],
    queryFn: () => authedFetch<RateCardMeta>('/delivery-rate-cards/meta'),
    staleTime: 300_000,
  });
}

export type NewRateCard = {
  /** Optional when carrierCompanyId is set — the server names the card after the
   *  carrier company, so the two can never disagree (mig 0237: one card each). */
  name?: string;
  carrierLorryId?: string | null;
  carrierCompanyId?: string | null;
  carrierLabel?: string | null;
  /* No isOwnFleet — it is derived from carrierCompanyId server-side and the
     route ignores it (mig 0246). Own fleet IS "no carrier". */
  basis?: RateBasis;
  aggregation?: RateAggregation;
  minChargeCenti?: number | null;
  capCenti?: number | null;
  rounding?: RateRounding;
  isActive?: boolean;
  notes?: string | null;
};

export function useCreateRateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewRateCard) => authedFetch<{ card: RateCard }>('/delivery-rate-cards', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CARDS_KEY }),
  });
}

export function useUpdateRateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewRateCard> & { id: string }) =>
      authedFetch<{ card: RateCard }>(`/delivery-rate-cards/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: CARDS_KEY });
      qc.invalidateQueries({ queryKey: ['delivery-rate-card', v.id] });
    },
  });
}

export function useDeleteRateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-rate-cards/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CARDS_KEY }),
  });
}

// ── Rules ────────────────────────────────────────────────────────────────────
export type NewRateRule = {
  ruleType: RateRuleType;
  tierPosition?: number | null;
  bracketMin?: number | null;
  bracketMax?: number | null;
  zone?: string | null;
  amountCenti: number;
  sortOrder?: number;
};

export function useCreateRateRule(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewRateRule) => authedFetch<{ rule: RateRule }>(`/delivery-rate-cards/${cardId}/rules`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
  });
}

export function useUpdateRateRule(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewRateRule> & { id: string }) =>
      authedFetch<{ rule: RateRule }>(`/delivery-rate-cards/${cardId}/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
  });
}

export function useDeleteRateRule(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-rate-cards/${cardId}/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
  });
}

// ── Compute (the pure calculator against a stored card) ──────────────────────
export function useComputeCost(cardId: string) {
  return useMutation({
    mutationFn: (facts: DeliveryFacts) =>
      authedFetch<{ card: RateCard; facts: DeliveryFacts; breakdown: CostBreakdown }>(
        `/delivery-rate-cards/${cardId}/compute`, { method: 'POST', body: JSON.stringify(facts) },
      ),
  });
}

// ── Reconciliation ───────────────────────────────────────────────────────────
export function useReconcile(opts: { from?: string; to?: string }) {
  const { from, to } = opts;
  return useQuery({
    queryKey: ['delivery-rate-reconcile', from ?? null, to ?? null],
    queryFn: () => {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const qs = p.toString();
      return authedFetch<{ rows: ReconcileRow[] }>(`/delivery-rate-cards/reconcile${qs ? `?${qs}` : ''}`).then((r) => r.rows);
    },
    staleTime: 30_000,
  });
}
