// Sim, 2026-10-20: free gifts on a delivery order that are on no PO (DIGLANT's
// "GWP Pillow" with the mattresses) go into stock at RM0. A gift's printed code
// is taught once to a catalogue product; each later scan adds it to the draft.
import { describe, expect, test } from 'vitest';
import { addGiftLines, giftLines, giftNote, isGiftRow, FREE_GIFT_REASON } from './grn-scan-gifts';
import type { ScannedGrnLine, UnmatchedScanLine } from './grn-scan-match';

const row = (itemCode: string, qty: number): ScannedGrnLine => ({ itemCode, barcode: null, description: null, qty });
const un = (line: ScannedGrnLine, reason: UnmatchedScanLine['reason']): UnmatchedScanLine => ({ line, reason, candidatePoItemIds: [] });

// DGSN26002266 (HC-0120): 4 GWP pillows + 8 Happi Sleep pillows on no PO.
const taught = [
  { supplierSku: 'AFKPAK25A23J29W', acItemCode: null, itemCode: 'AK-SLEEP ESSENTIAL 7 HOLES' },
  { supplierSku: 'UFHPHS13B25J29E', acItemCode: null, itemCode: 'AK-HAPPY SLEEP EASY' },
  { supplierSku: 'T1MAMWA0MK', acItemCode: null, itemCode: 'AKEMI BULWARK MATT (K)' },
];
const products = new Map([
  ['AK-SLEEP ESSENTIAL 7 HOLES', { code: 'AK-SLEEP ESSENTIAL 7 HOLES', name: 'AKEMI SLEEP ESSENTIAL 7 HOLES PILLOW' }],
  ['AK-HAPPY SLEEP EASY', { code: 'AK-HAPPY SLEEP EASY', name: 'HAPPI SLEEP EASY PILLOW' }],
]);

describe('giftLines', () => {
  test('rows on no PO with a code taught to a catalogue product, qty summed per product', () => {
    const gifts = giftLines({ unmatched: [
      un(row('AFKPAK25A23J29W', 2), 'not_on_po'),
      un(row('AFKPAK25A23J29W', 2), 'not_on_po'),
      un(row('UFHPHS13B25J29E', 8), 'no_open_po_line'),
    ] }, taught, products);
    expect(gifts).toEqual([
      { printedCode: 'AFKPAK25A23J29W', itemCode: 'AK-SLEEP ESSENTIAL 7 HOLES', name: 'AKEMI SLEEP ESSENTIAL 7 HOLES PILLOW', qty: 4 },
      { printedCode: 'UFHPHS13B25J29E', itemCode: 'AK-HAPPY SLEEP EASY', name: 'HAPPI SLEEP EASY PILLOW', qty: 8 },
    ]);
  });

  test('an ambiguous row, an untaught code, or a product not in the catalogue is no gift', () => {
    expect(giftLines({ unmatched: [
      un(row('AFKPAK25A23J29W', 4), 'ambiguous'),
      un(row('NEVER-TAUGHT', 1), 'not_on_po'),
      un(row('T1MAMWA0MK', 1), 'not_on_po'),
    ] }, taught, products)).toEqual([]);
  });

  test('the not-added note leaves gift rows out', () => {
    const gifts = giftLines({ unmatched: [un(row('AFKPAK25A23J29W', 4), 'not_on_po')] }, taught, products);
    expect(isGiftRow(row('AFKPAK25A23J29W', 4), gifts)).toBe(true);
    expect(isGiftRow(row('OTHER', 1), gifts)).toBe(false);
  });

  test('giftNote', () => {
    expect(giftNote([{ printedCode: 'A', itemCode: 'AK-HAPPY SLEEP EASY', name: 'x', qty: 8 }])).toBe('Free gifts added at RM0: AK-HAPPY SLEEP EASY x8.');
    expect(giftNote([])).toBeNull();
  });
});

type Row = Record<string, unknown>;
function fakeSvc(tables: Record<string, Row[]>) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let single = false;
    const q = {
      select: () => q,
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; },
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return q; },
      is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return q; },
      maybeSingle: () => { single = true; return q; },
      insert: (row: Row) => { inserts.push({ table, row }); (tables[table] ||= []).push(row); return Promise.resolve({ error: null }); },
      update: () => q,
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        resolve({ data: single ? rows[0] ?? null : rows, error: null });
      },
    };
    return q;
  };
  return { svc: { from } as unknown as Parameters<typeof addGiftLines>[0], inserts };
}

describe('addGiftLines', () => {
  const gifts = [{ printedCode: 'AFKPAK25A23J29W', itemCode: 'AK-SLEEP ESSENTIAL 7 HOLES', name: 'AKEMI SLEEP ESSENTIAL 7 HOLES PILLOW', qty: 4 }];

  test('adds the gift to a DRAFT with no PO link at RM0, acknowledged as a free gift', async () => {
    const { svc, inserts } = fakeSvc({
      grns: [{ id: 'g1', status: 'DRAFT', company_id: 1 }],
      grn_items: [{ id: 'i1', grn_id: 'g1', company_id: 1, purchase_order_item_id: 'po-line', item_code: 'AKEMI BULWARK MATT (K)', line_total_sen: 195000 }],
      mfg_products: [],
    });
    const added = await addGiftLines(svc, 1, 'g1', gifts, 'staff-1');
    expect(added).toEqual(gifts);
    const row = inserts.find((x) => x.table === 'grn_items')!.row;
    expect(row).toMatchObject({
      company_id: 1, grn_id: 'g1', purchase_order_item_id: null, item_code: 'AK-SLEEP ESSENTIAL 7 HOLES',
      qty_received: 4, qty_accepted: 4, unit_price_sen: 0, line_total_sen: 0,
      zero_cost_ack: true, zero_cost_ack_by: 'staff-1', zero_cost_reason: FREE_GIFT_REASON,
    });
  });

  test('not twice, and never on a posted GRN', async () => {
    const again = fakeSvc({
      grns: [{ id: 'g1', status: 'DRAFT', company_id: 1 }],
      grn_items: [{ id: 'i2', grn_id: 'g1', company_id: 1, purchase_order_item_id: null, item_code: 'AK-SLEEP ESSENTIAL 7 HOLES' }],
    });
    expect(await addGiftLines(again.svc, 1, 'g1', gifts, 'staff-1')).toEqual([]);
    const posted = fakeSvc({ grns: [{ id: 'g1', status: 'POSTED', company_id: 1 }], grn_items: [] });
    expect(await addGiftLines(posted.svc, 1, 'g1', gifts, 'staff-1')).toEqual([]);
    expect(posted.inserts).toEqual([]);
  });
});
