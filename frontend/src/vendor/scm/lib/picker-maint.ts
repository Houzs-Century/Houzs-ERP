
import { normaliseTypographicQuotes } from '@2990s/shared/mfg-pricing';
import type { MaintenanceConfig } from './mfg-products-queries';

const PICKER_POOLS = ['gaps', 'divanHeights', 'legHeights', 'sofaSizes', 'sofaLegHeights'] as const;

const entryValue = (e: unknown): string =>
  typeof e === 'string' ? e : String((e as { value?: unknown } | null)?.value ?? '');

const fold = (v: string) => normaliseTypographicQuotes(v).trim();

export function withMasterPickerPools(
  pricing: MaintenanceConfig | null,
  master: MaintenanceConfig | null,
): MaintenanceConfig | null {
  if (!pricing || !master || pricing === master) return pricing ?? master;
  const out: Record<string, unknown> = { ...pricing };
  for (const key of PICKER_POOLS) {
    const masterPool = (master as Record<string, unknown>)[key];
    if (!Array.isArray(masterPool)) continue;
    const own = (pricing as Record<string, unknown>)[key];
    const known = new Set(masterPool.map((e) => fold(entryValue(e))));
    const extra = (Array.isArray(own) ? own : []).filter((e) => !known.has(fold(entryValue(e))));
    out[key] = [...masterPool, ...extra];
  }
  return out as unknown as MaintenanceConfig;
}
