import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

/* The HC Delivery sheet's Apps Script (reference/ERPDeliverySync.gs, the
   version-controlled copy of the live script). 2026-10-20 report: a sort by
   staff while a sync run was writing put HC-SO-2609-084's data over another
   order's row; that order later came back at the bottom with an EMPTY col A.
   erpWriteRecords_ must find each order by DocNo at write time, and an
   appended row gets its col A status back from the ERP (Remark4).
   The script runs here in a vm against an in-memory sheet. */

type Cell = string | number;
const COLS = 59;

function fakeSheet(rows: Cell[][], onIndexRead?: (rows: Cell[][]) => void) {
  // rows[0] is sheet row 4 (startRow); each row is COLS cells, col A at [0].
  let colBReads = 0;
  const lastRow = () => 3 + rows.length;
  const cell = (r: number, c: number) => {
    while (rows.length < r - 3) rows.push(Array(COLS).fill(''));
    return rows[r - 4]!;
  };
  return {
    rows,
    header: [] as Cell[],
    getLastRow: lastRow,
    getLastColumn: () => COLS,
    getRange(r: number, c: number, nr = 1, nc = 1) {
      const self = this as { header: Cell[] };
      return {
        getValue: () => (r >= 4 && r <= lastRow() ? rows[r - 4]![c - 1] : ''),
        getValues: () => {
          if (r === 3) return [Array.from({ length: nc }, (_, i) => self.header[c - 1 + i] ?? '')];
          const out = [];
          for (let i = 0; i < nr; i++) out.push(rows[r - 4 + i]!.slice(c - 1, c - 1 + nc));
          if (c === 2 && nc === 1 && colBReads++ === 0 && onIndexRead) onIndexRead(rows);
          return out;
        },
        setValue(v: Cell) { cell(r, c)[c - 1] = v; return this; },
        setValues(vs: Cell[][]) { vs.forEach((row, i) => row.forEach((v, j) => { cell(r + i, c)[c - 1 + j] = v; })); return this; },
        setBackground() { return this; },
      };
    },
  };
}

function loadScript() {
  const src = readFileSync(resolve(__dirname, '../../reference/ERPDeliverySync.gs'), 'utf8');
  const sandbox: Record<string, unknown> = {
    Log: { info() {}, warn() {}, error() {} },
    getSheetConfig: (name: string) => name === 'EM Order'
      ? { startRow: 4, block2StartCol: 25, includeRemark3: true, attentionCol: 43, statusCol: 44 }
      : { startRow: 4, block2StartCol: 25, includeRemark3: true, attentionCol: 45, statusCol: 46 },
    CONFIG: { WEST_SHEET: 'Delivery Details', EAST_SHEET: 'EM Order', SG_SHEET: 'SG Order' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.__w = erpWriteRecords_;`, sandbox);
  return sandbox.__w as (ss: unknown, name: string, recs: unknown[], rid: string) => { success: number; appended: number; restoredStatus: number };
}

const row = (a: string, doc: string) => { const r: Cell[] = Array(COLS).fill(''); r[0] = a; r[1] = doc; return r; };

describe('erpWriteRecords_ — a row is found by DocNo at write time', () => {
  test('a sort between indexing and writing does not overwrite another order', () => {
    const write = loadScript();
    // Staff sort the tab right after the writer indexed col B: 084 and 999 swap.
    const sheet = fakeSheet([row('Done Scheduling', 'HC-SO-2609-084'), row('To Send Delivery Date', 'HC-SO-2609-999')], (rows) => {
      const t = rows[0]!; rows[0] = rows[1]!; rows[1] = t;
    });
    write({ getSheetByName: () => sheet }, 'Delivery Details', [{ DocNo: 'HC-SO-2609-084', DebtorName: 'NEW NAME', Remark4: 'Done Scheduling' }], 'rid');
    const byDoc = Object.fromEntries(sheet.rows.map((r) => [r[1], r]));
    expect(sheet.rows).toHaveLength(2);
    expect(byDoc['HC-SO-2609-084']![6]).toBe('NEW NAME');
    expect(byDoc['HC-SO-2609-084']![0]).toBe('Done Scheduling');
    expect(byDoc['HC-SO-2609-999']![6]).toBe('');
    expect(byDoc['HC-SO-2609-999']![0]).toBe('To Send Delivery Date');
  });

  test('an appended order gets its col A status back from the ERP', () => {
    const write = loadScript();
    const sheet = fakeSheet([row('Done Scheduling', 'HC-SO-2609-001')]);
    const r = write({ getSheetByName: () => sheet }, 'Delivery Details', [{ DocNo: 'HC-SO-2609-084', Remark4: 'Pending Customer Reply (D)' }], 'rid');
    expect(sheet.rows[1]![1]).toBe('HC-SO-2609-084');
    expect(sheet.rows[1]![0]).toBe('Pending Customer Reply (D)');
    expect(r).toMatchObject({ success: 1, appended: 1, restoredStatus: 1 });
  });

  test('an existing row keeps its own col A; the ERP status never overwrites it', () => {
    const write = loadScript();
    const sheet = fakeSheet([row('Done Driver Information', 'HC-SO-2609-084')]);
    write({ getSheetByName: () => sheet }, 'Delivery Details', [{ DocNo: 'HC-SO-2609-084', Remark4: 'To Send Delivery Date' }], 'rid');
    expect(sheet.rows[0]![0]).toBe('Done Driver Information');
  });

  test('EM Order is written by header NAME: Attention / Sync Status land in AS / AT, AQ / AR and ESB columns untouched', () => {
    const write = loadScript();
    const sheet = fakeSheet([row('Done Scheduling', 'SO-007847')]);
    const hdr: Cell[] = Array(COLS).fill('');
    hdr[1] = 'Doc. No.'; hdr[6] = 'Debtor Name'; hdr[16] = 'SHIPOUT DATE = DO date'; hdr[18] = 'Consignment No';
    hdr[30] = 'Address 4'; hdr[44] = 'Attention'; hdr[45] = 'Sync Status';
    sheet.header = hdr;
    sheet.rows[0]![18] = 'MI3008003-25';
    sheet.rows[0]![43] = 'PENDING';
    write({ getSheetByName: () => sheet }, 'EM Order', [{ DocNo: 'SO-007847', DebtorName: 'Nazhatul', InvAddr4: 'Sarawak', Attention: 'SEAMPIFY' }], 'rid');
    const r = sheet.rows[0]!;
    expect(r[6]).toBe('Nazhatul');
    expect(r[30]).toBe('Sarawak');
    expect(r[44]).toBe('SEAMPIFY');
    expect(r[45]).toBe('SYNCED');
    expect(r[42]).toBe('');
    expect(r[43]).toBe('PENDING');
    expect(r[18]).toBe('MI3008003-25');
    expect(r[0]).toBe('Done Scheduling');
  });
});
