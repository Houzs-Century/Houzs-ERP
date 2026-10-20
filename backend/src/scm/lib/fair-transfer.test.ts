import { describe, it, expect } from 'vitest';
import { fakeSb } from './fake-postgrest';
import type { FairDb } from './fair-binding';
import { FAIR_TRANSFER_MAX, fairTransferItemsOf, transferFairDay, transferOrdersToFairs } from './fair-transfer';

/* Moving orders to the project they belong to, by hand (owner 2026-10-20:
   「做成 manual bulk transfer 去对的 project，单上的资料也要改」). The case is the
   2026-10-12 IOI scans: placed at the September IOI CITY MALL roadshow (#343) or
   nowhere, while the IOIGECC fair's (#307) evening report lists them on 10-10. */

type Row = Record<string, unknown>;

function fakeDb(answers: Array<[RegExp, Row[] | ((binds: unknown[]) => Row[])]>): FairDb {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              const hit = answers.find(([re]) => re.test(sql));
              const a = hit ? hit[1] : [];
              return { results: (typeof a === 'function' ? a(binds) : a) as unknown as T[] };
            },
          };
        },
      };
    },
  };
}

const FAIRS: Row[] = [
  { id: 307, name: 'Putrajaya [AKEMI] HOMELOVE @ IOIGECC', venue: 'IOIGECC', organizer: 'HOMELOVE', brand: 'AKEMI', startdate: '2026-10-09', enddate: '2026-10-11', status: 'confirmed' },
  { id: 343, name: 'Putrajaya [AKEMI] MALL MGT @ IOI CITY MALL PUTRAJAYA', venue: 'IOI MALL PUTRAJAYA', organizer: 'MALL MGT', brand: 'AKEMI', startdate: '2026-09-16', enddate: '2026-09-20', status: 'confirmed' },
];
const byIds = (binds: unknown[]) => FAIRS.filter((f) => binds.includes(f.id));
const db = fakeDb([
  [/FROM project_activity a/, [{ id: 1, project_id: 307, note: '10/10\n1. HC13316 RM3388 Shawn', created_at: '2026-10-10 22:00:00', start_date: '2026-10-09', author_email: 'ummuaimanlm@gmail.com', author_position: 'Operation Executive' }]],
  /* Only a LIVE fair may be moved to (archived / cancelled are filtered in SQL). */
  [/p\.archived_at IS NULL/, byIds],
  [/FROM projects p WHERE p\.id IN \(/, byIds],
]);

const order = (o: Row): Row => ({
  company_id: 1, doc_no: 'HC-SO-2610-167', so_date: '2026-10-12', status: 'CONFIRMED', project_id: 343, fair_match: 'PICKED',
  venue: 'IOI MALL PUTRAJAYA', venue_source: 'MANUAL', fair_date: null, customer_so_no: 'HC13316', ref: null, ...o,
});

describe('fairTransferItemsOf', () => {
  it('a list of orders, each moved once', () => {
    expect(fairTransferItemsOf({ items: [{ docNo: ' A ', projectId: 307 }, { docNo: 'A', projectId: 9 }, { docNo: 'B', projectId: '343' }] }))
      .toEqual([{ docNo: 'A', projectId: 307 }, { docNo: 'B', projectId: 343 }]);
  });

  it('anything else is refused whole', () => {
    expect(fairTransferItemsOf({ items: [] })).toBeNull();
    expect(fairTransferItemsOf({ items: [{ docNo: 'A' }] })).toBeNull();
    expect(fairTransferItemsOf({ items: [{ docNo: '', projectId: 1 }] })).toBeNull();
    expect(fairTransferItemsOf({ items: Array.from({ length: FAIR_TRANSFER_MAX + 1 }, (_, i) => ({ docNo: `D${i}`, projectId: 1 })) })).toBeNull();
    expect(fairTransferItemsOf(null)).toBeNull();
  });
});

describe('transferFairDay', () => {
  const fair = { startDate: '2026-10-09', endDate: '2026-10-11' };
  it('the report\'s day, else the order\'s own, whichever is a day of the fair; else none', () => {
    expect(transferFairDay(fair, '2026-10-10', '2026-09-18')).toBe('2026-10-10');
    expect(transferFairDay(fair, '2026-10-20', '2026-10-11')).toBe('2026-10-11');
    expect(transferFairDay(fair, null, '2026-09-18')).toBeNull();
  });
});

describe('transferOrdersToFairs', () => {
  it('moves the Fair, the Venue and the Fair Day together, with a History row naming the report', async () => {
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [order({}), order({ doc_no: 'HC-SO-2610-166', project_id: null, fair_match: 'PENDING', venue: 'IOI MALL KULAI', customer_so_no: 'HC13548' })],
      mfg_so_audit_log: [],
    };
    const sb = fakeSb(tables, {});
    const results = await transferOrdersToFairs({
      sb, db, companySql: ' AND p.company_id = 1', companyId: 1,
      items: [{ docNo: 'HC-SO-2610-167', projectId: 307 }, { docNo: 'HC-SO-2610-166', projectId: 307 }],
      actorId: 'staff-f', actorName: 'Finance',
    });
    expect(results).toEqual([
      { docNo: 'HC-SO-2610-167', ok: true, projectId: 307, venue: 'IOIGECC', fairDate: '2026-10-10' },
      /* Not in the report: no day of the fair to give it. */
      { docNo: 'HC-SO-2610-166', ok: true, projectId: 307, venue: 'IOIGECC', fairDate: null },
    ]);
    expect(tables.mfg_sales_orders!.map((o) => [o.doc_no, o.project_id, o.fair_match, o.venue, o.venue_source, o.fair_date])).toEqual([
      ['HC-SO-2610-167', 307, 'PICKED', 'IOIGECC', 'PMS', '2026-10-10'],
      ['HC-SO-2610-166', 307, 'PICKED', 'IOIGECC', 'PMS', null],
    ]);
    const audit = tables.mfg_so_audit_log!.find((a) => a.so_doc_no === 'HC-SO-2610-167')!;
    expect(audit).toMatchObject({ action: 'UPDATE_FAIR', source: 'transfer', note: 'Moved to Putrajaya [AKEMI] HOMELOVE @ IOIGECC: its evening sales report lists this order on 2026-10-10.' });
    expect(audit.field_changes).toEqual([
      { field: 'fair', from: 'IOI MALL PUTRAJAYA — MALL MGT (09/16 - 09/20) · AKEMI', to: 'IOIGECC — HOMELOVE (10/09 - 10/11) · AKEMI' },
      { field: 'venue', from: 'IOI MALL PUTRAJAYA', to: 'IOIGECC' },
      { field: 'fairDate', from: null, to: '2026-10-10' },
    ]);
    expect(tables.mfg_so_audit_log!.find((a) => a.so_doc_no === 'HC-SO-2610-166')!.note).toBe('Moved to Putrajaya [AKEMI] HOMELOVE @ IOIGECC by hand.');
  });

  it('one that cannot move says why; the rest still move', async () => {
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [
        order({ doc_no: 'GONE', status: 'CANCELLED' }),
        order({ doc_no: 'HERE', project_id: 307 }),
        order({ doc_no: 'OTHER-CO', company_id: 2 }),
        order({ doc_no: 'OK' }),
      ],
      mfg_so_audit_log: [],
    };
    const results = await transferOrdersToFairs({
      sb: fakeSb(tables, {}), db, companySql: ' AND p.company_id = 1', companyId: 1,
      items: [
        { docNo: 'GONE', projectId: 307 }, { docNo: 'HERE', projectId: 307 }, { docNo: 'OTHER-CO', projectId: 307 },
        { docNo: 'OK', projectId: 999 }, { docNo: 'NOPE', projectId: 307 },
      ],
      actorId: null, actorName: null,
    });
    expect(results.map((r) => [r.docNo, r.ok ? 'ok' : r.reason])).toEqual([
      ['GONE', 'cancelled'], ['HERE', 'already_there'], ['OTHER-CO', 'not_found'], ['OK', 'fair_not_open'], ['NOPE', 'not_found'],
    ]);
    expect(tables.mfg_so_audit_log).toEqual([]);
  });
});
