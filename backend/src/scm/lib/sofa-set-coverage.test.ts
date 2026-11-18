import { describe, expect, it } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { findCoveringBatch, loadSofaBatchStock, sofaStockKey } from './sofa-set-coverage';

const WAREHOUSE = 'wh-kl';
const VARIANT = 'fabriccode=ez-004|seatheight=28|legheight=6"';
const POSTGREST_ROW_CEILING = 1_000;

function fillerLots(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `filler-${i}`,
    warehouse_id: 'wh-other',
    item_code: `OTHER-${i}`,
    variant_key: '',
    batch_no: `PO-OLD-${i}`,
    qty_remaining: 1,
    received_at: '2026-01-01T00:00:00Z',
  }));
}

function newestSetLots(): Array<Record<string, unknown>> {
  return ['XAMMAR-2A(LHF)', 'XAMMAR-L(RHF)'].map((itemCode) => ({
    id: `new-${itemCode}`,
    warehouse_id: WAREHOUSE,
    item_code: itemCode,
    variant_key: VARIANT,
    batch_no: '2990-PO-2610-055',
    qty_remaining: 1,
    received_at: '2026-11-18T03:02:37Z',
  }));
}

describe('loadSofaBatchStock', () => {
  it('readsLotsPastThePostgrestRowCeiling', async () => {
    const sb = fakeSb(
      { v_inventory_lots_open: [...fillerLots(POSTGREST_ROW_CEILING + 43), ...newestSetLots()] },
      {}, [], [], POSTGREST_ROW_CEILING,
    );

    const stock = await loadSofaBatchStock(sb, ['XAMMAR-2A(LHF)', 'XAMMAR-L(RHF)']);

    expect(stock.remaining.get(sofaStockKey(WAREHOUSE, '2990-PO-2610-055', 'XAMMAR-L(RHF)', VARIANT))).toBe(1);
    const set = [
      { itemCode: 'XAMMAR-2A(LHF)', variantKey: VARIANT, need: 1 },
      { itemCode: 'XAMMAR-L(RHF)', variantKey: VARIANT, need: 1 },
    ];
    expect(findCoveringBatch(WAREHOUSE, set, stock)).toBe('2990-PO-2610-055');
  });
});
