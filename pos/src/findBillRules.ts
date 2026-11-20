/* Find bill, "Other terminals": a device keeps only the bills it made, so a
 * receipt made on another device is read from the ERP for a reprint. Void,
 * return and change of salesman stay on the device that made the bill. */
import type { SaleRecord } from "./sale";

/** What the ERP returned minus what this device holds itself: its own copy
 *  is the one it may void, and it may be newer than the ERP's. */
export function otherDeviceBills(local: readonly SaleRecord[], fromErp: readonly SaleRecord[]): SaleRecord[] {
  const mine = new Set(local.map((s) => s.uuid));
  return fromErp.filter((s) => !mine.has(s.uuid));
}

/** The Malaysia days to ask the ERP for: today, or from the start of the
 *  event (30 days back when it has no start date) to today. */
export function findBillDays(todayOnly: boolean, eventStart: string | null, today: string): { from: string; to: string } {
  if (todayOnly) return { from: today, to: today };
  const start = eventStart?.slice(0, 10) ?? null;
  if (start && start <= today) return { from: start, to: today };
  const back = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  return { from: back, to: today };
}
