import { canonicalizeMyState } from './canonical-state';
import { scopeToCompany } from './companyScope';
import { warehouseLabel } from './warehouse-label';

export const senOrZero = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

export const deriveCountryFromState = async (
  sb: any,
  state: string | null | undefined,
): Promise<string | null> => {
  if (!state) return null;
  /* Mig 0175 (owner 2026-07-22) — canonicalize BEFORE the my_localities lookup
     so "PENANG" or "Penang" both resolve to "Pulau Pinang" and the lookup
     returns Malaysia cleanly. The 2026-05-28 tolerant fallback below is kept
     as a second safety net (a genuinely unknown foreign state name should
     still not leave Country blank when the caller obviously typed something),
     but with canonicalization in front it should almost never fire. */
  const probe = canonicalizeMyState(state) ?? state;
  const { data } = await sb
    .from('my_localities')
    .select('country')
    .eq('state', probe)
    .limit(1)
    .maybeSingle();
  const country = (data as { country?: string } | null)?.country;
  return country ?? 'Malaysia';
};

export const deriveSalesLocationFromState = async (
  sb: any,
  state: string | null | undefined,
  c: any,
): Promise<string | null> => {
  if (!state) return null;
  const key = state === 'Wilayah Persekutuan Kuala Lumpur' ? 'Kuala Lumpur' : state;
  const { data: m } = await scopeToCompany(
    sb
      .from('state_warehouse_mappings')
      .select('warehouse_id')
      .eq('state', key),
    c,
  ).maybeSingle();
  const whId = (m as { warehouse_id?: string } | null)?.warehouse_id;
  if (!whId) return null;
  const { data: w } = await sb
    .from('warehouses')
    .select('name, code')
    .eq('id', whId)
    .maybeSingle();
  const wh = w as { name?: string; code?: string } | null;
  return warehouseLabel(wh);
};

export const snapshotUnitCostSen = async (
  sb: any,
  itemCode: string,
  explicit: number,
  c: any,
): Promise<number> => {
  if (explicit > 0) return senOrZero(explicit);
  if (!itemCode) return 0;
  const { data } = await scopeToCompany(
    sb
      .from('mfg_products')
      .select('cost_price_sen')
      .eq('code', itemCode),
    c,
  ).maybeSingle();
  return senOrZero((data as { cost_price_sen?: number } | null)?.cost_price_sen ?? 0);
};
