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
  vm.runInContext(`${src}\nthis.__w = erpWriteRecords_; this.__plan = erpPlanTransporterPush_; this.__pull = erpPlanTransporterPull_; this.__bsWants = ERP_TRANSPORTERS[1].wants; this.__regions = erpRegionalSheets_;`, sandbox);
  lastSandbox = sandbox;
  return sandbox.__w as (ss: unknown, name: string, recs: unknown[], rid: string) => { success: number; appended: number; restoredStatus: number };
}

let lastSandbox: Record<string, unknown> = {};
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

describe('EM Order push to the ERP and to the ESB / BS transporter sheets', () => {
  test('EM Order reads PENDING from AR (44), the column onEdit marks', () => {
    loadScript();
    const regions = (lastSandbox.__regions as () => { name: string; statusCol: number }[])();
    expect(regions.find((r) => r.name === 'EM Order')!.statusCol).toBe(44);
  });

  const master = {
    labels: ['', 'From AutoCount', 'From AutoCount', 'From ESB Sheet', 'From Admin'],
    headers: ['DELIVERY MESSAGE STATUS', 'Doc. No.', 'Sales Location', 'Consignment No', 'BALANCE'],
    rows: [
      ['Done Shipout', 'SO-1', 'SBH', 'MASTER-CN', '120.00'],
      ['Done Delivered', 'SO-2', 'SBH', '', '0.00'],
      ['Customer Confirm Shipment', 'SO-3', 'SRW', '', '50.00'],
      ['Done Shipout', 'SO-4', 'SBH', '', ''],
    ],
  };
  const plan = (m: unknown, t: unknown, w: unknown) => (lastSandbox.__plan as Function)(m, t, w);

  test('an existing row gets only EM-owned columns; transporter columns and blank EM values never overwrite', () => {
    loadScript();
    const p = plan(master, {
      headers: ['EM Order Shipment Status', 'Doc. No.', 'Sales Location', 'Consignment No', 'BALANCE'],
      rows: [['', 'SO-1', 'SBH', 'ESB-CN', '99.00'], ['', 'SO-4', 'SBH', '', '10.00']],
      allowed: {},
    }, () => false);
    // col A status (alias "EM Order Shipment Status") fills the blank target status; BALANCE updates; Consignment (From ESB) never.
    expect(p.updates).toEqual([
      { row: 0, col: 0, value: 'Done Shipout' },
      { row: 0, col: 4, value: '120.00' },
      { row: 1, col: 0, value: 'Done Shipout' },
    ]);
    expect(p.appends).toEqual([]);
  });

  test('BS gets an order ESB marked TO BRIGHTSUN; ESB gets every missing order', () => {
    loadScript();
    const m = {
      labels: ['', 'From AutoCount', 'From ESB Sheet'],
      headers: ['DELIVERY MESSAGE STATUS', 'Doc. No.', 'EM Order Delivery Status ESB Remarks'],
      rows: [['Done Shipout', 'SO-1', 'TO BRIGHTSUN'], ['Done Shipout', 'SO-2', ''], ['', 'SO-3', 'PLEASE COLLECT PAYMENT']],
    };
    const t = { headers: ['EM Order Shipment Status', 'Doc. No.'], rows: [], allowed: {} };
    // The decision reads the ESB SHEET's remark, not EM's copy: SO-2 is marked on ESB only.
    const esbRemark = (d: string) => ({ 'SO-1': 'TO BRIGHTSUN - 2026/09/07', 'SO-2': 'TO BRIGHTSUN', 'SO-3': 'PLEASE COLLECT PAYMENT' } as Record<string, string>)[d] ?? '';
    expect((lastSandbox.__plan as Function)(m, t, lastSandbox.__bsWants, esbRemark).appends.map((r: string[]) => r[1])).toEqual(['SO-1', 'SO-2']);
    expect(plan(m, t, () => true).appends.map((r: string[]) => r[1])).toEqual(['SO-1', 'SO-2', 'SO-3']);
  });

  test('a value the target dropdown rejects is skipped, not written', () => {
    loadScript();
    const p = plan(master, {
      headers: ['x', 'Doc. No.', 'Sales Location', 'Consignment No', 'BALANCE'],
      rows: [['', 'SO-1', 'SBH', '', '1.00']],
      allowed: { 4: { '1.00': 1 } },
    }, () => false);
    expect(p.updates).toEqual([]);
    expect(p.blocked).toBe(1);
  });

  test("EM col A status pushes to the transporter 'EM Order Shipment Status' column (header alias)", () => {
    loadScript();
    const m = { labels: ["", "From AutoCount"], headers: ["DELIVERY MESSAGE STATUS", "Doc. No."], rows: [["Done Shipout", "SO-1"], ["Done Delivered", "SO-2"]] };
    const p = plan(m, { headers: ["EM Order Shipment Status", "Doc. No."], rows: [["", "SO-1"], ["Peding Delivery (EM)", "SO-2"]], allowed: {} }, () => false);
    expect(p.updates).toEqual([{ row: 0, col: 0, value: "Done Shipout" }, { row: 1, col: 0, value: "Done Delivered" }]);
  });

  test("transporter-owned columns come back into EM Order; blanks never clear, other columns untouched", () => {
    loadScript();
    const m = {
      labels: ["", "From AutoCount", "From ESB Sheet", "From BS Sheet", "From Admin"],
      headers: ["DELIVERY MESSAGE STATUS", "Doc. No.", "Vessel & Voyage", "BS KK - Delivery Date", "BALANCE"],
      rows: [["Done Shipout", "SO-1", "", "", "10.00"], ["Done Shipout", "SO-2", "OLD", "", "0.00"], ["", "SO-3", "KEEP", "", ""]],
    };
    const esb = { headers: ["EM Order Shipment Status", "Doc. No.", "Vessel & Voyage", "BS KK - Delivery Date", "BALANCE"],
      rows: [["x", "SO-1", "DANUM 159", "2026/11/01", "99"], ["x", "SO-2", "DANUM 160", "", "99"], ["x", "SO-3", "", "", ""]], allowed: {} };
    const pull = (lastSandbox.__pull as Function)(m, esb, "ESB").updates;
    expect(pull).toEqual([{ row: 0, col: 2, value: "DANUM 159", doc: "SO-1" }, { row: 1, col: 2, value: "DANUM 160", doc: "SO-2" }]);
    const bsPull = (lastSandbox.__pull as Function)(m, esb, "BS").updates;
    expect(bsPull).toEqual([{ row: 0, col: 3, value: "2026/11/01", doc: "SO-1" }]);
  });

  test('ownership comes from the row-3 header: transport columns are the transporter\'s, the rest Houzs\'', () => {
    loadScript();
    const m = {
      labels: ['', '', '', '', '', '', ''],
      headers: ['DELIVERY MESSAGE STATUS', 'Doc. No.', 'ETA EM Port \uff08YYYY/MM/DD\uff09', 'EM Order Delivery Status ESB Remarks', 'BS KK - Delivery Date \uff08YYYY/MM/DD\uff09', 'Houzs Remark 2', 'BALANCE'],
      rows: [['Done Shipout', 'SO-1', '', '', '', 'H2', '5']],
    };
    const t = { headers: m.headers.map((h) => (h === 'DELIVERY MESSAGE STATUS' ? 'EM Order Shipment Status' : h)),
      rows: [['', 'SO-1', '2026/11/01', 'TO BRIGHTSUN', '2026/11/09', 'old', '9']], allowed: {} };
    const esb = (lastSandbox.__pull as Function)(m, t, 'ESB').updates;
    expect(esb.map((u: { col: number }) => u.col)).toEqual([2, 3]);
    const bs = (lastSandbox.__pull as Function)(m, t, 'BS').updates;
    expect(bs.map((u: { col: number }) => u.col)).toEqual([4]);
    const push = plan(m, t, () => false).updates.map((u: { col: number }) => u.col);
    expect(push).toEqual([0, 5, 6]);
  });

  test('freight, Attention and Sync Status are never pushed, nor copied onto a new row (14:19 regression)', () => {
    loadScript();
    const headers = ['DELIVERY MESSAGE STATUS', 'Doc. No.', 'BALANCE', 'Attention', 'Sync Status', 'SEAFREIGHT', 'TOTAL', 'Supplier Invoice'];
    const m = { labels: headers.map(() => ''), headers, rows: [
      ['Done Shipout', 'SO-1', '10', 'SEAMPIFY', 'SYNCED', '371.98', '0.00', 'INV-OLD'],
      ['Done Shipout', 'SO-2', '20', 'SEAMPIFY', 'SYNCED', '100.00', '0.00', 'INV-X'],
    ] };
    const t = { headers: headers.map((h) => (h === 'DELIVERY MESSAGE STATUS' ? 'EM Order Shipment Status' : h)),
      rows: [['Done Shipout', 'SO-1', '99', '', 'PENDING', '500.00', '812.40', 'INV-NEW']], allowed: {} };
    const p = plan(m, t, () => true);
    expect(p.updates).toEqual([{ row: 0, col: 2, value: '10' }]);
    const appended = p.appends[0] as string[];
    expect(appended[1]).toBe('SO-2');
    expect(appended[2]).toBe('20');
    expect(appended.slice(3)).toEqual(['', '', '', '', '']);
  });
});
