// Owner 2026-11-10: "2990 - for dining remark 需要带进 PO remark - 给 Supplier mention."
// A DINING order's remarks must reach the SUPPLIER on the purchase order:
//   · the SO header NOTE  -> the PO header "Remarks:" block (below the provenance
//     line, so parseProvenanceNote still reads the same source SOs);
//   · each DINING line's own `remark` -> that PO line's "Remark:".
// Scope (owner): DINING category only, BOTH companies.
//
// These drive the REAL convert body (convertSosToPosCore, the same function the
// /from-sos route and the Procurement Agent both call) through a minimal fake
// PostgREST client — the same harness shape as mfg-purchase-orders.photo-carry
// .test.ts — and assert on the header AND line rows it writes.
import { describe, expect, test } from 'vitest';
import { convertSosToPosCore, type PoConvertContext } from './mfg-purchase-orders';
import { parsePgrestInList } from '../lib/pgrest-in-list';
import { provenanceNote, parseProvenanceNote } from '../shared/transfer-vocabulary';

type Row = Record<string, unknown>;

/* Captures the header rows (purchase_orders) AND the line rows
   (purchase_order_items) the convert writes; every other write is accepted and
   ignored so the convert runs to completion without the fake modelling the
   whole schema. */
function fakeSb(tables: Record<string, Row[]>, headers: Row[], lines: Row[]) {
  class Q {
    rows: Row[];
    private table: string;
    private singleRow = false;
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    filter(col: string, op: string, val: string) {
      if (op !== 'in') throw new Error(`fake: filter(${op}) is not implemented`);
      return this.in(col, parsePgrestInList(val));
    }
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
    order() { return this; }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    range() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    update() { return this; }
    delete() { return this; }
    insert(payload: Row | Row[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      if (this.table === 'purchase_order_items') lines.push(...rows);
      if (this.table === 'purchase_orders') {
        headers.push(...rows);
        this.rows = rows.map((r, i) => ({ ...r, id: `po-new-${i + 1}`, po_number: r.po_number ?? 'PO-2611-001' }));
      } else {
        this.rows = rows;
      }
      return this;
    }
    private result() {
      if (this.singleRow) return { data: this.rows[0] ?? null, error: null as null };
      return { data: this.rows, error: null as null };
    }
    then<T>(onF: (v: { data: unknown; error: null }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

const SUPPLIER_ID = 'sup-1';

/** One SO line as the convert reads it. `remark` is the line's own note; the SO
 *  header's `note` rides on the embedded `so` object, exactly as PostgREST
 *  returns the `!inner` join. */
const soLine = (o: {
  id: string; doc_no?: string; itemCode?: string; group?: string;
  remark?: string | null; note?: string | null;
}): Row => {
  const itemCode = o.itemCode ?? 'DINING-CHAIR';
  return {
    id: o.id,
    doc_no: o.doc_no ?? 'SO-2611-028',
    item_code: itemCode,
    description: `${itemCode} description`,
    item_group: o.group ?? 'DINING',
    variants: {},
    qty: 1,
    po_qty_picked: 0,
    unit_price_sen: 100000,
    line_delivery_date: '2026-11-23',
    warehouse_id: 'wh-kl',
    photo_urls: null,
    remark: o.remark ?? null,
    so: { sales_location: 'KL', customer_delivery_date: '2026-11-23', note: o.note ?? null },
  };
};

/** Runs the real convert; returns the captured PO header rows and line rows. */
async function convertAndCapture(soLines: Row[]): Promise<{ headers: Row[]; lines: Row[] }> {
  const headers: Row[] = [];
  const lines: Row[] = [];
  const docNos = [...new Set(soLines.map((l) => l.doc_no as string))];
  const bindings = [...new Map(soLines.map((l) => [l.item_code, {
    item_code: l.item_code,
    material_kind: 'mfg_product',
    supplier_id: SUPPLIER_ID,
    supplier_sku: `SKU-${l.item_code}`,
    unit_price_sen: 50000,
    currency: 'MYR',
    price_matrix: null,
    is_main_supplier: true,
  }])).values()];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    // CONFIRMED — anything else is refused by the orderable gate before the map.
    mfg_sales_orders: docNos.map((d) => ({ doc_no: d, status: 'CONFIRMED' })),
    warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL' }],
    suppliers: [{ id: SUPPLIER_ID, code: 'SUP1', name: 'Supplier One' }],
    supplier_material_bindings: bindings,
    fabric_trackings: [],
    mrp_category_lead_times: [],
    sofa_combo_pricing: [],
    purchase_orders: [],
    purchase_order_items: [],
  }, headers, lines);

  const ctx = {
    req: { json: async () => ({ picks: soLines.map((l) => ({ soItemId: l.id, qty: 1 })) }) },
    get: (key: string) => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'user-1' };
      return undefined;
    },
    env: { DB: { prepare: () => { throw new Error('no D1 in this harness'); } } },
    json: (body: unknown, status = 200) => ({ status, body: body as Record<string, unknown> }),
  } as unknown as PoConvertContext;

  const out = await convertSosToPosCore(ctx);
  if (out.status !== 201) {
    throw new Error(`convert refused: ${out.status} ${JSON.stringify(out.body)}`);
  }
  return { headers, lines };
}

describe('SO -> PO carries a DINING order’s remarks to the supplier', () => {
  test('the SO header NOTE rides into the PO header, below the provenance line', async () => {
    const { headers, lines } = await convertAndCapture([
      soLine({ id: 'si-1', note: 'Prefer delivery at monday', remark: 'Wrap legs in foam' }),
    ]);
    expect(headers).toHaveLength(1);
    // Provenance stays line 1 (the stored contract), the customer note below it.
    expect(headers[0].notes).toBe(`${provenanceNote('so', ['SO-2611-028'])}\nPrefer delivery at monday`);
    // ...and the provenance is still machine-readable — its 8 readers see the SO.
    expect(parseProvenanceNote(headers[0].notes as string)).toEqual(['SO-2611-028']);
    // The line's own remark reaches the PO line (prints as "Remark:").
    expect(lines).toHaveLength(1);
    expect(lines[0].notes).toBe('Wrap legs in foam');
  });

  test('a single-source PO prints the note unlabelled; multi-source labels each by SO', async () => {
    const { headers } = await convertAndCapture([
      soLine({ id: 'si-1', doc_no: 'SO-2611-028', itemCode: 'DINING-CHAIR', note: 'Deliver Monday' }),
      soLine({ id: 'si-2', doc_no: 'SO-2611-024', itemCode: 'DINING-TABLE', note: 'Call before arrival' }),
    ]);
    // Both dining lines (same supplier + warehouse) merge into ONE PO.
    expect(headers).toHaveLength(1);
    expect(headers[0].notes).toBe(
      `${provenanceNote('so', ['SO-2611-028', 'SO-2611-024'])}\n`
      + 'SO-2611-028: Deliver Monday\nSO-2611-024: Call before arrival',
    );
  });

  test('a NON-dining order carries neither remark — scope is DINING only', async () => {
    const { headers, lines } = await convertAndCapture([
      soLine({ id: 'si-1', group: 'SOFA', itemCode: 'SOFA-A', note: 'Prefer delivery at monday', remark: 'Handle with care' }),
    ]);
    expect(headers).toHaveLength(1);
    expect(headers[0].notes).toBe(provenanceNote('so', ['SO-2611-028']));
    expect(lines[0].notes).toBeNull();
  });

  test('a dining order with no remarks writes the bare provenance note and a null line note', async () => {
    const { headers, lines } = await convertAndCapture([
      soLine({ id: 'si-1', note: null, remark: null }),
    ]);
    expect(headers[0].notes).toBe(provenanceNote('so', ['SO-2611-028']));
    expect(lines[0].notes).toBeNull();
  });

  test('a dining line with only a line remark (no header note) still carries the line remark', async () => {
    const { headers, lines } = await convertAndCapture([
      soLine({ id: 'si-1', note: null, remark: 'Assemble on site' }),
    ]);
    expect(headers[0].notes).toBe(provenanceNote('so', ['SO-2611-028']));
    expect(lines[0].notes).toBe('Assemble on site');
  });
});
