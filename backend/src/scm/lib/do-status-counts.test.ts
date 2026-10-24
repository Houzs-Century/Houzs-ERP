import { afterEach, describe, expect, it } from 'vitest';
import { doListStatusCounts } from './do-status-counts';
import { DO_STATUS_BUCKETS } from './do-status-buckets';
import { fakeSb, type Row } from './fake-postgrest';
import { resetAggregateMemo } from './postgrest-aggregate';

/* HC-0002: the DO list's pills come from one read grouped by (status, on_hold)
   instead of nine head counts — an aggregate where PostgREST allows one, else
   the two columns paged in id order and grouped here. Both paths run over the
   same rows and must give the counts the nine head counts gave, key order
   included (it is the wire shape). */

const OWN_COMPANY = 1;
const inScope = (r: Row) => r.company_id === OWN_COMPANY;
const STATUSES = Object.values(DO_STATUS_BUCKETS).flat();

function rows(): Row[] {
  const out: Row[] = [];
  let n = 0;
  for (const st of STATUSES) {
    for (let i = 0; i < (st.length % 4) + 1; i += 1) {
      n += 1;
      out.push({ id: `do-${String(n).padStart(3, '0')}`, status: st, on_hold: i === 0 ? true : i === 1 ? null : false, company_id: OWN_COMPANY });
    }
  }
  out.push({ id: 'do-other-co', status: 'DRAFT', on_hold: true, company_id: OWN_COMPANY + 1 });
  return out;
}

/** The nine head counts the grouped read replaced, run against the same rows. */
async function nineCounts(table: Row[]): Promise<Record<string, number>> {
  const sb = fakeSb({ delivery_orders: table });
  const head = () => sb.from('delivery_orders').select('*', { count: 'exact', head: true }).eq('company_id', OWN_COMPANY);
  const out: Record<string, number> = {
    all: (await head()).count as number,
    on_hold: (await head().eq('on_hold', true)).count as number,
  };
  for (const [b, members] of Object.entries(DO_STATUS_BUCKETS)) out[b] = (await head().in('status', members)).count as number;
  return out;
}

/** The aggregate as PostgREST answers `status, on_hold, cnt:id.count()`: one row per group. */
function grouped(table: Row[]) {
  const g = new Map<string, { status: string | null; on_hold: boolean | null; cnt: number }>();
  for (const r of table.filter(inScope)) {
    const k = `${r.status}|${r.on_hold}`;
    const cur = g.get(k) ?? { status: r.status, on_hold: r.on_hold, cnt: 0 };
    cur.cnt += 1;
    g.set(k, cur);
  }
  return [...g.values()];
}

type Mode = 'aggregate' | 'aggregates-off';

function baseOver(table: Row[], mode: Mode) {
  const sb = fakeSb({ delivery_orders: table });
  const calls: string[] = [];
  const base = (sel: string) => {
    calls.push(sel);
    if (sel.includes('.count()')) {
      return Promise.resolve(mode === 'aggregate'
        ? { data: grouped(table), error: null }
        : { data: null, error: { code: 'PGRST123', message: 'Use of aggregate functions is not allowed' } });
    }
    const q = sb.from('delivery_orders').select(sel).eq('company_id', OWN_COMPANY);
    let ordered = false;
    const guard = {
      order: (col: string, o?: unknown) => { ordered = true; q.order(col, o as never); return guard; },
      range: (from: number, to: number) => {
        if (!ordered) throw new Error('range() without order(): unordered pages repeat and skip rows');
        return q.range(from, to);
      },
    };
    return guard;
  };
  return { base, calls };
}

afterEach(() => resetAggregateMemo());

describe('doListStatusCounts', () => {
  it('the aggregate and the paged fallback both give exactly the nine counts', async () => {
    const t = rows();
    const expected = await nineCounts(t);
    const viaAgg = await doListStatusCounts(baseOver(t, 'aggregate').base);
    resetAggregateMemo();
    const viaRows = await doListStatusCounts(baseOver(t, 'aggregates-off').base);
    expect(viaAgg).toEqual({ ok: true, counts: expected });
    expect(viaRows).toEqual({ ok: true, counts: expected });
    if (!viaAgg.ok || !viaRows.ok) return;
    expect(Object.keys(viaRows.counts)).toEqual(['all', 'on_hold', ...Object.keys(DO_STATUS_BUCKETS)]);
    expect(viaRows.counts.all).toBe(t.filter(inScope).length);
    expect(viaRows.counts.delivered).toBe(t.filter((r) => inScope(r) && (r.status === 'SIGNED' || r.status === 'DELIVERED')).length);
  });

  it('after a PGRST123 the next open skips the aggregate request', async () => {
    const t = rows();
    const first = baseOver(t, 'aggregates-off');
    await doListStatusCounts(first.base);
    expect(first.calls.filter((c) => c.includes('.count()'))).toHaveLength(1);
    const second = baseOver(t, 'aggregates-off');
    const res = await doListStatusCounts(second.base);
    expect(second.calls.filter((c) => c.includes('.count()'))).toHaveLength(0);
    expect(res).toEqual({ ok: true, counts: await nineCounts(t) });
  });

  it('an empty scope answers zeros, not a failure', async () => {
    const res = await doListStatusCounts(baseOver([], 'aggregates-off').base);
    expect(res).toEqual({ ok: true, counts: { all: 0, on_hold: 0, ...Object.fromEntries(Object.keys(DO_STATUS_BUCKETS).map((b) => [b, 0])) } });
  });

  it('a fallback read that fails is reported, never served as 0', async () => {
    const failing = (sel: string) => {
      if (sel.includes('.count()')) return Promise.resolve({ data: null, error: { code: 'PGRST123', message: 'off' } });
      const q = { order: () => q, range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) };
      return q;
    };
    expect(await doListStatusCounts(failing)).toEqual({ ok: false, reason: 'status counts failed: aggregate off; fallback boom' });
  });
});
