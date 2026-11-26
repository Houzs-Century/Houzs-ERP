import { momentMs } from "../../scm/shared/pos-pairing";

/** How long an unanswered request, and an unclaimed approval, stay open. */
export const RECONNECT_HOURS = 24;

export type ReconnectRow = { reconnect_requested_at: string | null; reconnect_approved_at: string | null };

export type ReconnectPhase = "none" | "waiting" | "approved";

/** Where a terminal's reconnect request stands at `nowMs`. An approval counts
 *  only for the request it answered (approved at or after the request), and
 *  both lapse after RECONNECT_HOURS so a forgotten one cannot hand the
 *  terminal over weeks later. Moments, never text (docs/bugs/README.md). */
export function reconnectPhase(row: ReconnectRow, nowMs: number): ReconnectPhase {
  const life = RECONNECT_HOURS * 3_600_000;
  const asked = momentMs(row.reconnect_requested_at);
  if (asked == null || nowMs - asked > life) return "none";
  const approved = momentMs(row.reconnect_approved_at);
  if (approved != null && approved >= asked && nowMs - approved <= life) return "approved";
  return "waiting";
}
