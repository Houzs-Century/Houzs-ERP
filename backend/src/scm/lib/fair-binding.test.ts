import { describe, it, expect } from 'vitest';
import {
  fairConfirmProblems,
  fairLinkOnCreate,
  fairRequiredProblem,
  keyerFairDefaultFor,
  loadKeyerFairs,
  resolveFairForCreate,
  resolveScanFair,
  type FairConfirmSb,
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

/* ── Scanned orders (owner 2026-10-19) ─────────────────────────────────────────
   「先优先匹配上地点和日期和他站的场。如果没有就地点和日期，没有就他今天站的场，
   再没有就他最近站的场」. The query shapes, most specific first. */
const AT_PLACE_ON_DAY = /lower\(trim\(p\.venue\)\) = lower\(trim\(\?\)\)\s+AND p\.start_date <= \?/;
const KEYER_AMONG = /p\.id IN \(/;
const EVENT_BOOTHS = /p\.start_date = \?/;
const KEYER_FAIRS = /p\.pic_id = \?/;
const BOOTH_BY_ID = /WHERE p\.id = \?/;
const USER_NAME = /FROM users u/;

const REX = (id: number, brand: string) =>
  project({ id, brand, organizer: 'REX', startdate: '2026-10-15', enddate: '2026-10-18' });
const scanArgs = { companySql: CO, keyerId: 57, slipVenue: 'MID VALLEY', slipDate: '2026-10-16', keyedDate: '2026-10-19' };

describe('resolveScanFair — slip place and date first, the keyer\'s fair after', () => {
  it('1. a fair at the slip place on the slip date that the keyer stands at: the brand\'s booth, Fair Day = slip date', async () => {
    const db = fakeDb([[KEYER_AMONG, [{ id: 341 }]], [AT_PLACE_ON_DAY, [REX(340, 'AKEMI'), REX(341, 'DUNLOPILLO')]]]);
    const r = await resolveScanFair({ db, ...scanArgs, brand: 'AKEMI' });
    expect(r).toMatchObject({ projectId: 340, match: 'PICKED', step: 'slip_mine', fairDate: '2026-10-16', venue: 'MID VALLEY' });
    const day = db.calls.find((c) => AT_PLACE_ON_DAY.test(c.sql))!;
    expect(day.binds).toEqual(['MID VALLEY', '2026-10-16', '2026-10-16']);
  });

  it('1. stays inside the keyer\'s event: no brand booth there means the keyer\'s own booth, not another organizer\'s', async () => {
    const MLE_ZANOTTI = project({ id: 350, brand: 'ZANOTTI', organizer: 'MLE', startdate: '2026-10-16', enddate: '2026-10-16' });
    const db = fakeDb([[KEYER_AMONG, [{ id: 341 }]], [AT_PLACE_ON_DAY, [REX(340, 'AKEMI'), REX(341, 'DUNLOPILLO'), MLE_ZANOTTI]]]);
    const r = await resolveScanFair({ db, ...scanArgs, brand: 'ZANOTTI' });
    expect(r).toMatchObject({ projectId: 341, step: 'slip_mine' });
  });

  it('2. a fair there that day the keyer is not on: linked all the same (Confirm waits for PMS)', async () => {
    const db = fakeDb([[KEYER_AMONG, []], [AT_PLACE_ON_DAY, [REX(340, 'AKEMI'), REX(341, 'DUNLOPILLO')]]]);
    const r = await resolveScanFair({ db, ...scanArgs, brand: 'AKEMI' });
    expect(r).toMatchObject({ projectId: 340, step: 'slip_place', fairDate: '2026-10-16' });
  });

  it('3. nothing at the slip place that day: the keyer\'s fair today, its brand booth, no Fair Day', async () => {
    const IOI = (id: number, brand: string) => project({ id, venue: 'IOIGECC', organizer: 'MLE', brand, startdate: '2026-10-17', enddate: '2026-10-20' });
    const db = fakeDb([
      [AT_PLACE_ON_DAY, []], [EVENT_BOOTHS, [IOI(2320, 'AKEMI'), IOI(2321, 'ERGOTEX')]], [KEYER_FAIRS, [IOI(2320, 'AKEMI')]],
    ]);
    const r = await resolveScanFair({ db, ...scanArgs, brand: 'ERGOTEX' });
    expect(r).toMatchObject({ projectId: 2321, step: 'today', fairDate: null, venue: 'IOIGECC' });
  });

  it('4. none today: the latest within the window', async () => {
    const BIGHOME = project({ id: 2301, organizer: 'BIGHOME', brand: 'AKEMI', startdate: '2026-10-02', enddate: '2026-10-04' });
    const db = fakeDb([[AT_PLACE_ON_DAY, []], [EVENT_BOOTHS, [BIGHOME]], [KEYER_FAIRS, [BIGHOME]]]);
    expect(await resolveScanFair({ db, ...scanArgs, brand: 'AKEMI' })).toMatchObject({ projectId: 2301, step: 'latest' });
  });

  it('a slip date after the day it was keyed is a misread: the place is not looked up by it', async () => {
    const db = fakeDb([[KEYER_FAIRS, []]]);
    const r = await resolveScanFair({ db, ...scanArgs, slipDate: '2026-11-16', brand: 'AKEMI' });
    expect(r.step).toBe('none');
    expect(db.calls.some((c) => AT_PLACE_ON_DAY.test(c.sql))).toBe(false);
  });

  it('5. nothing anywhere, or a failed read: PENDING, never a guess', async () => {
    expect(await resolveScanFair({ db: fakeDb([[AT_PLACE_ON_DAY, []], [KEYER_FAIRS, []]]), ...scanArgs, brand: 'AKEMI' }))
      .toEqual({ projectId: null, match: 'PENDING', candidateIds: [], step: 'none', fairDate: null, venue: null });
    expect((await resolveScanFair({ db: fakeDb([[AT_PLACE_ON_DAY, new Error('down')]]), ...scanArgs, brand: 'AKEMI' })).step).toBe('none');
  });
});

describe('fairLinkOnCreate — the columns a new order is written with', () => {
  const base = { companySql: CO, keyerId: 57, soDate: '2026-10-19', bindingProjectId: 2228 };

  it('No fair ticked is decided, whatever else came', async () => {
    const r = await fairLinkOnCreate({ ...base, db: fakeDb([]), companyCode: 'HOUZS', scanned: false, body: { noFair: true, fairOrganizer: 'REX' }, venue: 'MID VALLEY', brand: null });
    expect(r).toEqual({ columns: { project_id: null, fair_match: 'NO_FAIR' }, step: null });
  });

  it('a Houzs scan found by slip place and date takes the slip date as its Fair Day', async () => {
    const db = fakeDb([[KEYER_AMONG, [{ id: 340 }]], [AT_PLACE_ON_DAY, [REX(340, 'AKEMI')]]]);
    const r = await fairLinkOnCreate({ ...base, db, companyCode: 'HOUZS', scanned: true, body: { venue: 'MID VALLEY', slipDate: '2026-10-16' }, venue: 'MID VALLEY', brand: 'AKEMI' });
    expect(r).toEqual({ columns: { project_id: 340, fair_match: 'PICKED', fair_date: '2026-10-16' }, step: 'slip_mine' });
  });

  it('a slip with no place takes the place of the fair it was put at', async () => {
    const IOI = project({ id: 2320, venue: 'IOIGECC', organizer: 'MLE', startdate: '2026-10-17', enddate: '2026-10-20' });
    const db = fakeDb([[EVENT_BOOTHS, [IOI]], [KEYER_FAIRS, [IOI]]]);
    const r = await fairLinkOnCreate({ ...base, db, companyCode: 'HOUZS', scanned: true, body: { venue: null, slipDate: '2026-10-16' }, venue: null, brand: 'AKEMI' });
    expect(r).toEqual({ columns: { project_id: 2320, fair_match: 'PICKED', venue: 'IOIGECC', venue_source: 'PMS' }, step: 'today' });
  });

  it('Houzs never falls back to the keyer\'s running fair at ANOTHER place; 2990 keeps that fallback', async () => {
    const typed = { scanned: false, body: { fairOrganizer: 'REX', fairStart: '2026-10-15', fairEnd: '2026-10-18' }, venue: 'KLCC', brand: 'AKEMI' };
    expect(await fairLinkOnCreate({ ...base, ...typed, db: fakeDb([[EVENT_BOOTHS, []]]), companyCode: 'HOUZS' }))
      .toEqual({ columns: { project_id: null, fair_match: 'PENDING' }, step: null });
    expect(await fairLinkOnCreate({ ...base, ...typed, db: fakeDb([[EVENT_BOOTHS, []]]), companyCode: '2990' }))
      .toEqual({ columns: { project_id: 2228, fair_match: 'PICKED' }, step: null });
  });
});

/** The scm half of the confirm gate: one row per table, or an error. */
function fakeSb(tables: Record<string, Row[] | Error>): FairConfirmSb {
  return {
    from(table: string) {
      const t = tables[table] ?? [];
      const many = () => Promise.resolve(t instanceof Error ? { data: null, error: { message: t.message } } : { data: t, error: null });
      const one = () => Promise.resolve(t instanceof Error ? { data: null, error: { message: t.message } } : { data: t[0] ?? null, error: null });
      const chain = { select: () => chain, eq: () => chain, order: () => ({ limit: many }), maybeSingle: one };
      return chain;
    },
  } as unknown as FairConfirmSb;
}

describe('fairConfirmProblems — what a DRAFT needs before Confirm (owner 2026-10-19)', () => {
  const run = (sb: FairConfirmSb, db: FairDb, over: Partial<{ companyCode: string; confirmerId: number }> = {}) =>
    fairConfirmProblems({ sb, db, companySql: CO, companyCode: 'HOUZS', scope: (q) => q, docNo: 'HC-SO-2610-300', confirmerId: 57, todayMyt: '2026-10-19', ...over });
  const linked = (extra: Row = {}) => ({ mfg_sales_orders: [{ project_id: 340, fair_match: 'PICKED', venue: 'MID VALLEY', ...extra }] });
  const BOOTH = REX(340, 'AKEMI');

  it('2990 is not on this rule', async () => {
    expect(await run(fakeSb({ mfg_sales_orders: [{ project_id: null, fair_match: 'PENDING' }] }), fakeDb([]), { companyCode: '2990' })).toEqual([]);
  });

  it('no fair and no No fair: refused, worded by why the keyer got none', async () => {
    const ps = await run(fakeSb({ mfg_sales_orders: [{ project_id: null, fair_match: 'PENDING', venue: 'KLCC' }] }), fakeDb([[KEYER_FAIRS, []]]));
    expect(ps).toEqual([{ code: 'fair_required', field: 'Fair', message: expect.stringContaining('you are not on Sales Attending for any fair in PMS') }]);
    expect(await run(fakeSb({ mfg_sales_orders: [{ project_id: null, fair_match: 'NO_FAIR' }] }), fakeDb([]))).toEqual([]);
  });

  it('a fair found but its booth a person\'s call: the standing sentence', async () => {
    const ps = await run(fakeSb({ mfg_sales_orders: [{ project_id: null, fair_match: 'AMBIGUOUS' }] }), fakeDb([]));
    expect(ps[0]?.message).toBe('Pick the Fair, or mark it No fair (showroom).');
  });

  it('a typed order keeps its free choice: no Sales Attending check', async () => {
    expect(await run(fakeSb({ ...linked(), scan_jobs: [] }), fakeDb([[BOOTH_BY_ID, [BOOTH]], [KEYER_AMONG, []]]))).toEqual([]);
  });

  it('a scan confirms whether or not its scanner is on the booth\'s Sales Attending (owner 2026-10-22)', async () => {
    /* 「之前的如果那个sales attending他不在那场就不能开单的帮我remove 掉这个rule先。
       但扫描单还是能认」 — Fair Links still lists who is missing. */
    const own = fakeSb({ ...linked(), scan_jobs: [{ houzs_user_id: 57 }] });
    expect(await run(own, fakeDb([[BOOTH_BY_ID, [BOOTH]], [KEYER_AMONG, [{ id: 340 }]]]))).toEqual([]);
    expect(await run(own, fakeDb([[BOOTH_BY_ID, [BOOTH]], [KEYER_AMONG, []]]))).toEqual([]);
    const someoneElse = fakeSb({ ...linked(), scan_jobs: [{ houzs_user_id: 92 }] });
    expect(await run(someoneElse, fakeDb([[USER_NAME, [{ name: 'Jason' }]], [BOOTH_BY_ID, [BOOTH]], [KEYER_AMONG, []]]))).toEqual([]);
  });

  it('"Venue differs" refuses only while the Fair rules switch is on', async () => {
    const db = () => fakeDb([[BOOTH_BY_ID, [project({ id: 340, venue: 'IOIGECC', startdate: '2026-10-09', enddate: '2026-10-11' })]], [KEYER_AMONG, [{ id: 340 }]]]);
    const scan = { ...linked(), scan_jobs: [{ houzs_user_id: 57 }] };
    expect(await run(fakeSb(scan), db())).toEqual([]);
    const ps = await run(fakeSb({ ...scan, so_settings: [{ enabled: true }] }), db());
    expect(ps).toEqual([{ code: 'fair_venue_differs', field: 'Fair', message: expect.stringContaining('Slip venue: MID VALLEY — placed at: IOIGECC (10/09 - 10/11)') }]);
  });

  it('a gate that could not look does not say all clear', async () => {
    const ps = await run(fakeSb({ mfg_sales_orders: new Error('timeout') }), fakeDb([]));
    expect(ps[0]?.code).toBe('so_confirm_check_failed');
    const ps2 = await run(fakeSb({ ...linked(), scan_jobs: new Error('timeout') }), fakeDb([]));
    expect(ps2[0]?.code).toBe('so_confirm_check_failed');
  });
});
