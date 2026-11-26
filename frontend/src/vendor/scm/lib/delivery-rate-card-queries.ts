
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type RateBasis = 'ITEM' | 'SET';
/** What the tier ladder COUNTS (mig 0244). UNIT = sets/items per `basis`;
 *  DROP = delivery orders; CUSTOMER = distinct doorstep; TRIP = 1, a flat
 *  price for the whole trip. Was 'DROP' | 'CUSTOMER' while the field was inert
 *  and the calculator counted sets regardless of it. */
export type RateAggregation = 'UNIT' | 'DROP' | 'CUSTOMER' | 'TRIP';
export type RateRounding = 'NONE' | 'NEAREST_10C' | 'NEAREST_RM';
export type RateRuleType =
  | 'POSITIONAL_TIER' | 'OVERAGE' | 'SOFA_BRACKET' | 'OUTSTATION' | 'OUTSTATION_TRIP'
  | 'DISPOSE' | 'SETUP' | 'DISMANTLE' | 'SERVICE' | 'PICKUP' | 'INSPECTION' | 'SUPPLIER_PICKUP' | 'TRANSFER'
  | 'DO_CHARGE';

export type RateCard = {
  id: string;
  name: string;
  carrierLorryId: string | null;
  carrierCompanyId: string | null;
  carrierLabel: string | null;
  isOwnFleet: boolean;
  basis: RateBasis;
  aggregation: RateAggregation;
  minChargeSen: number | null;
  capSen: number | null;
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
  amountSen: number;
  params: Record<string, unknown> | null;
  appliesTo?: string[] | null;
  label?: string | null;
  bps?: number | null;
  sortOrder: number;
  areaId?: string | null;
};

/** One area of a card (mig 20261111T1000): a name and the towns it covers.
 *  A delivery whose address names one of its towns is priced with the area's
 *  own prices (rules whose areaId is this area) instead of the card's. */
export type RateArea = {
  id: string;
  cardId: string;
  name: string;
  towns: string[];
  sortOrder: number;
};

export type RateCardMeta = {
  carriers: { id: string; plate: string; type: string | null; isInternal: boolean }[];
  companies: { id: string; name: string; supplier?: { code: string | null; name: string } | null }[];
  ruleTypes: RateRuleType[];
  zones: string[];
};

export type CostLine = {
  ruleType: string;
  label: string;
  amountSen: number;
  detail?: Record<string, unknown>;
};
/** area: the area the delivery was priced in, or null for the card's own prices. */
export type CostBreakdown = { totalSen: number; subtotalSen: number; lines: CostLine[]; area?: { id: string; name: string } | null };

export type DeliveryFacts = {
  setCount?: number | null;
  itemCount?: number | null;
  sofaCompartments?: number[] | null;
  destinationZone?: string | null;
  areaId?: string | null;
  jobType?: string | null;
  goodsValueSen?: number | null;
  dropCount?: number | null;
  disposeCount?: number | null;
  setupCount?: number | null;
  dismantleCount?: number | null;
  serviceCount?: number | null;
  pickupCount?: number | null;
  inspectionCount?: number | null;
  supplierPickupCount?: number | null;
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
  billedSen: number;
  expectedSen: number | null;
  deltaSen: number | null;
  flagged: boolean;
  factsComplete: boolean;
  breakdown: CostBreakdown | null;
};

const CARDS_KEY = ['delivery-rate-cards'] as const;

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
    queryFn: () => authedFetch<{ card: RateCard; rules: RateRule[]; areas?: RateArea[] }>(`/delivery-rate-cards/${id}`),
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
  name?: string;
  carrierLorryId?: string | null;
  carrierCompanyId?: string | null;
  carrierLabel?: string | null;
  basis?: RateBasis;
  aggregation?: RateAggregation;
  minChargeSen?: number | null;
  capSen?: number | null;
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

export type NewRateRule = {
  ruleType: RateRuleType;
  tierPosition?: number | null;
  bracketMin?: number | null;
  bracketMax?: number | null;
  zone?: string | null;
  amountSen: number;
  sortOrder?: number;
  areaId?: string | null;
  appliesTo?: string[] | null;
  label?: string | null;
  bps?: number | null;
};

export function useCreateRateRule(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewRateRule) => authedFetch<{ rule: RateRule }>(`/delivery-rate-cards/${cardId}/rules`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
      qc.invalidateQueries({ queryKey: CARDS_KEY }),
    ]),
  });
}

export function useUpdateRateRule(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewRateRule> & { id: string }) =>
      authedFetch<{ rule: RateRule }>(`/delivery-rate-cards/${cardId}/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
      qc.invalidateQueries({ queryKey: CARDS_KEY }),
    ]),
    onError: writeFailed,
  });
}

export function useDeleteRateRule(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-rate-cards/${cardId}/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
      qc.invalidateQueries({ queryKey: CARDS_KEY }),
    ]),
  });
}

export type NewRateArea = { name: string; towns: string[]; sortOrder?: number };

const refreshCard = (qc: ReturnType<typeof useQueryClient>, cardId: string) => Promise.all([
  qc.invalidateQueries({ queryKey: ['delivery-rate-card', cardId] }),
  qc.invalidateQueries({ queryKey: CARDS_KEY }),
]);

export function useUpdateRateArea(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewRateArea> & { id: string }) =>
      authedFetch<{ area: RateArea }>(`/delivery-rate-cards/areas/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => refreshCard(qc, cardId),
  });
}

export function useDeleteRateArea(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/delivery-rate-cards/areas/${id}`, { method: 'DELETE' }),
    onSuccess: () => refreshCard(qc, cardId),
  });
}

/** Adds an area, then its prices one after another, and refreshes the card at
 *  the end — also when a price fails, so whatever was saved shows. */
export function useAddAreaWithPrices(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ area, prices }: { area: NewRateArea; prices: Omit<NewRateRule, 'areaId'>[] }) => {
      const { area: saved } = await authedFetch<{ area: RateArea }>(`/delivery-rate-cards/${cardId}/areas`, { method: 'POST', body: JSON.stringify(area) });
      try {
        for (const p of prices) {
          await authedFetch<{ rule: RateRule }>(`/delivery-rate-cards/${cardId}/rules`, { method: 'POST', body: JSON.stringify({ ...p, areaId: saved.id }) });
        }
      } finally {
        await refreshCard(qc, cardId);
      }
      return saved;
    },
  });
}

export function useComputeCost(cardId: string) {
  return useMutation({
    mutationFn: (facts: DeliveryFacts) =>
      authedFetch<{ card: RateCard; facts: DeliveryFacts; breakdown: CostBreakdown }>(
        `/delivery-rate-cards/${cardId}/compute`, { method: 'POST', body: JSON.stringify(facts) },
      ),
      onError: writeFailed,
  });
}

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

/** One lorry's day (a trip), priced once by the own fleet card. */
export type OwnFleetRun = {
  key: string;
  runDate: string;
  lorryId: string | null;
  plate: string;
  tripNos: string[];
  dos: { doId: string; doNumber: string | null; companyCode: string | null }[];
  setCount: number;
  zones: string[];
  jobs: Partial<Record<string, number>>;
  cardName: string | null;
  costSen: number | null;
  otherJobsSen: number | null;
  lines: { label: string; amountSen: number }[];
};

export type OwnFleetMonth = {
  month: string;
  trips: number;
  dos: number;
  sets: number;
  pricedTrips: number;
  pricedDos: number;
  costSen: number;
  deliveryCostSen: number;
  threePlDos: number;
  threePlSets: number;
  threePlBilledSen: number;
  threePlPricedDos: number;
  threePlBilledPricedSen: number;
  threePlCardSen: number;
};

export type OwnFleetCosts = {
  from: string;
  to: string;
  card: { id: string; name: string } | null;
  severalCards: { id: string; name: string }[];
  lorryCards: { id: string; name: string; lorryId: string | null }[];
  runs: OwnFleetRun[];
  months: OwnFleetMonth[];
};

export function useOwnFleetCosts(range: { from: string; to: string }) {
  const { from, to } = range;
  return useQuery({
    queryKey: [...CARDS_KEY, 'own-fleet', from, to],
    queryFn: () => authedFetch<OwnFleetCosts>(`/delivery-rate-cards/own-fleet?${new URLSearchParams({ from, to }).toString()}`),
    enabled: !!from && !!to,
    staleTime: 30_000,
  });
}
