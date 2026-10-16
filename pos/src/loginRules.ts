/* The login screen's rules (layout P1), pure: which tiles show, the wrong-PIN
 * lock, the colour of "Last sync", and who may open Device setup. */
import type { BundleCashier } from "./types";

export const MAX_TILES = 8;
export const LOCK_AFTER = 5;
export const LOCK_SECONDS = 30;

/** Up to eight tiles, supervisors first then by code; the rest are reached
 *  through the "Type ID" tile. */
export function loginTiles(cashiers: readonly BundleCashier[]): { tiles: BundleCashier[]; overflow: BundleCashier[] } {
  const sorted = [...cashiers].sort((a, b) => (a.role === b.role ? a.code.localeCompare(b.code) : a.role === "SUPERVISOR" ? -1 : 1));
  return { tiles: sorted.slice(0, MAX_TILES), overflow: sorted.slice(MAX_TILES) };
}

export function findCashierById(cashiers: readonly BundleCashier[], typed: string): BundleCashier | null {
  const t = typed.trim().toUpperCase();
  if (!t) return null;
  return cashiers.find((c) => c.code.toUpperCase() === t) ?? cashiers.find((c) => c.name.toUpperCase() === t) ?? null;
}

export type LockState = { failures: number; locked_until: number };

export const freshLock = (): LockState => ({ failures: 0, locked_until: 0 });

export function lockedFor(state: LockState, now: number): number {
  return state.locked_until > now ? Math.ceil((state.locked_until - now) / 1000) : 0;
}

export function afterWrongPin(state: LockState, now: number): LockState {
  const failures = state.failures + 1;
  if (failures >= LOCK_AFTER) return { failures: 0, locked_until: now + LOCK_SECONDS * 1000 };
  return { failures, locked_until: state.locked_until };
}

export type SyncTone = "green" | "amber" | "red" | "none";

/** Last sync colour: green under 24 h, amber 1 to 3 days, red beyond. */
export function syncTone(lastSyncIso: string | null, now: number): SyncTone {
  if (!lastSyncIso) return "none";
  const ms = now - Date.parse(lastSyncIso);
  if (!Number.isFinite(ms)) return "none";
  const days = ms / 86_400_000;
  if (days < 1) return "green";
  if (days <= 3) return "amber";
  return "red";
}

export const canOpenDeviceSetup = (c: BundleCashier | null): boolean => c?.role === "SUPERVISOR";

/** Malaysia local date-time for the header and the receipt. */
export function fmtMyt(iso: string | null | undefined): string {
  if (!iso) return "--";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "--";
  const d = new Date(ms + 8 * 3600_000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  let h = d.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${dd}/${mm}/${yyyy} ${String(h).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ampm}`;
}

export function fmtDateRange(start: string | null, end: string | null): string {
  const f = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : null);
  const a = f(start);
  const b = f(end);
  if (a && b && a !== b) return `${a} - ${b}`;
  return a ?? b ?? "";
}
