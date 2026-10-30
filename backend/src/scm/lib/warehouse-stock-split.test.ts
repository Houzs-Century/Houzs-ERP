import { describe, expect, it } from 'vitest';
import { warehouseStockList } from './warehouse-stock-split';

const codes = new Map([['pg-wh', 'PG WAREHOUSE'], ['pg-disp', 'PG DISPLAY'], ['kl-wh', 'KL WAREHOUSE']]);

describe('warehouseStockList (HC-0187)', () => {
  it('names the warehouse holding the stock, so a display piece is not read as warehouse stock', () => {
    expect(warehouseStockList(new Map([['pg-wh', 0], ['pg-disp', 1]]), codes)).toEqual([
      { warehouse_id: 'pg-disp', warehouse_code: 'PG DISPLAY', qty: 1 },
    ]);
  });

  it('orders largest first, then by warehouse code', () => {
    const list = warehouseStockList(new Map([['pg-disp', 1], ['pg-wh', 3], ['kl-wh', 1]]), codes);
    expect(list.map((w) => `${w.warehouse_code} ${w.qty}`)).toEqual(['PG WAREHOUSE 3', 'KL WAREHOUSE 1', 'PG DISPLAY 1']);
  });

  it('keeps an unknown warehouse with a null code and rounds lot fractions', () => {
    expect(warehouseStockList(new Map([['gone', 1.9999]]), codes)).toEqual([
      { warehouse_id: 'gone', warehouse_code: null, qty: 2 },
    ]);
  });

  it('no lots is an empty list', () => {
    expect(warehouseStockList(undefined, codes)).toEqual([]);
  });
});
