// ----------------------------------------------------------------------------
// HR / Commission data layer — the frontend half of backend/src/scm/routes/hr.ts
// (API base /api/scm/hr).
//
// Lives under vendor/scm/lib despite being new Houzs code, not a 2990 port: it
// must go through this directory's authedFetch, which is the only client that
// stamps X-Company-Id. HR refuses to answer without a resolved company (unlike
// the rest of SCM it does not degrade to "no predicate" — a commission figure
// computed against an unknown company is a guess, and this is payroll).
//
// MONEY IS INTEGER SEN (`*Centi`) and RATES ARE INTEGER BASIS POINTS (`*Bps`).
// Neither is ever arithmetic'd here — the pages divide only to render, and
// multiply back by exactly 100 with Math.round on the way in.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type HrTier = 'sales' | 'manager';
/** What one bonus rule targets. `category` covers EVERY item in a product
 *  category with a single rule; the other three each name one thing. Where both
 *  a category rule and a per-product rule cover the same item, the PRODUCT rule
 *  wins and the category rule pays nothing (backend: hr-commission.ts). */
export type HrFlagType = 'product' | 'category' | 'fabric' | 'special';
export type HrOverrideMode = 'showroom' | 'chain';

export type HrConfig = {
  baseBps: number;
  personalKpiThresholdCenti: number;
  personalKpiBonusBps: number;
  showroomKpiThresholdCenti: number;
  showroomKpiBonusBps: number;
  overrideBaseBps: number;
  overrideKpiBonusBps: number;
  overrideMode: HrOverrideMode;
  updatedAt?: string;
};

export type HrProfile = {
  id: string;
  staffId: string;
  staffName: string;
  staffCode: string;
  tier: HrTier;
  showroomId: string;
  active: boolean;
};

export type HrItemKpi = {
  id: string;
  flagType: HrFlagType;
  ref: string;
  label: string;
  bonusCenti: number;
  active: boolean;
};

export type HrPickerRef = { ref: string; label: string };

export type HrPickers = {
  staff: Array<{ id: string; name: string; staffCode: string; role: string }>;
  showrooms: Array<{ id: string; name: string }>;
  products: HrPickerRef[];
  /** The mfg_product_category enum values (SOFA / BEDFRAME / ...). */
  categories: HrPickerRef[];
  /** Fabric SERIES (fabric_library.id, e.g. 'BF') — never individual colours. */
  fabrics: HrPickerRef[];
  specials: HrPickerRef[];
};

/** One level's slice of a chain-mode override. Absent in showroom mode. */
export type HrOverrideLevelDetail = {
  level: number;
  rateBps: number;
  goodsCenti: number;
  commissionCenti: number;
};

export type HrCommissionRow = {
  staffId: string;
  staffName: string;
  tier: HrTier;
  personalGoodsCenti: number;
  personalRateBps: number;
  personalCommissionCenti: number;
  /* null in chain mode: the override there is a sum over levels of DIFFERENT
     rates on DIFFERENT bases, so there is no single rate to print. Render
     overrideDetail instead — see hr-commission.ts. */
  overrideRateBps: number | null;
  overrideCommissionCenti: number;
  overrideDetail?: HrOverrideLevelDetail[];
  itemKpiCenti: number;
  kpiDetail: Array<{ label: string; qty: number; bonusCenti: number; lineCenti: number }>;
  totalCenti: number;
};

export type HrCommissionShowroom = {
  showroomId: string;
  showroomName: string;
  showroomGoodsCenti: number;
  showroomKpiHit: boolean;
  rows: HrCommissionRow[];
};

/** A configured rung of the chain-mode override ladder (scm.hr_override_levels). */
export type HrOverrideLevel = {
  id: string;
  level: number;
  rateBps: number;
  label: string;
  active: boolean;
};

/* The ladder as the ENGINE saw it — id/label/active stripped, because only the
   level and its rate feed the maths. The report returns this shape both live
   (today's active levels) and frozen (the closed period's snapshot), so the page
   reads one type either way. */
export type HrOverrideLevelRate = { level: number; rateBps: number };

export type HrPayoutPeriod = {
  id: string;
  from: string;
  to: string;
  revision: number;
  status: string;
  engineVersion: string;
  totalCenti: number;
  rowCount: number;
  closedByName: string | null;
  closedAt: string | null;
  reopenedByName: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
};

export type HrCommissionReport = {
  from: string;
  to: string;
  config: HrConfig;
  overrideMode: HrOverrideMode;
  /* Non-null when this range has been CLOSED: the rows are frozen and served
     from the snapshot, not recomputed, so a later rate edit cannot move them. */
  closed: HrPayoutPeriod | null;
  /* The ladder these figures were computed against. On a CLOSED period this is
     the SNAPSHOT, not today's config — printing the live ladder beside frozen
     amounts would show rates that do not explain them. Empty in showroom mode. */
  overrideLevels: HrOverrideLevelRate[];
  showrooms: HrCommissionShowroom[];
};

// ── config ──────────────────────────────────────────────────────────────────

export function useHrConfig() {
  return useQuery({
    queryKey: ['hr', 'config'],
    queryFn: () => authedFetch<{ config: HrConfig }>('/hr/config').then((r) => r.config),
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export type HrConfigPatch = Partial<Omit<HrConfig, 'updatedAt'>>;

export function useUpdateHrConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: HrConfigPatch) =>
      authedFetch<{ config: HrConfig }>('/hr/config', { method: 'PATCH', body: JSON.stringify(body) }),
    // Every rate feeds the report, so the whole domain is stale, not just config.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

// ── salesperson profiles ────────────────────────────────────────────────────

export function useHrProfiles() {
  return useQuery({
    queryKey: ['hr', 'profiles'],
    queryFn: () => authedFetch<{ profiles: HrProfile[] }>('/hr/profiles').then((r) => r.profiles),
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export function useCreateHrProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { staffId: string; tier: HrTier; showroomId: string; active?: boolean }) =>
      authedFetch<{ profile: HrProfile }>('/hr/profiles', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

export function useUpdateHrProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; tier?: HrTier; showroomId?: string; active?: boolean }) =>
      authedFetch<{ profile: HrProfile }>(`/hr/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

export function useDeleteHrProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/hr/profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

// ── item KPIs ───────────────────────────────────────────────────────────────

export function useHrItemKpi() {
  return useQuery({
    queryKey: ['hr', 'item-kpi'],
    queryFn: () => authedFetch<{ items: HrItemKpi[] }>('/hr/item-kpi').then((r) => r.items),
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export function useCreateHrItemKpi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { flagType: HrFlagType; ref: string; label?: string; bonusCenti: number; active?: boolean }) =>
      authedFetch<{ item: HrItemKpi }>('/hr/item-kpi', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

export function useUpdateHrItemKpi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; label?: string; bonusCenti?: number; active?: boolean }) =>
      authedFetch<{ item: HrItemKpi }>(`/hr/item-kpi/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

export function useDeleteHrItemKpi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/hr/item-kpi/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

// ── override levels (chain mode) ────────────────────────────────────────────
// One editable rate per rung of the reporting chain: level 1 = a person's DIRECT
// reports, level 2 = their reports' reports, unbounded. The list is EMPTY until
// someone configures it, and the backend refuses to switch override_mode to
// 'chain' against an empty ladder.

export function useHrOverrideLevels() {
  return useQuery({
    queryKey: ['hr', 'override-levels'],
    queryFn: () => authedFetch<{ levels: HrOverrideLevel[] }>('/hr/override-levels').then((r) => r.levels),
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export function useCreateHrOverrideLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { level: number; rateBps: number; label?: string; active?: boolean }) =>
      authedFetch<{ level: HrOverrideLevel }>('/hr/override-levels', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

/* `level` is deliberately absent from the patch shape — the backend refuses it
   too. Renumbering a rung in place silently repoints an existing rate at a
   different set of people; delete and re-add instead. */
export function useUpdateHrOverrideLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; rateBps?: number; label?: string; active?: boolean }) =>
      authedFetch<{ level: HrOverrideLevel }>(`/hr/override-levels/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

export function useDeleteHrOverrideLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/hr/override-levels/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

// ── payout periods (close / reopen) ─────────────────────────────────────────

export function useHrPayoutPeriods() {
  return useQuery({
    queryKey: ['hr', 'payout', 'periods'],
    queryFn: () => authedFetch<{ periods: HrPayoutPeriod[] }>('/hr/payout/periods').then((r) => r.periods),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

export function useCloseHrPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      authedFetch<{ closed: HrPayoutPeriod }>('/hr/payout/close', { method: 'POST', body: JSON.stringify(body) }),
    // A close changes what /commission SERVES for that range (frozen rows
    // instead of a live recompute), so the report must be refetched, not just
    // the period list.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

export function useReopenHrPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { from: string; to: string; reason: string }) =>
      authedFetch<{ reopened: HrPayoutPeriod }>('/hr/payout/reopen', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  });
}

// ── pickers ─────────────────────────────────────────────────────────────────

export function useHrPickers() {
  return useQuery({
    queryKey: ['hr', 'pickers'],
    queryFn: () => authedFetch<HrPickers>('/hr/pickers'),
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
  });
}

// ── commission report ───────────────────────────────────────────────────────

/* The report is a heavy multi-table read, so the caller passes the APPLIED
   range (behind its Calculate button), never the live date-field state — the
   query key is the gate, and it must not move on every keystroke. */
export function useHrCommission(from: string, to: string) {
  return useQuery({
    queryKey: ['hr', 'commission', from, to],
    queryFn: () => {
      const params = new URLSearchParams({ from, to });
      return authedFetch<HrCommissionReport>(`/hr/commission?${params.toString()}`);
    },
    enabled: Boolean(from) && Boolean(to),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}
