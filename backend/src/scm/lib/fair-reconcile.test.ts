import { describe, it, expect, vi, beforeEach } from 'vitest';

/* The nightly second pass at linking an order to its fair. It exists because an
 * exhibition is often not in the system when the order is written — 23% of
 * Houzs Century's fairs reached PMS within a week of opening and 13 of 114 only
 * after they had started (Jun-Sep 2026).
 *
 * What matters here is what it REFUSES to do: it never revisits a settled order,
 * never writes a project it could not resolve, and never writes without the
 * company predicate on the UPDATE as well as the read — nothing re-checks
 * between two PostgREST round trips, and a scoped-read-then-open-update has
 * already shipped across this system once.
 */

type Row = Record<string, unknown>;

let PENDING: Row[] = [];
let PROJECTS: Row[] = [];
const updates: Array<{ patch: Row; eq: Record<string, unknown> }> = [];
let selectFilter: Record<string, unknown> = {};

function fakeSb() {
  return {
    from() {
      const eqs: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, val: unknown) { eqs[col] = val; return chain; },
        in() { return chain; },
        order() { return chain; },
        limit() { selectFilter = { ...eqs }; return Promise.resolve({ data: PENDING, error: null }); },
        update(patch: Row) {
          const upd: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              eqs[col] = val;
              return upd as unknown as PromiseLike<{ error: null }> & typeof upd;
            },
            then(res: (v: { error: null }) => unknown) {
              updates.push({ patch, eq: { ...eqs } });
              return Promise.resolve(res({ error: null }));
            },
          };
          return upd;
        },
      };
      return chain;
    },
  };
}

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => fakeSb() }));

import { reconcilePendingFairs } from './fair-reconcile';

/** Stands in for env.DB. Returns whatever PROJECTS holds, filtered the way the
 *  real SQL filters: venue, period, and the company predicate. */
const fakeDb = {
  prepare(sql: string) {
    return {
      bind(...vals: unknown[]) {
        return {
          all<T>() {
            const [venue, date] = vals as string[];
            const company = /company_id = (\d+)/.exec(sql)?.[1];
            const results = PROJECTS.filter(
              (p) =>
                String(p.venue).toLowerCase() === String(venue).toLowerCase() &&
                String(p.startdate) <= date &&
                (!p.enddate || String(p.enddate) >= date) &&
                (!company || String(p.company_id) === company),
            );
            return Promise.resolve({ results: results as T[] });
          },
        };
      },
    };
  },
};

/* Only `DB` is ever touched — the supabase half is mocked above — so the cast is
   to the real Env rather than a looser shape that would let a future field slip
   in untyped. */
const env = { DB: fakeDb } as unknown as Parameters<typeof reconcilePendingFairs>[0];

const project = (o: Row): Row => ({
  id: 340, venue: 'MID VALLEY', organizer: 'REX', brand: 'AKEMI',
  startdate: '2026-09-11', enddate: '2026-09-13', status: 'confirmed', company_id: 1,
  ...o,
});

beforeEach(() => {
  PENDING = [];
  PROJECTS = [];
  updates.length = 0;
  selectFilter = {};
});

describe('reconcilePendingFairs', () => {
  it('reads ONLY orders still marked PENDING — a settled order is never revisited', async () => {
    await reconcilePendingFairs(env);
    expect(selectFilter.fair_match).toBe('PENDING');
  });

  it('links an order once the fair finally exists, scoping the WRITE too', async () => {
    PENDING = [{ doc_no: 'HC-SO-1', so_date: '2026-09-13', venue: 'MID VALLEY', branding: 'AKEMI', company_id: 1 }];
    PROJECTS = [project({ id: 340, brand: 'AKEMI' }), project({ id: 341, brand: 'ZANOTTI' })];
    const r = await reconcilePendingFairs(env);
    expect(r).toMatchObject({ scanned: 1, linked: 1, stillPending: 0, needsAPerson: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ project_id: 340, fair_match: 'PICKED' });
    expect(updates[0].eq).toMatchObject({ doc_no: 'HC-SO-1', company_id: 1 });
  });

  it('leaves an order PENDING and writes NOTHING while the fair still does not exist', async () => {
    PENDING = [{ doc_no: 'HC-SO-2', so_date: '2026-09-20', venue: 'MID VALLEY', branding: 'AKEMI', company_id: 1 }];
    PROJECTS = [project({})];
    const r = await reconcilePendingFairs(env);
    expect(r).toMatchObject({ stillPending: 1, linked: 0 });
    expect(updates).toHaveLength(0);
  });

  it('hands a brandless order at a multi-booth fair to a person, not to a guess', async () => {
    PENDING = [{ doc_no: 'HC-SO-3', so_date: '2026-09-13', venue: 'MID VALLEY', branding: null, company_id: 1 }];
    PROJECTS = [project({ id: 340, brand: 'AKEMI' }), project({ id: 341, brand: 'ZANOTTI' })];
    const r = await reconcilePendingFairs(env);
    expect(r).toMatchObject({ linked: 0, needsAPerson: 1 });
    expect(updates[0].patch).toEqual({ fair_match: 'AMBIGUOUS' });
    expect(updates[0].patch).not.toHaveProperty('project_id');
  });

  it('marks UNMATCHED when the order sells a brand with no booth there', async () => {
    PENDING = [{ doc_no: 'HC-SO-4', so_date: '2026-09-13', venue: 'MID VALLEY', branding: 'DUNLOPILLO', company_id: 1 }];
    PROJECTS = [project({ id: 340, brand: 'AKEMI' })];
    const r = await reconcilePendingFairs(env);
    expect(r).toMatchObject({ needsAPerson: 1 });
    expect(updates[0].patch).toEqual({ fair_match: 'UNMATCHED' });
  });

  it('never reads another company’s fairs', async () => {
    /* The row's own company_id is the whole tenant boundary in a cron: there is
       no active-company context to fall back on. */
    PENDING = [{ doc_no: 'HC-SO-5', so_date: '2026-09-13', venue: 'MID VALLEY', branding: 'AKEMI', company_id: 1 }];
    PROJECTS = [project({ id: 999, brand: 'AKEMI', company_id: 2 })];
    const r = await reconcilePendingFairs(env);
    expect(r).toMatchObject({ stillPending: 1, linked: 0 });
    expect(updates).toHaveLength(0);
  });

  it('skips a row it cannot resolve rather than counting it as looked at', async () => {
    PENDING = [
      { doc_no: 'HC-SO-6', so_date: '2026-09-13', venue: '', branding: 'AKEMI', company_id: 1 },
      { doc_no: null, so_date: '2026-09-13', venue: 'MID VALLEY', branding: 'AKEMI', company_id: 1 },
      { doc_no: 'HC-SO-7', so_date: null, venue: 'MID VALLEY', branding: 'AKEMI', company_id: 1 },
    ];
    const r = await reconcilePendingFairs(env);
    expect(r).toMatchObject({ scanned: 3, skipped: 3, linked: 0 });
    expect(updates).toHaveLength(0);
  });
});
