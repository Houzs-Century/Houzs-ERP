// ----------------------------------------------------------------------------
// A PURCHASE ORDER'S LINES KEEP THE SALES ORDER'S ORDER.
//
// The owner, 2026-09-10, on a purchase order that printed a three-piece sofa
// with the armless module first: 「我们的 Sales Order 都是从 L 到 R（L 在第一，R
// 在最后）」 — and 「照片是根据 line item 的顺序来的」, so the same scramble hits
// the ITEM PHOTOS block on the printed PO, not only the line table.
//
// WHY IT SCRAMBLED. `scm.mfg_sales_order_items` has `line_no`;
// `scm.purchase_order_items` had NO line-order column at all. Every one of a
// converted sofa's PO lines is written by ONE insert, so they share a
// `created_at` to the microsecond (measured on prod for HC-PO-2609-053:
// 2026-09-10 02:53:25.121542+00 on all three rows), and the detail read's
// `.order('created_at')` has nothing left to break the tie with — Postgres
// answers in whatever physical order it likes, and an UPDATE moves a row's
// physical position, so the same document can print two ways on two days.
// Measured on production 2026-09-10: 214 purchase orders carry more than one
// sofa line and 43 of them put an armless piece (1NA / 2NA / CNR) at an end of
// the run, which no sofa can physically be.
//
// WHAT THESE PIN. `line_no` is carried from the SOURCE SO line at PO-line
// BIRTH — the same boundary the owner drew for the sofa handedness rule
// (「只针对新的order生效」, sofaOrderForNewLines.test.ts): the order is decided
// where lines are born and STORED, never recomputed by a display path.
//
// The fake `select()` PROJECTS the requested columns on purpose. Without that
// these tests pass against a convert that never asks the database for
// `line_no` — the fake would hand back the whole row regardless, and the suite
// would be green about a column production never reads.
import { describe, expect, test } from 'vitest';
import { convertSosToPosCore, type PoConvertContext } from './mfg-purchase-orders';

type Row = Record<string, unknown>;

/** Top-level column names of a PostgREST select string. `so:t!inner ( a, b )`
 *  yields its ALIAS (`so`); nested commas are skipped. */
function selectedColumns(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of cols) {
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes(':') ? s.slice(0, s.indexOf(':')) : s).split('(')[0]!.trim())
    .filter((s) => s !== '' && s !== '*');
}

function fakeSb(tables: Record<string, Row[]>, captured: Row[]) {
  /* Across the WHOLE fake, not per insert call: the convert emits one header
     insert per bucket, and a per-call counter would hand every bucket the same
     id — which reads as "one PO" and would hide a per-document assertion. */
  let poSeq = 0;
  class Q {
    rows: Row[];
    private table: string;
    private singleRow = false;
    private projection: string[] | null = null;
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
    select(cols?: string) {
      /* Recorded, applied in result(): a filter may legitimately name a column
         the caller did not select (`.eq('is_main_supplier', true)`), so
         projecting here would empty the read instead of narrowing it. */
      if (typeof cols === 'string' && cols.trim() !== '' && cols.trim() !== '*') {
        this.projection = selectedColumns(cols);
      }
      return this;
    }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    not() { return this; }
    is(col: string, val: unknown) {
      if (val === null) this.rows = this.rows.filter((r) => r[col] == null);
      return this;
    }
    or() { return this; }
    like() { return this; }
    ilike() { return this; }
    gte() { return this; }
    lte() { return this; }
    order(col: string, opts?: { ascending?: boolean }) {
      const asc = opts?.ascending !== false;
      this.rows = [...this.rows].sort((a, b) => {
        const x = a[col] as number | string | null | undefined;
        const y = b[col] as number | string | null | undefined;
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
      return this;
    }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    range() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    update() { return this; }
    delete() { return this; }
    insert(payload: Row | Row[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      if (this.table === 'purchase_order_items') captured.push(...rows);
      if (this.table === 'purchase_orders') {
        this.rows = rows.map((r) => {
          poSeq += 1;
          return { ...r, id: `po-new-${poSeq}`, po_number: r.po_number ?? `PO-2609-${String(poSeq).padStart(3, '0')}` };
        });
      } else {
        this.rows = rows;
      }
      return this;
    }
    private result() {
      const keep = this.projection;
      const rows = keep === null ? this.rows : this.rows.map((r) => {
        const p: Row = {};
        for (const k of keep) if (k in r) p[k] = r[k];
        return p;
      });
      if (this.singleRow) return { data: rows[0] ?? null, error: null as null };
      return { data: rows, error: null as null };
    }
    then<T>(onF: (v: { data: unknown; error: null }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

const SUPPLIER_ID = 'sup-1';
const SO_DOC = 'HC-SO-013503';

/** One SO line as the convert reads it. `line_no` is what these tests are about. */
const soLine = (id: string, itemCode: string, lineNo: number, docNo = SO_DOC): Row => ({
  id,
  doc_no: docNo,
  line_no: lineNo,
  item_code: itemCode,
  description: `${itemCode} description`,
  item_group: 'sofa',
  variants: {},
  qty: 1,
  po_qty_picked: 0,
  unit_price_sen: 100000,
  line_delivery_date: '2026-09-30',
  warehouse_id: 'wh-kl',
  photo_urls: [],
  cancelled: false,
  so: { sales_location: 'KL', customer_delivery_date: '2026-09-30' },
});

/** Runs the real convert; returns the rows it writes to purchase_order_items. */
async function convertAndCapture(
  soLines: Row[],
  opts?: { pickOrder?: string[]; targetPo?: { id: string; existing: Row[] } },
): Promise<Row[]> {
  const captured: Row[] = [];
  const docNos = [...new Set(soLines.map((l) => l.doc_no as string))];
  const target = opts?.targetPo;
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    mfg_sales_orders: docNos.map((doc_no) => ({ doc_no, status: 'CONFIRMED' })),
    warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL' }],
    suppliers: [{ id: SUPPLIER_ID, code: 'SUP1', name: 'Supplier One' }],
    supplier_material_bindings: soLines.map((l) => ({
      item_code: l.item_code,
      material_kind: 'mfg_product',
      supplier_id: SUPPLIER_ID,
      supplier_sku: `SKU-${l.item_code}`,
      unit_price_sen: 50000,
      currency: 'MYR',
      price_matrix: null,
      is_main_supplier: true,
    })),
    fabric_trackings: [],
    mrp_category_lead_times: [],
    sofa_combo_pricing: [],
    purchase_orders: target
      ? [{ id: target.id, status: 'SUBMITTED', supplier_id: SUPPLIER_ID, po_number: 'HC-PO-2609-001', company_id: 1 }]
      : [],
    purchase_order_items: target ? target.existing : [],
  }, captured);

  const order = opts?.pickOrder ?? soLines.map((l) => l.id as string);
  const ctx = {
    req: {
      json: async () => ({
        picks: order.map((id) => ({ soItemId: id, qty: 1 })),
        ...(target ? { targetPoId: target.id } : {}),
      }),
    },
    get: (key: string) => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'user-1' };
      return undefined;
    },
    env: { DB: { prepare: () => { throw new Error('no D1 in this harness'); } } },
    json: (body: unknown, status = 200) => ({ status, body: body as Record<string, unknown> }),
  } as unknown as PoConvertContext;

  const out = await convertSosToPosCore(ctx);
  if (out.status !== 201 && out.status !== 200) {
    throw new Error(`convert refused: ${out.status} ${JSON.stringify(out.body)}`);
  }
  return captured;
}

/* The three modules of the owner's example, HC-SO-013503 -> HC-PO-2609-053.
   The SO holds them at line_no 1 / 4 / 5 (the last two were added two days
   later), with an accessory and a service line at 2 and 3 in between. */
const LHF = soLine('si-lhf', '8030-L(LHF)', 1);
const NA = soLine('si-na', '8030-1NA', 4);
const RHF = soLine('si-rhf', '8030-1A(RHF)', 5);

describe('a converted PO line carries the source SO line order', () => {
  test('line_no is written at all', async () => {
    const rows = await convertAndCapture([LHF, NA, RHF]);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.line_no, `${r.item_code} has no line_no`).toEqual(expect.any(Number));
  });

  test('L leads and R closes even when the picks arrive scrambled', async () => {
    /* The MRP picker groups by item, not by document, so the pick array is NOT
       in SO line order. The PO must still read L -> armless -> R. */
    const rows = await convertAndCapture([LHF, NA, RHF], { pickOrder: ['si-na', 'si-rhf', 'si-lhf'] });
    const printed = [...rows].sort((a, b) => (a.line_no as number) - (b.line_no as number));
    expect(printed.map((r) => r.item_code)).toEqual(['8030-L(LHF)', '8030-1NA', '8030-1A(RHF)']);
  });

  test('the numbers are dense and 1-based, not the SO’s own gaps', async () => {
    /* The SO holds these at 1, 4, 5. The PO has three lines, so it numbers them
       1, 2, 3 — its own order, derived from the SO's, never a copy of it (two
       source SOs would otherwise collide on one number). */
    const rows = await convertAndCapture([LHF, NA, RHF], { pickOrder: ['si-rhf', 'si-lhf', 'si-na'] });
    expect([...rows].map((r) => r.line_no).sort((a, b) => (a as number) - (b as number))).toEqual([1, 2, 3]);
  });

  test('two sales orders of sofa become two POs, each numbered from 1 in ITS order', async () => {
    /* po-grouping.ts splits sofa per SO (the dye-lot rule), so this convert
       emits two documents. Each is numbered independently — line_no is a
       position ON A DOCUMENT, never a global sequence. */
    const other = [
      soLine('sj-lhf', '9058-1A(LHF)', 1, 'HC-SO-013900'),
      soLine('sj-rhf', '9058-1A(RHF)', 2, 'HC-SO-013900'),
    ];
    const rows = await convertAndCapture([LHF, NA, RHF, ...other], {
      pickOrder: ['sj-rhf', 'si-na', 'sj-lhf', 'si-rhf', 'si-lhf'],
    });
    const byPo = new Map<unknown, Row[]>();
    for (const r of rows) {
      const a = byPo.get(r.purchase_order_id) ?? [];
      a.push(r);
      byPo.set(r.purchase_order_id, a);
    }
    expect(byPo.size).toBe(2);
    const printed = [...byPo.values()].map((lines) =>
      [...lines].sort((a, b) => (a.line_no as number) - (b.line_no as number)).map((r) => r.item_code));
    expect(printed).toContainEqual(['8030-L(LHF)', '8030-1NA', '8030-1A(RHF)']);
    expect(printed).toContainEqual(['9058-1A(LHF)', '9058-1A(RHF)']);
  });

  test('a MERGED PO keeps each sales order together, in document order', async () => {
    /* Accessories are a category the owner did not rule on, so they follow the
       caller's toggle and default to one PO per (warehouse, supplier) — several
       SOs on one document. The sort is (SO doc_no, SO line_no), so the merged
       document reads one sales order at a time rather than interleaving them. */
    const acc = (id: string, code: string, lineNo: number, doc: string): Row =>
      ({ ...soLine(id, code, lineNo, doc), item_group: 'accessory' });
    const rows = await convertAndCapture([
      acc('b-2', 'LONG PILLOW', 2, 'HC-SO-013900'),
      acc('a-1', 'AMN-SOFA PILLOW', 1, 'HC-SO-013503'),
      acc('b-1', 'SOFA LEG', 1, 'HC-SO-013900'),
      acc('a-2', 'LONG PILLOW', 7, 'HC-SO-013503'),
    ], { pickOrder: ['b-2', 'a-1', 'b-1', 'a-2'] });
    expect(new Set(rows.map((r) => r.purchase_order_id)).size).toBe(1);
    const printed = [...rows].sort((a, b) => (a.line_no as number) - (b.line_no as number));
    expect(printed.map((r) => [r.item_code, r.line_no])).toEqual([
      ['AMN-SOFA PILLOW', 1],
      ['LONG PILLOW', 2],
      ['SOFA LEG', 3],
      ['LONG PILLOW', 4],
    ]);
  });

  test('appending to an existing PO continues after its highest line_no', async () => {
    const rows = await convertAndCapture([NA, RHF], {
      pickOrder: ['si-rhf', 'si-na'],
      targetPo: {
        id: 'po-existing',
        existing: [
          { id: 'pi-1', purchase_order_id: 'po-existing', item_code: '8030-L(LHF)', line_no: 1, company_id: 1 },
        ],
      },
    });
    const printed = [...rows].sort((a, b) => (a.line_no as number) - (b.line_no as number));
    expect(printed.map((r) => [r.item_code, r.line_no])).toEqual([
      ['8030-1NA', 2],
      ['8030-1A(RHF)', 3],
    ]);
  });

  test('appending to a PO whose lines predate the column starts at 1', async () => {
    /* Historical POs the migration could not derive keep line_no NULL, and the
       read puts NULLs FIRST — so a line appended to one takes 1 and lands
       AFTER them, which is where an appended line belongs. */
    const rows = await convertAndCapture([RHF], {
      targetPo: {
        id: 'po-existing',
        existing: [
          { id: 'pi-1', purchase_order_id: 'po-existing', item_code: '8030-L(LHF)', line_no: null, company_id: 1 },
          { id: 'pi-2', purchase_order_id: 'po-existing', item_code: '8030-1NA', line_no: null, company_id: 1 },
        ],
      },
    });
    expect(rows.map((r) => r.line_no)).toEqual([1]);
  });
});
