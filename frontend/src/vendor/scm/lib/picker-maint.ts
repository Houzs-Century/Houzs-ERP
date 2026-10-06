// Variant-picker pools for a purchasing document (PO / PI / Purchase
// Consignment Order).
//
// A supplier-scope maintenance config is a COST overlay: it records what that
// supplier charges per option. It is resolved as a whole snapshot (no merge with
// master), so reading the dropdown options from it froze them at whatever master
// held the day the overlay was saved. BUG-60 (Sim 2026-10-06): 2990's Home's
// HOOKKA INDUSTRIES overlay dates from 2026-05-29 with sizes 24-35 and legs
// No Leg/4"/6"/1", so the DEFAULT size + leg added to master on 2026-10-05 could
// not be picked on a Purchase Consignment Order.
//
// Which options EXIST is master's call; the overlay only prices them. So the
// picker pools are master's (active flags included) plus any value only the
// overlay lists, and cost lookups keep reading the overlay itself.

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
