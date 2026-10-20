import { describe, it, expect } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { loadFairChecks, SCAN_RULE_FROM } from './fair-checks';
import type { FairDb } from './fair-binding';

/* The two groups of LINKED orders on "Fair Links to Settle" (owner 2026-10-19):
 *   要查  — the venue on the order is not where it was placed;
 *   等加人 — a scan whose scanner is not on its booth's Sales Attending.
 * Read as the order and PMS stand now; nothing stored. */

type Row = Record<string, unknown>;
type Answer = Row[] | Error | ((binds: unknown[]) => Row[]);

function fakeDb(answers: Array<[RegExp, Answer]>): FairDb {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              const hit = answers.find(([re]) => re.test(sql));
              const a = hit ? hit[1] : [];
              if (a instanceof Error) throw a;
              return { results: (typeof a === 'function' ? a(binds) : a) as unknown as T[] };
            },
          };
        },
      };
    },
  };
}

const KEYER = /p\.pic_id = \?/;
const BY_IDS = /FROM projects p WHERE p\.id IN \(/;
const AT_VENUE = /lower\(trim\(p\.venue\)\) = lower\(trim\(\?\)\)/;
const USERS = /FROM users u/;

const project = (o: Row): Row => ({ venue: 'MID VALLEY', organizer: 'REX', brand: 'AKEMI', startdate: '2026-10-15', enddate: '2026-10-18', status: 'confirmed', ...o });
const BOOTHS: Row[] = [
  project({ id: 340 }),
  project({ id: 2228, venue: 'SUNWAY CARNIVAL MALL', organizer: 'MALL MGT', brand: 'DUNLOPILLO', startdate: '2026-09-25', enddate: '2026-09-29' }),
];

const order = (o: Row): Row => ({
  company_id: 1, doc_no: 'HC-SO-2610-001', so_date: '2026-10-19', venue: 'MID VALLEY', branding: 'AKEMI', project_id: 340,
  fair_match: 'PICKED', status: 'CONFIRMED', local_total_sen: 500000, salesperson_id: 'staff-a', ...o,
});

const run = (tables: Record<string, Row[]>, db: FairDb) =>
  loadFairChecks({ sb: fakeSb(tables, {}), db, companySql: ' AND p.company_id = 1', scope: (q) => (q as { eq(c: string, v: unknown): typeof q }).eq('company_id', 1) });

describe('要查 — the venue on the order is not where it was placed', () => {
  it('an old fallback link: KLCC order on a Sunway Carnival booth, with the reason', async () => {
    const res = await run(
      { mfg_sales_orders: [order({ doc_no: 'HC-SO-2610-012', so_date: '2026-10-05', venue: 'KLCC', project_id: 2228 })], scan_jobs: [] },
      fakeDb([[BY_IDS, BOOTHS], [AT_VENUE, []]]),
    );
    expect(res).toEqual({ ok: true, rows: [expect.objectContaining({
      doc_no: 'HC-SO-2610-012', check: 'VENUE_DIFFERS',
      note: 'Venue on the order: KLCC — placed at: SUNWAY CARNIVAL MALL (09/25 - 09/29). Reason: no fair at KLCC in PMS in the 4 weeks to 10/05.',
    })] });
  });

  it('a scan names the SLIP venue, and says when PMS now has a fair there', async () => {
    const res = await run(
      { mfg_sales_orders: [order({ venue: 'IOIGECC', status: 'DRAFT' })], scan_jobs: [{ company_id: 1, so_doc_no: 'HC-SO-2610-001', houzs_user_id: 57, created_at: '2026-10-19T03:00:00Z' }] },
      fakeDb([[KEYER, [{ id: 340 }]], [BY_IDS, BOOTHS], [AT_VENUE, [project({ id: 2320, venue: 'IOIGECC', organizer: 'MLE', startdate: '2026-10-09', enddate: '2026-10-11' })]]]),
    );
    expect(res.ok && res.rows.map((r) => r.note)).toEqual([
      'Slip venue: IOIGECC — placed at: MID VALLEY (10/15 - 10/18). Reason: IOIGECC has MLE (10/09 - 10/11) in PMS — re-link if it was sold there.',
    ]);
  });

  it('the same place spelled differently is not a difference', async () => {
    const res = await run({ mfg_sales_orders: [order({ venue: ' mid  valley ' })], scan_jobs: [] }, fakeDb([[BY_IDS, BOOTHS]]));
    expect(res).toEqual({ ok: true, rows: [] });
  });
});

describe('等加人 — a scan whose scanner is not on the booth', () => {
  const scanned = (doc: string, user: number) => ({ company_id: 1, so_doc_no: doc, houzs_user_id: user, created_at: '2026-10-19T03:00:00Z' });

  it('a scanned DRAFT, whatever its date, names who is missing and why it waits', async () => {
    const res = await run(
      { mfg_sales_orders: [order({ status: 'DRAFT', so_date: '2026-10-02' })], scan_jobs: [scanned('HC-SO-2610-001', 92)] },
      fakeDb([[KEYER, []], [BY_IDS, BOOTHS], [USERS, [{ id: 92, name: 'Jason' }]]]),
    );
    expect(res.ok && res.rows).toEqual([expect.objectContaining({
      check: 'NEEDS_ATTENDING',
      note: 'Jason is not on Sales Attending for AKEMI @ MID VALLEY (10/15 - 10/18). The draft cannot be confirmed until PMS adds them.',
    })]);
  });

  it('a confirmed scan is checked only from the day the scan rule went live', async () => {
    const before = order({ doc_no: 'HC-SO-2610-002', so_date: '2026-10-18' });
    const after = order({ doc_no: 'HC-SO-2610-003', so_date: SCAN_RULE_FROM });
    const res = await run(
      { mfg_sales_orders: [before, after], scan_jobs: [scanned('HC-SO-2610-002', 92), scanned('HC-SO-2610-003', 92)] },
      fakeDb([[KEYER, []], [BY_IDS, BOOTHS], [USERS, [{ id: 92, name: 'Jason' }]]]),
    );
    expect(res.ok && res.rows.map((r) => [r.doc_no, r.note])).toEqual([
      ['HC-SO-2610-003', 'Jason is not on Sales Attending for AKEMI @ MID VALLEY (10/15 - 10/18).'],
    ]);
  });

  it('on the booth, or a typed order: nothing to add', async () => {
    const res = await run(
      { mfg_sales_orders: [order({ status: 'DRAFT' }), order({ doc_no: 'HC-SO-2610-009', status: 'DRAFT' })], scan_jobs: [scanned('HC-SO-2610-001', 57)] },
      fakeDb([[KEYER, (binds) => (binds.at(-1) === 57 ? [{ id: 340 }] : [])], [BY_IDS, BOOTHS]]),
    );
    expect(res).toEqual({ ok: true, rows: [] });
  });
});

describe('what is never listed, and a read that fails', () => {
  it('cancelled, unlinked, and before 1 September are not here', async () => {
    const res = await run({
      mfg_sales_orders: [
        order({ doc_no: 'A', venue: 'KLCC', status: 'CANCELLED' }),
        order({ doc_no: 'B', venue: 'KLCC', project_id: null }),
        order({ doc_no: 'C', venue: 'KLCC', so_date: '2026-08-30' }),
        order({ doc_no: 'D', venue: 'KLCC', company_id: 2 }),
      ],
      scan_jobs: [],
    }, fakeDb([[BY_IDS, BOOTHS], [AT_VENUE, []]]));
    expect(res).toEqual({ ok: true, rows: [] });
  });

  it('PMS unreadable is a failure, never "nothing to check"', async () => {
    const res = await run({ mfg_sales_orders: [order({ venue: 'KLCC' })], scan_jobs: [] }, fakeDb([[BY_IDS, new Error('down')]]));
    expect(res).toEqual({ ok: false });
  });
});
