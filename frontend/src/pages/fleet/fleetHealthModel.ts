// Fleet Health, the pure rules behind the restyled dashboard and lorry record, so
// the screens only render.
import type { LorryBox } from "../scm-v2/fleet/Lorry3D";

const pos = (n: number | null | undefined): number | null => (n != null && Number.isFinite(n) && n > 0 ? n : null);

/** The container drawn by Lorry3D / LorrySide: all three sides entered, else none. */
export function lorryBox(v: { lengthFt?: number | null; widthFt?: number | null; heightFt?: number | null }): LorryBox | null {
  const length = pos(v.lengthFt), width = pos(v.widthFt), height = pos(v.heightFt);
  return length && width && height ? { length, width, height } : null;
}

export type OffRoadWindow = { from: string | null; to: string | null; reason: string | null };
export type OffRoadRow = OffRoadWindow & { state: "now" | "planned" | "ended"; days: number | null };

const dayMs = 86_400_000;
const dayNo = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / dayMs);

/** The lorry's off-the-road windows (scm.lorry_maintenance), newest first, each
 *  marked as running today, still to come, or over, with its length in days. */
export function offRoadRows(windows: readonly OffRoadWindow[], today: string): OffRoadRow[] {
  const t = today.slice(0, 10);
  return windows
    .map((w) => {
      const from = w.from?.slice(0, 10) ?? null, to = w.to?.slice(0, 10) ?? null;
      const state: OffRoadRow["state"] = from && from > t ? "planned" : to && to < t ? "ended" : "now";
      const days = from && to ? dayNo(to) - dayNo(from) + 1 : null;
      return { ...w, from, to, state, days };
    })
    .sort((a, b) => (b.from ?? "").localeCompare(a.from ?? ""));
}

/** How much a lorry needs looking at, for the dashboard's attention chart:
 *  hours down, a day per overdue service, half a day per open work order. */
export function attentionScore(v: { downtimeHours?: number | null; plansOverdue: number; openWorkOrders?: number }): number {
  return (v.downtimeHours ?? 0) + v.plansOverdue * 24 + (v.openWorkOrders ?? 0) * 12;
}

/** Uploads files one at a time and returns the ones still to go: the one that
 *  failed and everything after it, with the error. A retry passes these back in,
 *  so a file that already went up is never sent twice. */
export async function uploadEach<F>(files: readonly F[], upload: (f: F) => Promise<unknown>): Promise<{ left: F[]; error: unknown }> {
  for (let i = 0; i < files.length; i++) {
    try { await upload(files[i]); } catch (error) { return { left: files.slice(i), error }; }
  }
  return { left: [], error: null };
}
