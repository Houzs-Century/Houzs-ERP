import { todayMyt } from '../vendor/scm/lib/dates';

const dmy = (ymd: string): string => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

/* HC-0113 (Sim 2026-10-16): the salesperson is told BEFORE confirming that a
   past Processing Date becomes the confirm date. Mirrors the backend rule
   processingDateOnConfirm (backend/src/scm/shared/so-proceeded-status.ts),
   which is what actually decides; this only words it. */
export function soConfirmDateNote(
  processingDate: string | null | undefined,
  deliveryDate: string | null | undefined,
  todayMY: string = todayMyt(),
): string | null {
  const proc = String(processingDate ?? '').trim().slice(0, 10);
  if (!proc || proc >= todayMY) return null;
  const deliv = String(deliveryDate ?? '').trim().slice(0, 10);
  if (deliv && deliv < todayMY) {
    return `The Delivery Date ${dmy(deliv)} has already passed. Change it to today or later first — the order cannot be confirmed with it.`;
  }
  return `The Processing Date ${dmy(proc)} has passed. Confirming today changes it to the confirm date, ${dmy(todayMY)}.`;
}
