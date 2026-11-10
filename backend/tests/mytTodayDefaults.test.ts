/* Three server-side "today" defaults read the Workers clock, which is UTC, so
   from 00:00 to 08:00 Malaysia time they were the day before (owner
   2026-11-10: every "today" is the Malaysian day):
   - the finance P&L opens on the current YEAR (wrong from 00:00 to 08:00 on
     1 Jan);
   - the lorry capacity dashboard opens on the current MONTH (wrong on the 1st);
   - a customer's age ticks over on their birthday (a day late before 08:00).
   Clock pinned at 00:30 / 01:30 Malaysia time. */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { lorryCapacity } from '../src/scm/routes/lorry-capacity';
import finance from '../src/routes/finance';
import { ageFromBirthday } from '../src/scm/shared/customer-demographics';

const emptyDb = {
  prepare: () => {
    const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) };
    return stmt;
  },
};

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

describe('finance P&L default year is the Malaysian year', () => {
  const app = () => {
    const a = new Hono();
    a.use('*', async (c, next) => {
      c.set('user' as never, { id: 1, permissions: ['projects.read'], permissions_set: new Set(['projects.read']) } as never);
      c.set('companyId' as never, 1 as never);
      await next();
    });
    a.route('/finance', finance);
    return a;
  };

  test('at 00:30 on 1 Jan 2027 (Malaysia) the P&L is 2027', async () => {
    vi.setSystemTime(new Date('2026-12-31T16:30:00Z'));
    const res = await app().request('/finance/pnl?scope=po', {}, { DB: emptyDb });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { year: number }).year).toBe(2027);
  });

  test('at 23:59 on 31 Dec 2026 (Malaysia) it is still 2026', async () => {
    vi.setSystemTime(new Date('2026-12-31T15:59:00Z'));
    const res = await app().request('/finance/pnl?scope=po', {}, { DB: emptyDb });
    expect(((await res.json()) as { year: number }).year).toBe(2026);
  });
});

describe('lorry capacity default range is the Malaysian month', () => {
  const app = () => {
    const sb = fakeSb({ lorries: [], trips: [], lorry_down_windows: [] });
    const a = new Hono();
    a.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, 1 as never);
      c.set('allowedCompanyIds' as never, [1] as never);
      await next();
    });
    a.route('/lorry-capacity', lorryCapacity);
    return a;
  };

  test('at 01:30 on 1 Dec (Malaysia) the range is 1 to 31 Dec', async () => {
    vi.setSystemTime(new Date('2026-11-30T17:30:00Z'));
    const res = await app().request('/lorry-capacity', {}, { DB: emptyDb });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { range: { from: string; to: string } }).range).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe("customer age ticks over on the Malaysian birthday", () => {
  test('at 01:30 on 10 Nov 2026 (Malaysia) someone born 10 Nov 1990 is 36', () => {
    vi.setSystemTime(new Date('2026-11-09T17:30:00Z'));
    expect(ageFromBirthday('1990-11-10')).toBe(36);
  });
  test('at 23:59 on 9 Nov 2026 (Malaysia) they are still 35', () => {
    vi.setSystemTime(new Date('2026-11-09T15:59:00Z'));
    expect(ageFromBirthday('1990-11-10')).toBe(35);
  });
});
