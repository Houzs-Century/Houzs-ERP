import { beforeEach, describe, expect, test, vi } from 'vitest';

/* The IO half of the PO line import: that every read and every write carries the
   company predicate (the service role bypasses RLS, so the predicate IS the
   isolation — R105), that the PO-level date goes through the cascade, and that
   one purchase order queues one AutoCount edit however many of its lines moved. */

const enqueueEdit = vi.fn(async () => true);
const recomputePoExpectedAt = vi.fn(async () => undefined);
vi.mock('../lib/autocount-outbox', () => ({ enqueueEdit: (...a: unknown[]) => enqueueEdit(...(a as [])) }));
vi.mock('./mfg-purchase-orders', () => ({ recomputePoExpectedAt: (...a: unknown[]) => recomputePoExpectedAt(...(a as [])) }));
vi.mock('../lib/pg-supabase-transaction', () => ({ runScmPgCommand: vi.fn() }));
vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const { previewPoLineImport, applyPoLineImport } = await import('./po-line-import');

type Row = Record<string, unknown>;
type Op = { table: string; op: 'select' | 'update' | 'insert'; filters: Array<[string, string, unknown]>; payload?: Row };

function fakeSb(tables: Record<string, Row[]>) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, op: 'select', filters: [] };
    const match = (r: Row) => op.filters.every(([col, kind, v]) => {
      if (kind === 'eq') return String(r[col]) === String(v);
      if (kind === 'neq') return String(r[col]) !== String(v);
      return (v as unknown[]).map(String).includes(String(r[col]));
    });
    const run = () => {
      ops.push(op);
      const rows = (tables[table] ?? []).filter(match);
      if (op.op === 'update') for (const r of rows) Object.assign(r, op.payload);
      if (op.op === 'insert') { (tables[table] ??= []).push(op.payload!); return { data: null, error: null }; }
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      update(p: Row) { op.op = 'update'; op.payload = p; return b; },
      insert(p: Row) { op.op = 'insert'; op.payload = p; return b; },
      eq(c: string, v: unknown) { op.filters.push([c, 'eq', v]); return b; },
      neq(c: string, v: unknown) { op.filters.push([c, 'neq', v]); return b; },
      in(c: string, v: unknown[]) { op.filters.push([c, 'in', v]); return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  const rpc = async () => ({ data: true, error: null });
  return { sb: { from, rpc }, ops, tables };
}

const PO_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PO_X = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const L1 = '11111111-0000-4000-8000-000000000001';
const L2 = '11111111-0000-4000-8000-000000000002';
const LX = '11111111-0000-4000-8000-0000000000ff';

const seed = () => ({
  purchase_orders: [
    { id: PO_A, company_id: 1, po_number: 'PO-000100', revision: 1, status: 'SUBMITTED', supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null },
    { id: PO_X, company_id: 2, po_number: '2990-PO-000001', revision: 1, status: 'SUBMITTED', supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null },
  ],
  purchase_order_items: [
    { id: L1, company_id: 1, purchase_order_id: PO_A, item_code: 'A1', delivery_date: '2026-09-01', description2: 'old', notes: null, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null, qty: 2 },
    { id: L2, company_id: 1, purchase_order_id: PO_A, item_code: 'A2', delivery_date: '2026-09-01', description2: null, notes: null, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null, qty: 1 },
    { id: LX, company_id: 2, purchase_order_id: PO_X, item_code: 'X1', delivery_date: '2026-09-01', description2: null, notes: 'theirs', supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null, qty: 5 },
  ],
  grns: [] as Row[],
  entity_audit_log: [] as Row[],
});

const ctx = { json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }) };

beforeEach(() => { enqueueEdit.mockClear(); recomputePoExpectedAt.mockClear(); });

describe('company scope', () => {
  test('preview reads lines and POs through the company predicate; another company\'s line is named, not read', async () => {
    const { sb, ops } = fakeSb(seed());
    const p = await previewPoLineImport(sb, 1, [
      { rowNumber: 2, lineId: L1, docNo: 'PO-000100', values: { remarks: 'mine' } },
      { rowNumber: 3, lineId: LX, docNo: '2990-PO-000001', values: { remarks: 'overwrite theirs' } },
    ]);
    expect(p.rows.map((r) => r.status)).toEqual(['changes', 'rejected']);
    expect(p.rows[1]).toMatchObject({ code: 'other_company' });
    expect(p.lineChanges.map((c) => c.lineId)).toEqual([L1]);
    const dataReads = ops.filter((o) => o.op === 'select' && (o.table === 'purchase_orders' || o.table === 'purchase_order_items'));
    const unscoped = dataReads.filter((o) => !o.filters.some(([c, k, v]) => c === 'company_id' && k === 'eq' && v === 1));
    /* The ONE unscoped read is the "does this id exist elsewhere" probe, and it asks for ids only. */
    expect(unscoped).toHaveLength(1);
    expect(unscoped[0]!.filters).toEqual([['id', 'in', [LX]]]);
  });

  test('apply refuses a line of another company and writes nothing', async () => {
    const { sb, ops, tables } = fakeSb(seed());
    const res = await applyPoLineImport(ctx, sb, 1, { id: 7, name: 'Tester' }, {
      lineChanges: [{ lineId: LX, docNo: '2990-PO-000001', field: 'remarks', old: 'theirs', new: 'hijack' }],
      poChanges: [],
    });
    expect(res.status).toBe(409);
    expect(ops.some((o) => o.op === 'update')).toBe(false);
    expect(tables.purchase_order_items.find((r) => r.id === LX)!.notes).toBe('theirs');
  });
});

describe('apply', () => {
  test('writes the fields, scoped, audits each line, recomputes expected_at, and queues ONE AutoCount edit for the PO', async () => {
    const { sb, ops, tables } = fakeSb(seed());
    const res = await applyPoLineImport(ctx, sb, 1, { id: 7, name: 'Tester' }, {
      lineChanges: [
        { lineId: L1, docNo: 'PO-000100', field: 'deliveryDate', old: '2026-09-01', new: '2026-09-20' },
        { lineId: L1, docNo: 'PO-000100', field: 'description2', old: 'old', new: 'new text' },
        { lineId: L2, docNo: 'PO-000100', field: 'deliveryDate', old: '2026-09-01', new: '2026-09-22' },
      ],
      poChanges: [],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, linesUpdated: 2, purchaseOrdersUpdated: 1, autocountEditsQueued: 1 });
    const items = tables.purchase_order_items;
    expect(items.find((r) => r.id === L1)).toMatchObject({ delivery_date: '2026-09-20', description2: 'new text', qty: 2 });
    expect(items.find((r) => r.id === L2)).toMatchObject({ delivery_date: '2026-09-22', qty: 1 });
    for (const u of ops.filter((o) => o.op === 'update')) {
      expect(u.filters).toContainEqual(['company_id', 'eq', 1]);
      expect(Object.keys(u.payload!).every((k) => ['delivery_date', 'description2', 'notes'].includes(k))).toBe(true);
    }
    expect(tables.entity_audit_log).toHaveLength(2);
    expect(tables.entity_audit_log[0]).toMatchObject({ entity_type: 'PURCHASE_ORDER', entity_id: PO_A, action: 'UPDATE', company_id: 1 });
    expect(recomputePoExpectedAt).toHaveBeenCalledTimes(1);
    expect(enqueueEdit).toHaveBeenCalledTimes(1);
    expect(enqueueEdit).toHaveBeenCalledWith(sb, { companyId: 1, docType: 'PO', docId: PO_A, createdBy: 7 });
  });

  test('remarks and Description 2 alone queue no AutoCount edit (owner 2026-09-15: an imported Description 2 is not pushed)', async () => {
    const { sb } = fakeSb(seed());
    const res = await applyPoLineImport(ctx, sb, 1, null, {
      lineChanges: [
        { lineId: L1, docNo: 'PO-000100', field: 'remarks', old: null, new: 'chase' },
        { lineId: L1, docNo: 'PO-000100', field: 'description2', old: 'old', new: 'new text' },
      ],
      poChanges: [],
    });
    expect(res.status).toBe(200);
    expect(enqueueEdit).not.toHaveBeenCalled();
  });

  test('a PO-level estimate date sets the header and every line of the PO', async () => {
    const { sb, tables } = fakeSb(seed());
    const res = await applyPoLineImport(ctx, sb, 1, null, {
      lineChanges: [],
      poChanges: [{ poId: PO_A, docNo: 'PO-000100', field: 'estimateDeliveryDate2', old: null, new: '2026-11-01', lineValues: { [L1]: null, [L2]: null } }],
    });
    expect(res.status).toBe(200);
    expect(tables.purchase_orders.find((r) => r.id === PO_A)!.supplier_delivery_date_3).toBe('2026-11-01');
    expect(tables.purchase_order_items.filter((r) => r.purchase_order_id === PO_A).map((r) => r.supplier_delivery_date_3)).toEqual(['2026-11-01', '2026-11-01']);
    expect(tables.purchase_order_items.find((r) => r.id === LX)!.supplier_delivery_date_3).toBeNull();
    expect(tables.entity_audit_log[0]).toMatchObject({ note: 'Imported from file', field_changes: [{ field: 'supplierDeliveryDate3', from: null, to: '2026-11-01' }] });
    /* The write-back sends the estimate dates as header UDFs (#3907), so the PO is queued once. */
    expect(enqueueEdit).toHaveBeenCalledTimes(1);
  });

  test('a value that moved since the preview refuses the whole import with 409 and writes nothing', async () => {
    const data = seed();
    data.purchase_order_items[0]!.delivery_date = '2026-09-05';
    const { sb, ops } = fakeSb(data);
    const res = await applyPoLineImport(ctx, sb, 1, null, {
      lineChanges: [
        { lineId: L2, docNo: 'PO-000100', field: 'remarks', old: null, new: 'fine' },
        { lineId: L1, docNo: 'PO-000100', field: 'deliveryDate', old: '2026-09-01', new: '2026-09-20' },
      ],
      poChanges: [],
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; conflicts: unknown[] };
    expect(body.error).toBe('import_conflict');
    expect(body.conflicts).toHaveLength(1);
    expect(ops.some((o) => o.op === 'update' || o.op === 'insert')).toBe(false);
  });

  test('a PO that gained a Goods Receipt is refused', async () => {
    const data = seed();
    data.grns.push({ id: 'g1', purchase_order_id: PO_A, status: 'POSTED' });
    const { sb } = fakeSb(data);
    const res = await applyPoLineImport(ctx, sb, 1, null, {
      lineChanges: [{ lineId: L1, docNo: 'PO-000100', field: 'remarks', old: null, new: 'x' }],
      poChanges: [],
    });
    expect(res.status).toBe(409);
  });
});
