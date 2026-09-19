/* The server-callable GRN->PI convert core (createDraftPisFromGrnItemsCore).
 *
 * SLICE 4 of "scan supplier document -> convert to Purchase Invoice": the
 * multi-select GRN->PI conversion was lifted out of
 * createPurchaseInvoicesFromGrnItemsHandler so the OCR scan queue can raise the
 * SAME draft with no Hono request. These cases drive the core directly through a
 * synthetic context + a fake PostgREST client — the exact MIRROR of
 * grnFromPoItemsCore.test.ts (PR #4146).
 *
 * WHAT THEY PIN, all money-critical:
 *   1. it creates a DRAFT — status DRAFT, no posted_at, and it consumes NO GRN
 *      qty (the core never flips to POSTED and never calls recomputeGrnInvoiced),
 *      so it books no AP;
 *   2. it links the source GRN (purchase_invoices.grn_id + each line's
 *      grn_item_id) so the receipt's outstanding clears when the PI is posted;
 *   3. it folds TWO GRNs from one supplier into ONE PI (the multi-GRN capability
 *      the handler had, kept intact);
 *   4. it refuses over-invoice and a cross-company pick exactly as the handler
 *      did (same error codes / statuses), writing nothing;
 *   5. the source read carries the company predicate, and the core writes NO
 *      CREATE audit row (the caller records that at its own final moment).
 */
import { describe, expect, test } from 'vitest';
import { createDraftPisFromGrnItemsCore } from '../src/scm/routes/purchase-invoices';
import { parsePgrestInList } from '../src/scm/lib/pgrest-in-list';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — the create path reaches far past the
   statement being asserted (doc-no mint, po-price snapshot, over-invoice re-sum),
   so every builder method chains and an unknown table reads as empty. Two things
   beyond the plain harness: purchase_invoices inserts get a generated id (the real
   column is DB-default) and keep the status the core stamps (DRAFT). */
let piSeq = 0;
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
      if (this.table === 'purchase_invoices') {
        piSeq += 1;
        return { id: r.id ?? `pi_${piSeq}`, ...r };
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
   allowedCompanyIds stays undefined (single active company). rpc answers `true`,
   which the doc-no counter reads as suffix 1. */
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
  return createDraftPisFromGrnItemsCore({
    req: { json: async () => body },
    get: get as never,
  });
};

/* A billable GRN LINE. grn is the !inner-embedded parent: POSTED + not held so
   grnNotBillableRefusal passes, MYR/rate-1 so the FX bucket key is stable. */
const grnLine = (over: Partial<Row> & { grn?: Partial<Row> } = {}): Row => ({
  id: 'gi-a', grn_id: 'grn-a', company_id: CO_A, qty_accepted: 5, invoiced_qty: 0, returned_qty: 0,
  material_kind: 'mfg_product', item_code: 'M1', material_name: 'Mat 1', item_group: null,
  description: null, description2: null, uom: 'UNIT', unit_price_sen: 100, discount_sen: 0,
  variants: null, gap_inches: null, divan_height_inches: null, divan_price_sen: 0,
  leg_height_inches: null, leg_price_sen: 0, custom_specials: null, line_suffix: null,
  special_order_price_sen: 0, purchase_order_item_id: null,
  ...over,
  grn: {
    id: 'grn-a', grn_number: 'HC-GRN-2608-001', supplier_id: 's1', purchase_order_id: 'po-a',
    status: 'POSTED', on_hold: false, currency: 'MYR', exchange_rate: 1, migrated_no_stock: false, company_id: CO_A,
    ...(over.grn ?? {}),
  },
});

/* Two GRNs, same supplier (s1), in company A; one GRN in company B (s9). */
const grnLines = (): Row[] => [
  grnLine({ id: 'gi-a', grn_id: 'grn-a', unit_price_sen: 100,
    grn: { id: 'grn-a', grn_number: 'HC-GRN-2608-001', supplier_id: 's1', purchase_order_id: 'po-a', status: 'POSTED', on_hold: false, currency: 'MYR', exchange_rate: 1, migrated_no_stock: false, company_id: CO_A } }),
  grnLine({ id: 'gi-c', grn_id: 'grn-c', qty_accepted: 4, unit_price_sen: 200,
    grn: { id: 'grn-c', grn_number: 'HC-GRN-2608-002', supplier_id: 's1', purchase_order_id: 'po-c', status: 'POSTED', on_hold: false, currency: 'MYR', exchange_rate: 1, migrated_no_stock: false, company_id: CO_A } }),
  grnLine({ id: 'gi-b', grn_id: 'grn-b', company_id: CO_B, unit_price_sen: 100,
    grn: { id: 'grn-b', grn_number: '2990-GRN-2608-001', supplier_id: 's9', purchase_order_id: 'po-b', status: 'POSTED', on_hold: false, currency: 'MYR', exchange_rate: 1, migrated_no_stock: false, company_id: CO_B } }),
];

const tables = (): Record<string, Row[]> => ({
  grn_items: grnLines(), purchase_invoices: [], purchase_invoice_items: [],
  inventory_movements: [], entity_audit_log: [],
});

describe('createDraftPisFromGrnItemsCore — creates a DRAFT, never books AP', () => {
  test('one pick -> one DRAFT PI, linked to its GRN, money rolled up, GRN NOT consumed', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, { picks: [{ grnItemId: 'gi-a', qty: 3 }] });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toHaveLength(1);

    // The PI row is a DRAFT: status DRAFT, posted_at null — never flipped to POSTED.
    expect(t.purchase_invoices).toHaveLength(1);
    const pi = t.purchase_invoices[0]!;
    expect(pi.status).toBe('DRAFT');
    expect(pi.status).not.toBe('POSTED');
    expect(pi.posted_at).toBeNull();
    // Linked to the source GRN so its outstanding clears when the draft is posted.
    expect(pi.grn_id).toBe('grn-a');
    expect(pi.purchase_order_id).toBe('po-a');
    // Header money rolled up from the line (qty 3 * 100 sen), no tax.
    expect(pi.subtotal_sen).toBe(300);
    expect(pi.total_sen).toBe(300);

    // The line links the GRN line and carries the billed qty + clamped total.
    expect(t.purchase_invoice_items).toHaveLength(1);
    expect(t.purchase_invoice_items[0]!.grn_item_id).toBe('gi-a');
    expect(t.purchase_invoice_items[0]!.qty).toBe(3);
    expect(t.purchase_invoice_items[0]!.line_total_sen).toBe(300);

    // DRAFT-ONLY: the core never called recomputeGrnInvoiced, so the GRN line's
    // invoiced_qty is UNTOUCHED — a draft consumes nothing until it is posted.
    expect(t.grn_items.find((r) => r.id === 'gi-a')!.invoiced_qty).toBe(0);

    // The returned handle names the draft + all its source GRNs + lines.
    expect(res.created[0]!.invoiceNumber).toBe(pi.invoice_number);
    expect(res.created[0]!.supplierId).toBe('s1');
    expect(res.created[0]!.grnIds).toEqual(['grn-a']);
    expect(res.created[0]!.grnNumbers).toEqual(['HC-GRN-2608-001']);
    expect(res.created[0]!.grnItemIds).toEqual(['gi-a']);
    expect(res.created[0]!.lineCount).toBe(1);
  });

  test('two GRNs from ONE supplier fold into ONE PI (multi-GRN capability intact)', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, {
      picks: [{ grnItemId: 'gi-a', qty: 2 }, { grnItemId: 'gi-c', qty: 1 }],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ONE supplier -> ONE PI, even though the lines came from two GRNs.
    expect(res.created).toHaveLength(1);
    expect(t.purchase_invoices).toHaveLength(1);
    expect(t.purchase_invoices[0]!.status).toBe('DRAFT');

    // Both GRN lines are on that single PI, each keeping its own GRN link.
    expect(t.purchase_invoice_items).toHaveLength(2);
    expect(new Set(t.purchase_invoice_items.map((r) => r.grn_item_id))).toEqual(new Set(['gi-a', 'gi-c']));

    // The draft names BOTH source GRNs (so the AutoCount gr_to_pi transfer can too).
    expect(new Set(res.created[0]!.grnIds)).toEqual(new Set(['grn-a', 'grn-c']));
    expect(new Set(res.created[0]!.grnNumbers)).toEqual(new Set(['HC-GRN-2608-001', 'HC-GRN-2608-002']));
    expect(new Set(res.created[0]!.grnItemIds)).toEqual(new Set(['gi-a', 'gi-c']));
    expect(res.created[0]!.lineCount).toBe(2);

    // Neither GRN line was consumed — draft only.
    expect(t.grn_items.find((r) => r.id === 'gi-a')!.invoiced_qty).toBe(0);
    expect(t.grn_items.find((r) => r.id === 'gi-c')!.invoiced_qty).toBe(0);
  });

  test('refuses over-invoice with 409 qty_exceeds_remaining, writing nothing', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, { picks: [{ grnItemId: 'gi-a', qty: 9 }] }); // remaining is 5

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('qty_exceeds_remaining');
    expect(res.body.remaining).toBe(5);
    // Nothing was written — no PI, no line.
    expect(t.purchase_invoices).toHaveLength(0);
    expect(t.purchase_invoice_items).toHaveLength(0);
  });

  test('a cross-company GRN line is not visible — item_not_found, no PI created', async () => {
    const t = tables();
    // Company A cannot see company B's gi-b (the scoped source read misses it).
    const res = await runCore(t, CO_A, { picks: [{ grnItemId: 'gi-b', qty: 1 }] });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('item_not_found');
    expect(t.purchase_invoices).toHaveLength(0);
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
    await createDraftPisFromGrnItemsCore({ req: { json: async () => ({ picks: [{ grnItemId: 'gi-a', qty: 0 }] }) }, get: get as never });
    expect(log).toContain('grn_items.select:eq:company_id');
  });

  test('the DRAFT it created carries NO CREATE audit row — the caller records that at its own final moment', async () => {
    const t = tables();
    const res = await runCore(t, CO_A, { picks: [{ grnItemId: 'gi-a', qty: 1 }] });
    expect(res.ok).toBe(true);
    // The core leaves recordPiCreate to the caller (the HTTP handler records it
    // AFTER it flips the draft to POSTED; the scan queue records it right after
    // this returns), so the core writes nothing to the audit log.
    expect(t.entity_audit_log).toHaveLength(0);
  });
});
