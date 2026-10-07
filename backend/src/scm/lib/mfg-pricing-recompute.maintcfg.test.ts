import { describe, it, expect } from 'vitest';
import { loadMaintenanceConfig } from './mfg-pricing-recompute';
import { todayMyt } from './my-time';

// loadMaintenanceConfig must pick the same row as GET /maintenance-config/resolved:
// newest effective_from <= today (a future-dated change must not price early),
// latest created_at winning a same-day tie.

function recordingSb(row: unknown) {
  const calls: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'lte', 'order', 'limit']) {
    chain[m] = (...args: unknown[]) => { calls.push([m, ...args]); return chain; };
  }
  chain.maybeSingle = async () => ({ data: row, error: null });
  return { sb: { from: () => chain }, calls };
}

describe('loadMaintenanceConfig', () => {
  it('ignores future-dated rows and tie-breaks same-day saves by latest save', async () => {
    const { sb, calls } = recordingSb({ config: { gaps: [] } });
    const cfg = await loadMaintenanceConfig(sb);
    expect(cfg).toEqual({ gaps: [] });
    expect(calls).toContainEqual(['lte', 'effective_from', todayMyt()]);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
  });
});
