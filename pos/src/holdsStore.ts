/* Held bills (P11) live in IndexedDB on this terminal only: no receipt
 * number, no stock movement, gone at the event's end. */
import { holdExpired, nextHoldNo, type Cart, type HeldBill } from "./cart";
import { idb } from "./db";

export async function listHolds(eventEndDate: string | null): Promise<HeldBill[]> {
  const all = await idb.all<HeldBill>("holds");
  const now = Date.now();
  const live: HeldBill[] = [];
  for (const h of all) {
    if (holdExpired(h, eventEndDate, now)) await idb.del("holds", h.hold_no);
    else live.push(h);
  }
  return live.sort((a, b) => a.hold_no.localeCompare(b.hold_no));
}

export async function holdCart(cart: Cart, cashier: string): Promise<HeldBill> {
  const existing = await idb.all<HeldBill>("holds");
  const h: HeldBill = { hold_no: nextHoldNo(existing), created_at: new Date().toISOString(), cart, cashier };
  await idb.put("holds", h.hold_no, h);
  return h;
}

export const discardHold = (holdNo: string) => idb.del("holds", holdNo);
