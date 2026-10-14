// HC-0006 T8: a field the operator corrected once comes back corrected on the
// next scan of the same handwriting. The model is mocked: it misreads the slip
// the same way both times (temperature 0), so only the alias table can fix it.
import { describe, expect, test, vi } from 'vitest';
import { noteScanDraftAccepted } from './scan-sample-review';
import { readSlipWithAliases, slipAliasPairs } from './scan-field-aliases';

type Row = Record<string, any>;

/* PostgREST stand-in: select/eq/not/or/limit/order/update/upsert. */
function fakeDb(tables: Record<string, Row[]>) {
  class Q {
    private preds: Array<(r: Row) => boolean> = [];
    private op: 'select' | 'update' | 'upsert' = 'select';
    private patch: Row | Row[] = {};
    private conflict: string[] = [];
    constructor(private table: string) {}
    private get rows() { return (tables[this.table] ||= []); }
    select() { return this; }
    order() { return this; }
    limit() { return this; }
    update(p: Row) { this.op = 'update'; this.patch = p; return this; }
    upsert(p: Row[], o: { onConflict: string }) { this.op = 'upsert'; this.patch = p; this.conflict = o.onConflict.split(','); return this; }
    eq(c: string, v: unknown) { this.preds.push((r) => String(r[c]) === String(v)); return this; }
    not(c: string, op: string, v: unknown) {
      if (op === 'is' && v === null) this.preds.push((r) => r[c] != null);
      else if (op === 'in') {
        const list = String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
        this.preds.push((r) => !list.includes(String(r[c])));
      }
      return this;
    }
    or() { this.preds.push((r) => r.source == null || r.source !== 'automation'); return this; }
    private run(): Row[] {
      if (this.op === 'upsert') {
        for (const p of this.patch as Row[]) {
          const hit = this.rows.find((r) => this.conflict.every((k) => r[k] === p[k]));
          if (hit) Object.assign(hit, p); else this.rows.push({ ...p });
        }
        return [];
      }
      const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
      return hit;
    }
    maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
    then(res: (v: any) => any, rej?: (e: any) => any) {
      return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
    }
  }
  return { from: (t: string) => new Q(t) } as never;
}

const DOC = 'SO-2610-001';
const COMPANY = 1;

/** What the model reads off the slip, every time. */
const modelRead = (): Row => ({
  customerName: 'Tan Ah Kow',
  phones: ['012-777 8880'],
  addressLine1: '12 Jalan Mawar', city: 'Skudai', postcode: '81300',
  addressStateMatch: { value: 'Johor', confidence: 0.9, reason: 'read' },
  customerSoRef: null, depositRm: null, deliveryDate: null, approvalCode: null,
  paymentMethodMatch: null, customerTypeMatch: null, buildingTypeMatch: null, bankMatch: null,
  lines: [{
    rawText: 'Bamboo  cruise K', qtyGuess: 1,
    skuMatch: { code: 'BC-K', confidence: 0.7, reason: 'catalog keyword' },
    fabricMatch: null, specialsMatch: [],
  }],
});

describe('readSlipWithAliases + noteScanDraftAccepted: correct once, right next time', () => {
  test('name, phone and item code corrected on scan 1 come back corrected on scan 2', async () => {
    const tables: Record<string, Row[]> = {};
    const db = fakeDb(tables);
    const model = vi.fn(async (_hint: string) => ({ parsed: modelRead() }));

    // Scan 1: nothing learnt yet, so the model's read stands.
    const first = await readSlipWithAliases(db, COMPANY, model);
    expect(first.parsed?.customerName).toBe('Tan Ah Kow');
    expect(model.mock.calls[0]![0]).toBe('');

    // The draft built from it; the operator fixes three fields and confirms.
    tables.scan_jobs = [{ so_doc_no: DOC, sample_id: 'S1', created_at: '2026-10-14' }];
    tables.so_scan_samples = [{ id: 'S1', extracted: first.parsed, status: 'EXTRACTED' }];
    tables.mfg_so_audit_log = [{ so_doc_no: DOC, action: 'UPDATE_DETAILS', source: 'web' }];
    tables.mfg_sales_orders = [{
      doc_no: DOC, company_id: COMPANY, debtor_name: 'Tan Ah Kau', phone: '+60127778881',
      address1: '12 Jalan Mawar', city: 'Skudai', postcode: '81300', customer_state: 'Johor',
    }];
    tables.mfg_sales_order_items = [{ doc_no: DOC, item_group: 'bedframe', item_code: 'BC-KING', qty: 1, line_no: 1 }];
    await noteScanDraftAccepted(db, DOC);
    expect(tables.so_scan_samples[0]!.status).toBe('CONFIRMED');
    expect(tables.scan_field_aliases).toHaveLength(3);
    expect(tables.scan_field_aliases!.every((a) => a.company_id === COMPANY && a.kind === 'so')).toBe(true);

    // Scan 2: same misread from the model; the table fixes it, and the model was told.
    const second = await readSlipWithAliases(db, COMPANY, model);
    expect(second.parsed?.customerName).toBe('Tan Ah Kau');
    expect(second.parsed?.phones[0]).toBe('127778881');
    expect(second.parsed?.lines[0].skuMatch).toMatchObject({ code: 'BC-KING', confidence: 1 });
    expect(model.mock.calls[1]![0]).toContain('Tan Ah Kau');

    // Another company's scan learns nothing from this one.
    const other = await readSlipWithAliases(db, 2, model);
    expect(other.parsed?.customerName).toBe('Tan Ah Kow');
  });

  test('a confirm with no edits teaches no alias', async () => {
    const tables: Record<string, Row[]> = {
      scan_jobs: [{ so_doc_no: DOC, sample_id: 'S1', created_at: '2026-10-14' }],
      so_scan_samples: [{ id: 'S1', extracted: modelRead(), status: 'EXTRACTED' }],
      mfg_so_audit_log: [{ so_doc_no: DOC, action: 'CREATE', source: 'web' }],
    };
    await noteScanDraftAccepted(fakeDb(tables), DOC);
    expect(tables.so_scan_samples![0]!.status).toBe('ACCEPTED');
    expect(tables.scan_field_aliases ?? []).toHaveLength(0);
  });
});

describe('slipAliasPairs', () => {
  test('a phone that differs only in format is not a correction', () => {
    const ai = modelRead();
    const fixed = { ...ai, phones: ['0127778880'] };
    expect(slipAliasPairs(ai, fixed)).toEqual([]);
  });

  test('a field the operator blanked teaches nothing (no alias to empty)', () => {
    const ai = modelRead();
    expect(slipAliasPairs(ai, { ...ai, customerName: null })).toEqual([]);
  });
});
