import { describe, it, expect } from 'vitest';
import {
  fairRequiredProblem,
  keyerFairDefaultFor,
  loadKeyerFairs,
  resolveFairForCreate,
  type FairDb,
} from './fair-binding';

/* The SQL half of the keyer's fair (owner 2026-10-19). The rule itself is pinned
 * in fair-options.test.ts; these pin what the loaders ASK the database — the
 * keyer link (PIC or Sales Attending), the live-fair guard, the company
 * predicate — and that every failure degrades to "nothing", never to a guess or
 * a blocked sale. */

type Row = Record<string, unknown>;
type Call = { sql: string; binds: unknown[] };

/** Answers each query by the first matching pattern; records every call. */
function fakeDb(answers: Array<[RegExp, Row[] | Error]>): FairDb & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              calls.push({ sql, binds });
              const hit = answers.find(([re]) => re.test(sql));
              const answer = hit ? hit[1] : [];
              if (answer instanceof Error) throw answer;
              return { results: answer as unknown as T[] };
            },
          };
        },
      };
    },
  };
}

const project = (o: Row): Row => ({
  venue: 'MID VALLEY', organizer: 'REX', brand: 'AKEMI',
  startdate: '2026-10-17', enddate: '2026-10-20', status: 'confirmed', eventtype: 'exhibition', ...o,
});

const CO = ' AND p.company_id = 1';

describe('loadKeyerFairs — the fairs the KEYER stands at', () => {
  it('asks for live fairs started by the order date, PIC or Sales Attending, in this company', async () => {
    const db = fakeDb([[/FROM projects p/, [project({ id: 2320 })]]]);
    const rows = await loadKeyerFairs(db, CO, 57, '2026-10-19');
    expect(rows.map((r) => r.projectId)).toEqual([2320]);
    const { sql, binds } = db.calls[0]!;
    expect(sql).toContain('p.archived_at IS NULL');
    expect(sql).toContain("lower(coalesce(p.status, '')) <> 'cancelled'");
    expect(sql).toContain('p.start_date <= ?');
    expect(sql).toContain('p.pic_id = ?');
    expect(sql).toMatch(/project_sales_attendees psa\s+JOIN sales_reps sr ON sr.id = psa.sales_rep_id/);
    expect(sql.trimEnd().endsWith(CO.trim())).toBe(true);
    expect(binds).toEqual(['2026-10-19', 57, 57]);
  });
});

describe('keyerFairDefaultFor — best-effort, never a guess', () => {
  it('fills in the fair running today', async () => {
    const db = fakeDb([[/FROM projects p/, [project({ id: 2320 })]]]);
    const d = await keyerFairDefaultFor({ db, companySql: CO, userId: 57, orderDate: '2026-10-19' });
    expect(d).toMatchObject({ how: 'ongoing', why: null, event: { venue: 'MID VALLEY', organizer: 'REX', projectIds: [2320] } });
  });

  it('an unknown keyer or a failed read: nothing to fill in and no reason to give', async () => {
    const none = { event: null, how: null, why: null };
    expect(await keyerFairDefaultFor({ db: fakeDb([]), companySql: CO, userId: NaN, orderDate: '2026-10-19' })).toEqual(none);
    const broken = fakeDb([[/FROM projects p/, new Error('down')]]);
    expect(await keyerFairDefaultFor({ db: broken, companySql: CO, userId: 57, orderDate: '2026-10-19' })).toEqual(none);
  });
});

describe('resolveFairForCreate — the brand first, then the keyer\'s own booth', () => {
  const EVENT = { venue: 'MID VALLEY', organizer: 'REX', picked: { startDate: '2026-10-17', endDate: '2026-10-20' } };
  const BOOTHS: Row[] = [project({ id: 340, brand: 'AKEMI' }), project({ id: 341, brand: 'ZANOTTI' })];

  it('a BEDFRAME order at an event with no BEDFRAME booth goes to the keyer\'s booth', async () => {
    const db = fakeDb([[/p\.id IN \(/, [{ id: 341 }]], [/FROM projects p/, BOOTHS]]);
    const r = await resolveFairForCreate({ db, companySql: CO, ...EVENT, soDate: '2026-10-19', brand: 'BEDFRAME', keyerId: 57 });
    expect(r).toEqual({ projectId: 341, match: 'PICKED', candidateIds: [340, 341] });
    const keyerCall = db.calls.find((c) => /p\.id IN \(/.test(c.sql))!;
    expect(keyerCall.binds).toEqual([340, 341, 57, 57]);
    expect(keyerCall.sql).toContain(CO.trim());
  });

  it("the brand's own booth needs no keyer at all", async () => {
    const db = fakeDb([[/p\.id IN \(/, [{ id: 341 }]], [/FROM projects p/, BOOTHS]]);
    const r = await resolveFairForCreate({ db, companySql: CO, ...EVENT, soDate: '2026-10-19', brand: 'AKEMI', keyerId: 57 });
    expect(r.projectId).toBe(340);
  });

  it("not knowing where the keyer stands keeps the plain answer, it does not drop it", async () => {
    const db = fakeDb([[/p\.id IN \(/, new Error('down')], [/FROM projects p/, BOOTHS]]);
    const r = await resolveFairForCreate({ db, companySql: CO, ...EVENT, soDate: '2026-10-19', brand: 'BEDFRAME', keyerId: 57 });
    expect(r.match).toBe('UNMATCHED');
  });

  it('no venue, or an unreadable projects table: PENDING, as resolveFairForSave', async () => {
    const r1 = await resolveFairForCreate({ db: fakeDb([]), companySql: CO, ...EVENT, venue: ' ', soDate: '2026-10-19', brand: 'AKEMI', keyerId: 57 });
    expect(r1).toEqual({ projectId: null, match: 'PENDING', candidateIds: [] });
    const broken = fakeDb([[/FROM projects p/, new Error('down')]]);
    const r2 = await resolveFairForCreate({ db: broken, companySql: CO, ...EVENT, soDate: '2026-10-19', brand: 'AKEMI', keyerId: 57 });
    expect(r2.match).toBe('PENDING');
  });
});

describe('fairRequiredProblem — a typed Houzs order names a fair or No fair (owner 2026-10-19)', () => {
  const base = { db: fakeDb([]), companySql: CO, keyerId: 57, orderDate: '2026-10-19' };

  it('refuses with the reason the keyer got no fair', async () => {
    const p = await fairRequiredProblem({ ...base, companyCode: 'HOUZS', body: {} });
    expect(p).toEqual({
      code: 'fair_required',
      field: 'Fair',
      message: 'No fair found for you: you are not on Sales Attending for any fair in PMS. Pick a fair yourself, or ask the person in charge to add you.',
    });
  });

  it('names the last fair when it ended over a month ago', async () => {
    const db = fakeDb([[/FROM projects p/, [project({ id: 2228, venue: 'SUNWAY CARNIVAL MALL', startdate: '2026-08-01', enddate: '2026-08-03' })]]]);
    const p = await fairRequiredProblem({ ...base, db, companyCode: 'HOUZS', body: {} });
    expect(p?.message).toContain('your last fair (SUNWAY CARNIVAL MALL, 08/01 - 08/03) ended over a month ago');
  });

  it('a picked fair or the No fair tick passes; 2990 is not on this rule', async () => {
    expect(await fairRequiredProblem({ ...base, companyCode: 'HOUZS', body: { fairOrganizer: 'REX' } })).toBeNull();
    expect(await fairRequiredProblem({ ...base, companyCode: 'HOUZS', body: { noFair: true } })).toBeNull();
    expect(await fairRequiredProblem({ ...base, companyCode: '2990', body: {} })).toBeNull();
  });

  it('a blank organizer is no fair; a keyer who HAS a fair but sent none gets the standing sentence', async () => {
    const db = fakeDb([[/FROM projects p/, [project({ id: 2320 })]]]);
    const p = await fairRequiredProblem({ ...base, db, companyCode: 'HOUZS', body: { fairOrganizer: '  ' } });
    expect(p?.message).toBe('Pick the Fair, or mark it No fair (showroom).');
  });
});
