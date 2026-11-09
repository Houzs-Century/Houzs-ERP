import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loadSoLinesOrderedSincePlan,
  parsePlanAsOf,
  soLinesOrderedSincePlan,
  type PoLineSince,
} from '../src/scm/lib/mrp-plan-freshness';

/* B6: the MRP page reads a stored plan, and an MRP convert has no qty cap on a
   pooled line, so a second "Proceed PO" on the same (stale) plan ordered the
   same goods twice. The convert now carries the plan's computedAt and is
   refused when a live PO line on those SO lines is newer than the plan. */
const PLAN = Date.parse('2026-11-09T02:00:00.000Z');
const line = (so: string, at: string, status: string | null): PoLineSince =>
  ({ so_item_id: so, created_at: at, po: status === null ? null : { status } });

describe('soLinesOrderedSincePlan', () => {
  it('names a line that got a live PO after the plan was calculated', () => {
    expect(soLinesOrderedSincePlan([line('a', '2026-11-09T02:05:00Z', 'SUBMITTED')], PLAN)).toEqual(['a']);
  });

  it('ignores POs the plan already counted, and POs that are not supply', () => {
    expect(soLinesOrderedSincePlan([
      line('a', '2026-11-09T01:59:00Z', 'SUBMITTED'),
      line('b', '2026-11-09T02:05:00Z', 'CANCELLED'),
      line('c', '2026-11-09T02:05:00Z', 'draft'),
      line('d', '2026-11-09T02:05:00Z', null),
    ], PLAN)).toEqual([]);
  });

  it('names each line once', () => {
    expect(soLinesOrderedSincePlan([
      line('a', '2026-11-09T02:05:00Z', 'SUBMITTED'),
      line('a', '2026-11-09T02:06:00Z', 'APPROVED'),
    ], PLAN)).toEqual(['a']);
  });
});

describe('parsePlanAsOf', () => {
  it('reads an ISO timestamp and skips anything else', () => {
    expect(parsePlanAsOf('2026-11-09T02:00:00.000Z')).toBe(PLAN);
    expect(parsePlanAsOf(undefined)).toBeNull();
    expect(parsePlanAsOf(null)).toBeNull();
    expect(parsePlanAsOf('')).toBeNull();
    expect(parsePlanAsOf('yesterday-ish')).toBeNull();
  });
});

describe('loadSoLinesOrderedSincePlan', () => {
  it('reads one company only, newer than the plan, and fails closed on a read error', async () => {
    const calls: Array<[string, unknown, unknown]> = [];
    const q = (result: { data: unknown; error: unknown }) => {
      const b: Record<string, unknown> = {};
      for (const m of ['from', 'select', 'order']) b[m] = () => b;
      b.eq = (col: string, v: unknown) => { calls.push(['eq', col, v]); return b; };
      b.in = (col: string, v: unknown) => { calls.push(['in', col, v]); return b; };
      b.gt = (col: string, v: unknown) => { calls.push(['gt', col, v]); return b; };
      b.range = () => Promise.resolve(result);
      return b;
    };
    const ok = q({ data: [line('a', '2026-11-09T02:05:00Z', 'SUBMITTED')], error: null });
    expect(await loadSoLinesOrderedSincePlan(ok, 2, ['a', 'a'], PLAN)).toEqual(['a']);
    expect(calls).toContainEqual(['eq', 'company_id', 2]);
    expect(calls).toContainEqual(['gt', 'created_at', '2026-11-09T02:00:00.000Z']);

    const bad = q({ data: null, error: { message: 'boom' } });
    await expect(loadSoLinesOrderedSincePlan(bad, 2, ['a'], PLAN)).rejects.toThrow(/mrp_plan_freshness_read_failed/);
  });
});

describe('POST /from-sos wiring', () => {
  const src = readFileSync(new URL('../src/scm/routes/mfg-purchase-orders.ts', import.meta.url), 'utf8');
  it('refuses a stale MRP plan and refreshes the stored plan after creating POs', () => {
    expect(src).toMatch(/loadSoLinesOrderedSincePlan\(supabase, scopeCompanyId, ids, planAsOfMs\)/);
    expect(src).toContain("error: 'mrp_plan_stale'");
    expect(src).toContain("deferMrpSnapshotRefresh(c, c.get('supabase'), coId, 'po-from-sos')");
  });

  it('releases the idempotency claim on a stale-plan refusal, so Proceed on the recalculated plan is not refused as a reused key', () => {
    const route = src.slice(src.indexOf("mfgPurchaseOrders.post('/from-sos'"));
    const handler = route.slice(0, route.indexOf('\n});') + 4);
    expect(handler).toMatch(/out\.body\.error === 'mrp_plan_stale'[\s\S]*markIdempotencyNoWrite\(c\)/);
  });
});
