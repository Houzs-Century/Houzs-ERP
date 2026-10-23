import { describe, expect, it } from 'vitest';
import { doListStatusCounts } from './do-status-counts';
import { DO_STATUS_BUCKETS } from './do-status-buckets';
import { fakeSb, type Row } from './fake-postgrest';

/* HC-0002: the DO list's pills come from one aggregate grouped by (status,
   on_hold) instead of nine head counts. Both paths run over the same rows here
   and must give the same counts, key order included (it is the wire shape). */

const OWN_COMPANY = 1;
const inScope = (r: Row) => r.company_id === OWN_COMPANY;

const STATUSES = Object.values(DO_STATUS_BUCKETS).flat();

function rows(): Row[] {
  const out: Row[] = [];
  let n = 0;
  for (const st of STATUSES) {
    for (let i = 0; i < (st.length % 4) + 1; i += 1) {
      out.push({ id: `do-${n += 1}`, status: st, on_hold: i === 0 ? true : i === 1 ? null : false, company_id: 1 });
    }
  }
  out.push({ id: 'do-other-co', status: 'DRAFT', on_hold: true, company_id: 2 });
  return out;
}

/** The aggregate as PostgREST answers `status, on_hold, cnt:id.count()`: one row per group. */
function grouped(table: Row[], companyId: number) {
  const g = new Map<string, { status: string | null; on_hold: boolean | null; cnt: number }>();
  for (const r of table.filter((x) => x.company_id === companyId)) {
    const k = `${r.status}|${r.on_hold}`;
    const cur = g.get(k) ?? { status: r.status, on_hold: r.on_hold, cnt: 0 };
    cur.cnt += 1;
    g.set(k, cur);
  }
  return [...g.values()];
}

function baseOver(table: Row[], aggregate: 'ok' | 'fails') {
  const sb = fakeSb({ delivery_orders: table });
  return (sel: string, opts?: { count: 'exact'; head: true }) => {
    if (sel.includes('.count()')) {
      return Promise.resolve(aggregate === 'ok'
        ? { data: grouped(table, 1), error: null }
        : { data: null, error: { message: 'aggregates disabled' } });
    }
    return sb.from('delivery_orders').select(sel, opts).eq('company_id', 1);
  };
}

describe('doListStatusCounts', () => {
  it('the grouped read gives exactly the nine counts it replaced', async () => {
    const t = rows();
    const grouped = await doListStatusCounts(baseOver(t, 'ok'));
    const counted = await doListStatusCounts(baseOver(t, 'fails'));
    expect(grouped.ok && counted.ok).toBe(true);
    if (!grouped.ok || !counted.ok) return;
    expect(Object.keys(grouped.counts)).toEqual(['all', 'on_hold', ...Object.keys(DO_STATUS_BUCKETS)]);
    expect(JSON.stringify(grouped.counts)).toBe(JSON.stringify(counted.counts));
    expect(grouped.counts.all).toBe(t.filter(inScope).length);
    expect(grouped.counts.delivered).toBe(t.filter((r) => inScope(r) && (r.status === 'SIGNED' || r.status === 'DELIVERED')).length);
    expect(grouped.counts.on_hold).toBe(t.filter((r) => inScope(r) && r.on_hold === true).length);
  });

  it('an empty scope answers zeros, not a failure', async () => {
    const res = await doListStatusCounts(baseOver([], 'ok'));
    expect(res).toEqual({ ok: true, counts: { all: 0, on_hold: 0, ...Object.fromEntries(Object.keys(DO_STATUS_BUCKETS).map((b) => [b, 0])) } });
  });

  it('a failed fallback count is reported, never served as 0', async () => {
    const res = await doListStatusCounts(() => {
      const q = { eq: () => q, in: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(ok) };
      return q;
    });
    expect(res).toEqual({ ok: false, reason: 'all count failed: boom' });
  });
});
