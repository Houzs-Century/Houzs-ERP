/* Which stock PO a delivered order's goods came from (owner, 2026-10-17:
   "a PO raised with no customer behind it — when an order later takes those
   goods, how far ahead did we order?"). Kept in the back end only.

   Nothing new is recorded: the goods received notes and the delivery orders
   already say what came in and what went out, per warehouse and item. Goods
   go out first in, first out: each delivered line that was NOT bought for its
   own customer (no PO line carries its sales-order line) takes the oldest
   stock-PO receipt of the same item in the same warehouse, received on or
   before the delivery. Then:
     ordered ahead  = the customer's order date − the PO date (positive = the
                      PO went out before the customer ordered);
     before need    = the customer's delivery date − the PO date;
     held in stock  = the delivery date − the receipt date.
   An estimate: stock that was on hand before the receipts in the window (or
   before the ERP recorded receipts at all) is unknown, so a delivery with no
   receipt to take from counts as "from older stock", not as a match. */

export interface StockReceipt { warehouse: string; itemCode: string; category: string; poId: string; poDate: string; receivedAt: string; qty: number }
export interface StockOut { warehouse: string; itemCode: string; doDate: string; qty: number; soDate: string | null; needDate: string | null }

const DAY = 86400000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const h = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2) * 10) / 10;
};

export function attributeStockPos(receipts: StockReceipt[], outs: StockOut[]) {
  const key = (w: string, i: string) => `${w}|${i}`;
  const queues = new Map<string, Array<StockReceipt & { left: number }>>();
  for (const r of [...receipts].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    if (r.qty <= 0) continue;
    const k = key(r.warehouse, r.itemCode);
    queues.set(k, [...(queues.get(k) ?? []), { ...r, left: r.qty }]);
  }
  const matches: Array<{ category: string; poId: string; qty: number; orderedAheadDays: number | null; beforeNeedDays: number | null; heldDays: number }> = [];
  let fromOlderStock = 0;
  for (const o of [...outs].sort((a, b) => a.doDate.localeCompare(b.doDate))) {
    let need = o.qty;
    const q = queues.get(key(o.warehouse, o.itemCode)) ?? [];
    for (const r of q) {
      if (need <= 0) break;
      if (r.left <= 0 || r.receivedAt > o.doDate) continue;
      const take = Math.min(r.left, need);
      r.left -= take; need -= take;
      matches.push({
        category: r.category, poId: r.poId, qty: take,
        orderedAheadDays: o.soDate ? days(r.poDate, o.soDate) : null,
        beforeNeedDays: o.needDate ? days(r.poDate, o.needDate) : null,
        heldDays: days(r.receivedAt, o.doDate),
      });
    }
    if (need > 0) fromOlderStock += need;
  }
  /* Per unit, so a line of 4 weighs four times a line of 1. */
  const perUnit = (pick: (m: (typeof matches)[number]) => number | null, ms: typeof matches) =>
    median(ms.flatMap((m) => { const v = pick(m); return v == null ? [] : Array<number>(m.qty).fill(v); }));
  const summary = (ms: typeof matches) => ({
    units: ms.reduce((a, m) => a + m.qty, 0),
    medianOrderedAheadDays: perUnit((m) => m.orderedAheadDays, ms),
    medianBeforeNeedDays: perUnit((m) => m.beforeNeedDays, ms),
    medianHeldDays: perUnit((m) => m.heldDays, ms),
  });
  const cats = [...new Set(matches.map((m) => m.category))].sort();
  return {
    total: summary(matches),
    byCategory: Object.fromEntries(cats.map((c) => [c, summary(matches.filter((m) => m.category === c))])),
    fromOlderStockUnits: fromOlderStock,
    unusedReceiptUnits: [...queues.values()].flat().reduce((a, r) => a + r.left, 0),
  };
}
