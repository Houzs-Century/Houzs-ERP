/* The server-callable PO->GRN convert core (createDraftGrnsFromPoItemsCore).
 *
 * SLICE 2 of "scan supplier document -> convert to GR": the multi-select
 * PO->GRN conversion was lifted out of createGrnsFromPoItemsHandler so the OCR
 * scan queue can raise the SAME draft with no Hono request. These cases drive
 * the core directly through a synthetic context + a fake PostgREST client — the
 * same shape the SO->PO core (convertSosToPosCore) is tested with in
 * companyScopeProcurementFinance.test.ts.
 *
 * WHAT THEY PIN, all money/stock-critical:
 *   1. it creates a DRAFT — status DRAFT, no posted_at, and NO stock movement
 *      (the core never calls postGrnAndRollup);
 *   2. it links the source PO (grns.purchase_order_id + each line's
 *      purchase_order_item_id) so the receipt can roll up when it is posted;
 *   3. it folds TWO POs from one supplier into ONE GRN (the multi-PO capability
 *      the handler had, kept intact);
 *   4. it refuses over-receive and a cross-company pick exactly as the handler
 *      did (same error codes / statuses), writing nothing.
 */
import { describe, expect, test } from 'vitest';
import { createDraftGrnsFromPoItemsCore } from '../src/scm/lib/grn-from-po-core';
import { parsePgrestInList } from '../src/scm/lib/pgrest-in-list';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — the create path reaches far past the
   statement being asserted (doc-no mint, fx, audit probe, over-receipt re-sum,
   header-total recompute), so every builder method chains and an unknown table
   reads as empty. Two things beyond the companyScope harness: grns inserts get a
   generated id (the real column is DB-default) and default status DRAFT (the
   core never sets status — it relies on that default). */
let grnSeq = 0;
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string, private log: string[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    const rows = Array.isArray(p) ? p : [p];
    this.inserted = rows.map((r) => {
      if (this.table === 'grns') {
        grnSeq += 1;
        return { id: r.id ?? `grn_${grnSeq}`, status: r.status ?? 'DRAFT', ...r };
      }
      return { ...r };
    });
    return this;
  }
  eq(col: string, val: unknown) {
    this.log.push(`${this.table}.${this.op}:eq:${col}`);
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  filter(col: string, op: string, val: string) {
    if (op !== 'in') throw new Error(`fake: filter(${op}) is not implemented`);
    return this.in(col, parsePgrestInList(val));
  }
  gte() { return this; }
  lte() { return this; }
  gt() { return this; }
  lt() { return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/* Synthetic context — the exact shape the headless entry builds and the HTTP
   handler wires from its real Hono context. companyId is the isolation boundary;
   allowedCompanyIds stays undefined (single active company, like the SO->PO
   core's runCore). rpc answers `true`, which the doc-no counter reads as suffix
   1 and the audit pre-flight reads as writable. */
const runCore = (tables: Record<string, Row[]>, companyId: number | undefined, body: unknown) => {
  const log: string[] = [];
  const sb = {
    from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
    rpc: async () => ({ data: true, error: null }),
  };
  const get = (key: string): unknown => {
    if (key === 'supabase') return sb;
    if (key === 'user') return { id: 'u1' };
    if (key === 'companyId') return companyId;
    if (key === 'allowedCompanyIds') return undefined;
    if (key === 'companyCode') return companyId === CO_B ? '2990' : 'HOUZS';
    return undefined;
  };
  return createDraftGrnsFromPoItemsCore({
    req: { json: async () => body },
    get: get as never,
  });
};

/* Two POs, same supplier (s1), in company A; one PO in company B (s9). */
const poItems = (): Row[] => [
  {
    id: 'poi-a', purchase_order_id: 'po-a', company_id: CO_A, qty: 5, received_qty: 0,
    item_code: 'M1', material_name: 'Mat 1', material_kind: 'mfg_product', unit_price_sen: 100, discount_sen: 0,
    po: { id: 'po-a', po_number: 'HC-PO-2608-001', supplier_id: 's1', status: 'SUBMITTED', purchase_location_id: 'wh1', currency: 'MYR' },
  },
  {
    id: 'poi-c', purchase_order_id: 'po-c', company_id: CO_A, qty: 4, received_qty: 0,
    item_code: 'M3', material_name: 'Mat 3', material_kind: 'mfg_product', unit_price_sen: 200, discount_sen: 0,
    po: { id: 'po-c', po_number: 'HC-PO-2608-002', supplier_id: 's1', status: 'SUBMITTED', purchase_location_id: 'wh1', currency: 'MYR' },
  },
  {
    id: 'poi-b', purchase_order_id: 'po-b', company_id: CO_B, qty: 5, received_qty: 0,
    item_code: 'M9', material_name: 'Mat 9', material_kind: 'mfg_product', unit_price_sen: 100, discount_sen: 0,
    po: { id: 'po-b', po_number: '2990-PO-2608-001', supplier_id: 's9', status: 'SUBMITTED', purchase_location_id: 'wh9', currency: 'MYR' },
  },
];

const tables = (): Record<string, Row[]> => ({
  purchase_order_items: poItems(), grns: [], grn_items: [], inventory_movements: [],
});

describe('createDraftGrnsFromPoItemsCore — creates a DRAFT, never posts stock', () => {
  test('one pick -> one DRAFT GRN, linked to its PO, with the money rolled up and NO stock movement', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, { picks: [{ poItemId: 'poi-a', qty: 3 }] });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.overReceipt).toBeNull();
    expect(res.created).toHaveLength(1);

    // The GRN row is a DRAFT: status DRAFT, and never flipped to POSTED.
    expect(t.grns).toHaveLength(1);
    const grn = t.grns[0]!;
    expect(grn.status).toBe('DRAFT');
    expect(grn.status).not.toBe('POSTED');
    expect(grn.posted_at).toBeUndefined();
    // Linked to the source PO so its outstanding clears when the draft is posted.
    expect(grn.purchase_order_id).toBe('po-a');
    // Header money rolled up from the lines (qty 3 * 100 sen), proving recompute ran.
    expect(grn.total_sen).toBe(300);

    // The line links the PO line and carries the received qty.
    expect(t.grn_items).toHaveLength(1);
    expect(t.grn_items[0]!.purchase_order_item_id).toBe('poi-a');
    expect(t.grn_items[0]!.qty_accepted).toBe(3);

    // DRAFT-ONLY: the core never called postGrnAndRollup, so NO stock moved.
    expect(t.inventory_movements).toHaveLength(0);

    // The returned handle names the draft + all its source POs.
    expect(res.created[0]!.grnNumber).toBe(grn.grn_number);
    expect(res.created[0]!.primaryPoId).toBe('po-a');
    expect(res.created[0]!.poIds).toEqual(['po-a']);
    expect(res.created[0]!.lineCount).toBe(1);
  });

  test('two POs from ONE supplier fold into ONE GRN (multi-PO capability intact)', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, {
      picks: [{ poItemId: 'poi-a', qty: 2 }, { poItemId: 'poi-c', qty: 1 }],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ONE supplier -> ONE GRN, even though the lines came from two POs.
    expect(res.created).toHaveLength(1);
    expect(t.grns).toHaveLength(1);
    expect(t.grns[0]!.status).toBe('DRAFT');

    // Both PO lines are on that single GRN, each keeping its own PO link.
    expect(t.grn_items).toHaveLength(2);
    expect(new Set(t.grn_items.map((r) => r.purchase_order_item_id))).toEqual(new Set(['poi-a', 'poi-c']));

    // The draft names BOTH source POs (so the AutoCount PO->GR transfer can too).
    expect(new Set(res.created[0]!.poIds)).toEqual(new Set(['po-a', 'po-c']));
    expect(new Set(res.created[0]!.poNumbers)).toEqual(new Set(['HC-PO-2608-001', 'HC-PO-2608-002']));
    expect(res.created[0]!.lineCount).toBe(2);

    // Still no stock movement — draft only.
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('refuses over-receive with 409 qty_exceeds_remaining, writing nothing', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, { picks: [{ poItemId: 'poi-a', qty: 9 }] }); // remaining is 5

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('qty_exceeds_remaining');
    expect(res.body.remaining).toBe(5);
    // Nothing was written — no GRN, no line, no stock.
    expect(t.grns).toHaveLength(0);
    expect(t.grn_items).toHaveLength(0);
    expect(t.inventory_movements).toHaveLength(0);
  });

  test("a cross-company PO line is not visible — item_not_found, no GRN created", async () => {
    const t = tables();
    // Company A cannot see company B's poi-b (the scoped source read misses it).
    const res = await runCore(t, CO_A, { picks: [{ poItemId: 'poi-b', qty: 1 }] });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('item_not_found');
    expect(t.grns).toHaveLength(0);
  });

  test('the source read carries the company predicate (service-role bypasses RLS)', async () => {
    const t = tables();
    const log: string[] = [];
    const sb = {
      from: (tbl: string) => new FakeQuery((t[tbl] ||= []), tbl, log),
      rpc: async () => ({ data: true, error: null }),
    };
    const get = (key: string): unknown => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'u1' };
      if (key === 'companyId') return CO_A;
      if (key === 'companyCode') return 'HOUZS';
      return undefined;
    };
    await createDraftGrnsFromPoItemsCore({ req: { json: async () => ({ picks: [{ poItemId: 'poi-a', qty: 0 }] }) }, get: get as never });
    expect(log).toContain('purchase_order_items.select:eq:company_id');
  });

  test('the DRAFT it created carries NO CREATE audit row — the caller records that at its own final moment', async () => {
    const t = tables();
    (t as Record<string, Row[]>).entity_audit_log = [];
    const res = await runCore(t, CO_A, { picks: [{ poItemId: 'poi-a', qty: 1 }] });
    expect(res.ok).toBe(true);
    // The core leaves recordGrnCreate to the caller (the HTTP handler records it
    // AFTER the post clears; the scan queue records it right after this returns),
    // so a bucket a later post rolls back never leaves an orphan CREATE row.
    expect((t as Record<string, Row[]>).entity_audit_log).toHaveLength(0);
  });
});
