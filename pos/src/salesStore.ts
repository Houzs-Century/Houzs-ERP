/* What the terminal keeps about its bills: the sales queue (every receipt,
 * synced or not), the receipt counters, and the local stock adjustments
 * (sold minus returned since Prepare) that the search shows beside the
 * catalog's snapshot. */
import { idb } from "./db";
import { stockDeltas, type SaleRecord } from "./sale";

export const saveSale = (s: SaleRecord) => idb.put("sales", s.uuid, s);
export const getSale = (uuid: string) => idb.get<SaleRecord>("sales", uuid);
export const listSales = () => idb.all<SaleRecord>("sales");

/** The next receipt number for this terminal, never reused: the counter is
 *  bumped before the receipt is written. Test sales count separately. */
export async function nextCounter(test: boolean, bundleCounter: number): Promise<number> {
  const key = test ? "test_counter" : "receipt_counter";
  const cur = (await idb.get<number>("meta", key)) ?? (test ? 0 : bundleCounter);
  const next = Math.max(cur, test ? 0 : bundleCounter) + 1;
  await idb.put("meta", key, next);
  return next;
}
export const currentCounter = async (bundleCounter: number): Promise<number> => Math.max((await idb.get<number>("meta", "receipt_counter")) ?? 0, bundleCounter);

export async function applyStock(sale: SaleRecord, undo = false): Promise<void> {
  if (sale.is_test) return;
  const adj = (await idb.get<Record<string, number>>("meta", "stock_adj")) ?? {};
  for (const [itemId, delta] of stockDeltas(sale)) adj[itemId] = (adj[itemId] ?? 0) + (undo ? -delta : delta);
  await idb.put("meta", "stock_adj", adj);
}
export const stockAdjustments = async (): Promise<Record<string, number>> => (await idb.get<Record<string, number>>("meta", "stock_adj")) ?? {};

export async function pendingSummary(): Promise<{ count: number; amount_sen: number; last_sale_at: string | null }> {
  const all = await listSales();
  let count = 0; let amount = 0; let last: string | null = null;
  for (const s of all) {
    if (s.is_test) continue;
    if (!s.synced_at) { count += 1; if (s.status === "PAID") amount += s.total_sen; }
    if (!last || s.sold_at > last) last = s.sold_at;
  }
  return { count, amount_sen: amount, last_sale_at: last };
}

export async function clearTestSales(): Promise<number> {
  const all = await listSales();
  let n = 0;
  for (const s of all) if (s.is_test) { await idb.del("sales", s.uuid); n += 1; }
  await idb.del("meta", "test_counter");
  return n;
}
