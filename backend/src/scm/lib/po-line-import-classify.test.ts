import { describe, expect, test } from 'vitest';
import { poLineDescription2 } from './po-line-description2';
import {
  classifyPoLineImport,
  parseApplyBody,
  parsePreviewBody,
  recheckApply,
  type ImportLineRow,
  type ImportPoRow,
  type ImportWorld,
} from './po-line-import-classify';
import type { PoLineImportRow } from './po-line-import';

/* Owner ruling 2026-09-15: a PO line export comes back in; only the six columns
   move, qty / price / item never do, and every refusal says why. */

const PO_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PO_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const L1 = '11111111-0000-4000-8000-000000000001';
const L2 = '11111111-0000-4000-8000-000000000002';
const L3 = '11111111-0000-4000-8000-000000000003';
const LB = '11111111-0000-4000-8000-0000000000b1';
const FOREIGN = '22222222-0000-4000-8000-000000000001';

const line = (id: string, po: string, extra: Record<string, unknown> = {}): ImportLineRow => ({
  id, purchase_order_id: po, item_code: `CODE-${id.slice(-2)}`,
  delivery_date: '2026-09-01', description2: 'col:PC-151-03', notes: null,
  supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  qty: 2, unit_price_sen: 10000,
  ...extra,
});

function world(over: Partial<{ poA: Partial<ImportPoRow>; poB: Partial<ImportPoRow>; lockB: string | null }> = {}): ImportWorld {
  const poA: ImportPoRow = { id: PO_A, po_number: 'PO-000100', revision: 1, status: 'SUBMITTED', supplier_delivery_date_2: null, ...over.poA };
  const poB: ImportPoRow = { id: PO_B, po_number: 'PO-000200', revision: 3, status: 'SUBMITTED', supplier_delivery_date_2: null, ...over.poB };
  const aLines = [line(L1, PO_A), line(L2, PO_A), line(L3, PO_A, { supplier_delivery_date_2: '2026-10-01' })];
  const bLines = [line(LB, PO_B)];
  return {
    lines: new Map([...aLines, ...bLines].map((l) => [l.id, l])),
    otherCompanyLineIds: new Set([FOREIGN]),
    pos: new Map([[PO_A, poA], [PO_B, poB]]),
    poLocks: new Map([[PO_A, null], [PO_B, over.lockB ?? null]]),
    poLines: new Map([[PO_A, aLines], [PO_B, bLines]]),
  };
}

const row = (n: number, lineId: string | null, docNo: string | null, values: PoLineImportRow['values']): PoLineImportRow =>
  ({ rowNumber: n, lineId, docNo, values });

const only = (rows: PoLineImportRow[], w = world()) => classifyPoLineImport(rows, w);

describe('classifyPoLineImport — one row, one verdict', () => {
  test('a changed line field is listed as field, old, new', () => {
    const p = only([row(2, L1, 'PO-000100', { deliveryDate: '2026-09-20', remarks: 'chase supplier', description2: 'col:PC-151-03' })]);
    expect(p.rows[0]).toMatchObject({
      status: 'changes', itemCode: 'CODE-01',
      changes: [{ field: 'deliveryDate', old: '2026-09-01', new: '2026-09-20' }, { field: 'remarks', old: null, new: 'chase supplier' }],
    });
    expect(p.lineChanges).toEqual([
      { lineId: L1, docNo: 'PO-000100', field: 'deliveryDate', old: '2026-09-01', new: '2026-09-20' },
      { lineId: L1, docNo: 'PO-000100', field: 'remarks', old: null, new: 'chase supplier' },
    ]);
    expect(p.counts).toMatchObject({ rows: 1, changed: 1, unchanged: 0, rejected: 0 });
  });

  test('an untouched export row is unchanged, whatever format the date came back in', () => {
    const p = only([
      row(2, L1, 'PO-000100', { deliveryDate: '01/09/2026', description2: ' col:PC-151-03 ', remarks: '' }),
      row(3, L2, 'PO-000100', { deliveryDate: 46266 }), // Excel serial for 2026-09-01
    ]);
    expect(p.rows.map((r) => r.status)).toEqual(['unchanged', 'unchanged']);
    expect(p.lineChanges).toEqual([]);
  });

  test('a blank cell where a value was clears it', () => {
    const p = only([row(2, L1, 'PO-000100', { description2: '' })]);
    expect(p.lineChanges).toEqual([{ lineId: L1, docNo: 'PO-000100', field: 'description2', old: 'col:PC-151-03', new: null }]);
  });

  const rejected = (p: ReturnType<typeof only>, i = 0) => {
    const r = p.rows[i]!;
    if (r.status !== 'rejected') throw new Error(`row ${i} is ${r.status}, not rejected`);
    return r;
  };

  test('unknown Line ID — blank, not a uuid, or no such line', () => {
    const p = only([
      row(2, null, 'PO-000100', { remarks: 'x' }),
      row(3, 'abc', 'PO-000100', { remarks: 'x' }),
      row(4, '33333333-0000-4000-8000-000000000009', 'PO-000100', { remarks: 'x' }),
    ]);
    expect([0, 1, 2].map((i) => rejected(p, i).code)).toEqual(['unknown_line', 'unknown_line', 'unknown_line']);
  });

  test('a line in another company is named as such, not as unknown', () => {
    expect(rejected(only([row(2, FOREIGN, 'PO-000999', { remarks: 'x' })])).code).toBe('other_company');
  });

  test('a cancelled PO, a received PO and a PO with a Goods Receipt refuse their lines', () => {
    expect(rejected(only([row(2, LB, 'PO-000200_R2', { remarks: 'x' })], world({ poB: { status: 'CANCELLED' } }))).code).toBe('po_cancelled');
    expect(rejected(only([row(2, LB, 'PO-000200_R2', { remarks: 'x' })], world({ poB: { status: 'RECEIVED' } }))).code).toBe('po_received');
    const locked = rejected(only([row(2, LB, 'PO-000200_R2', { remarks: 'x' })], world({ poB: { status: 'PARTIALLY_RECEIVED' }, lockB: 'PO has a Goods Receipt' })));
    expect(locked.code).toBe('po_locked');
    expect(locked.reason).toContain('Goods Receipt');
  });

  test('an invalid date rejects the whole row and names the column', () => {
    const r = rejected(only([row(2, L1, 'PO-000100', { deliveryDate: '31/02/2026', remarks: 'fine' })]));
    expect(r.code).toBe('invalid_value');
    expect(r.reason).toContain('Delivery Date');
  });

  test("a Doc No that is not the line's PO rejects the row; the revised display number is accepted", () => {
    expect(rejected(only([row(2, L1, 'PO-000200', { remarks: 'x' })])).code).toBe('doc_no_mismatch');
    expect(rejected(only([row(2, L1, null, { remarks: 'x' })])).code).toBe('doc_no_mismatch');
    expect(only([row(2, LB, 'po-000200_r2', { remarks: 'x' })]).rows[0]!.status).toBe('changes');
    expect(rejected(only([row(2, LB, 'PO-000200_R1', { remarks: 'x' })])).code).toBe('doc_no_mismatch');
  });

  test("the grid's Doc No is AutoCount's number when the PO is linked; that number is accepted too", () => {
    const w = world({ poA: { linked_ac_docno: 'PO-009304' } });
    expect(only([row(2, L1, 'PO-009304', { remarks: 'x' })], w).rows[0]!.status).toBe('changes');
    expect(only([row(2, L1, 'PO-000100', { remarks: 'x' })], w).rows[0]!.status).toBe('changes');
    expect(rejected(only([row(2, L1, 'PO-009999', { remarks: 'x' })], w)).code).toBe('doc_no_mismatch');
  });

  test('Item Description 2 compares against the exported variant summary, so an untouched file is unchanged', () => {
    const variants = { fabricCode: 'PC151-04' };
    const w = world();
    const l1 = w.lines.get(L1)!;
    Object.assign(l1, { item_group: 'bedframe', variants, description2: 'OLD TYPED TEXT' });
    const exported = poLineDescription2('bedframe', variants, 'OLD TYPED TEXT');
    expect(exported).not.toBe('OLD TYPED TEXT');
    expect(only([row(2, L1, 'PO-000100', { description2: exported })], w).rows[0]!.status).toBe('unchanged');
    expect(only([row(2, L1, 'PO-000100', { description2: 'NEW' })], w).rows[0]!.status).toBe('changes');
  });

  test('the same Line ID twice: the first row counts, the second is refused', () => {
    const p = only([row(2, L1, 'PO-000100', { remarks: 'first' }), row(3, L1.toUpperCase(), 'PO-000100', { remarks: 'second' })]);
    expect(p.rows[0]!.status).toBe('changes');
    expect(rejected(p, 1).code).toBe('duplicate_line');
  });
});

describe('qty, price and item in the file are ignored even when edited', () => {
  test('parsePreviewBody keeps only the six import fields', () => {
    const parsed = parsePreviewBody({
      rows: [{ rowNumber: 2, lineId: L1, docNo: 'PO-000100', values: { qty: 99, unitPriceSen: 1, itemCode: 'OTHER', unit_price_sen: 5, remarks: 'r' } }],
    });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.rows[0]!.values).toEqual({ remarks: 'r' });
    const p = only(parsed.rows);
    expect(p.lineChanges.map((c) => c.field)).toEqual(['remarks']);
  });

  test('parseApplyBody refuses a change to any other field', () => {
    for (const field of ['qty', 'unitPriceSen', 'itemCode', 'unit_price_sen', 'notes']) {
      const r = parseApplyBody({ lineChanges: [{ lineId: L1, docNo: 'PO-000100', field, old: '1', new: '2' }] });
      expect(r.ok).toBe(false);
    }
  });

  test('parseApplyBody refuses a PO-level field sent as a line change, and a non-ISO value', () => {
    expect(parseApplyBody({ lineChanges: [{ lineId: L1, field: 'estimateDeliveryDate1', old: null, new: '2026-10-01' }] }).ok).toBe(false);
    expect(parseApplyBody({ lineChanges: [{ lineId: L1, field: 'deliveryDate', old: null, new: '01/10/2026' }] }).ok).toBe(false);
    expect(parseApplyBody({ lineChanges: [{ lineId: L1, field: 'deliveryDate', old: null, new: '2026-10-01' }] }).ok).toBe(true);
  });
});

describe('Estimate Delivery Date 1/2/3 are PO-level', () => {
  test('every row of the PO agreeing on a new date is ONE PO change, carrying every line it will overwrite', () => {
    const p = only([
      row(2, L1, 'PO-000100', { estimateDeliveryDate1: '2026-10-15' }),
      row(3, L2, 'PO-000100', { estimateDeliveryDate1: '15/10/2026' }),
      row(4, L3, 'PO-000100', { estimateDeliveryDate1: '2026-10-15' }),
    ]);
    expect(p.poChanges).toEqual([{
      poId: PO_A, docNo: 'PO-000100', field: 'estimateDeliveryDate1', old: null, new: '2026-10-15',
      lineValues: { [L1]: null, [L2]: null, [L3]: '2026-10-01' }, rowNumbers: [2, 3, 4],
    }]);
    expect(p.rows.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(p.lineChanges).toEqual([]);
  });

  test('an untouched export whose lines already differ is NOT a conflict', () => {
    const p = only([
      row(2, L1, 'PO-000100', { estimateDeliveryDate1: null }),
      row(4, L3, 'PO-000100', { estimateDeliveryDate1: '2026-10-01' }),
    ]);
    expect(p.poChanges).toEqual([]);
    expect(p.poRejections).toEqual([]);
  });

  test("a blank line exported with its PO header's estimate date is NOT an edit (the export's fallback)", () => {
    const w = world({ poA: { supplier_delivery_date_2: '2026-10-01' } });
    const p = only([
      row(2, L1, 'PO-000100', { estimateDeliveryDate1: '2026-10-01' }),
      row(3, L2, 'PO-000100', { estimateDeliveryDate1: '2026-10-01' }),
      row(4, L3, 'PO-000100', { estimateDeliveryDate1: '2026-10-01' }),
    ], w);
    expect(p.poChanges).toEqual([]);
    expect(p.poRejections).toEqual([]);
  });

  test('rows of one PO carrying different estimate dates reject that change and name the lines', () => {
    const p = only([
      row(2, L1, 'PO-000100', { estimateDeliveryDate1: '2026-10-15', remarks: 'still applies' }),
      row(3, L2, 'PO-000100', { estimateDeliveryDate1: '2026-10-20' }),
    ]);
    expect(p.poChanges).toEqual([]);
    expect(p.poRejections).toHaveLength(1);
    expect(p.poRejections[0]!.reason).toContain('row 2 (CODE-01) 2026-10-15');
    expect(p.poRejections[0]!.reason).toContain('row 3 (CODE-02) 2026-10-20');
    expect(p.lineChanges.map((c) => c.field)).toEqual(['remarks']);
  });

  test('an invalid estimate date on one row blocks the PO change the other rows ask for', () => {
    const p = only([
      row(2, L1, 'PO-000100', { estimateDeliveryDate1: '2026-10-15' }),
      row(3, L2, 'PO-000100', { estimateDeliveryDate1: 'soon' }),
    ]);
    expect(p.poChanges).toEqual([]);
    expect(p.poRejections[0]!.reason).toContain('row 3');
  });
});

describe('recheckApply — the optimistic lock at Confirm', () => {
  const lineChange = { lineId: L1, docNo: 'PO-000100', field: 'deliveryDate' as const, old: '2026-09-01', new: '2026-09-20' };

  test('nothing moved: no conflicts', () => {
    expect(recheckApply({ lineChanges: [lineChange], poChanges: [] }, world())).toEqual([]);
  });

  test('a value that changed since the preview is a conflict', () => {
    const w = world();
    w.lines.get(L1)!.delivery_date = '2026-09-05';
    const c = recheckApply({ lineChanges: [lineChange], poChanges: [] }, w);
    expect(c).toHaveLength(1);
    expect(c[0]!.reason).toContain('changed since the preview');
  });

  test('a PO that got a Goods Receipt since the preview is a conflict', () => {
    const c = recheckApply(
      { lineChanges: [{ ...lineChange, lineId: LB, docNo: 'PO-000200' }], poChanges: [] },
      (() => { const w = world({ lockB: 'PO has a Goods Receipt' }); w.lines.get(LB)!.delivery_date = '2026-09-01'; return w; })(),
    );
    expect(c.some((x) => x.reason.includes('Goods Receipt'))).toBe(true);
  });

  test('a line that left this company is a conflict', () => {
    const w = world();
    w.lines.delete(L1);
    expect(recheckApply({ lineChanges: [lineChange], poChanges: [] }, w)[0]!.reason).toContain('no longer in this company');
  });

  test('a PO date change conflicts when the header or any line value moved, or a line was added', () => {
    const poChange = {
      poId: PO_A, docNo: 'PO-000100', field: 'estimateDeliveryDate1' as const, old: null, new: '2026-10-15',
      lineValues: { [L1]: null, [L2]: null, [L3]: '2026-10-01' },
    };
    expect(recheckApply({ lineChanges: [], poChanges: [poChange] }, world())).toEqual([]);
    expect(recheckApply({ lineChanges: [], poChanges: [poChange] }, world({ poA: { supplier_delivery_date_2: '2026-10-02' } }))).toHaveLength(1);
    const moved = world();
    moved.poLines.get(PO_A)![0]!.supplier_delivery_date_2 = '2026-11-01';
    expect(recheckApply({ lineChanges: [], poChanges: [poChange] }, moved)).toHaveLength(1);
    const added = world();
    added.poLines.get(PO_A)!.push(line('11111111-0000-4000-8000-000000000004', PO_A));
    expect(recheckApply({ lineChanges: [], poChanges: [poChange] }, added)[0]!.reason).toContain('added or removed');
  });
});
