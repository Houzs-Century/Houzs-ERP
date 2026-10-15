// ----------------------------------------------------------------------------
// pos-alerts.ts — the pure rules behind Sync Status (layout E7): which
// terminals need an alert, which alert resolves, when an email goes out or
// goes out again, and the subject line. Three alert kinds (spec section 10):
//   PENDING_STALE         pending > 0 and no successful sync for > N days
//   EVENT_ENDED_PENDING   event end + M days passed and pending > 0 (or never
//                         synced since the event started)
//   DATA_LOST             the device reconnected with an empty local database
//                         while the ERP's last record showed pending > 0
// No alert for a terminal that is merely offline during an event.
// ----------------------------------------------------------------------------

export type AlertType = "PENDING_STALE" | "EVENT_ENDED_PENDING" | "DATA_LOST";

export type TerminalFacts = {
  id: number;
  code: string;
  device_name: string | null;
  active: boolean;
  project_id: number | null;
  event_name: string | null;
  event_start: string | null;
  event_end: string | null;
  prepared_at: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  pending_count: number;
  pending_amount_sen: number;
  last_known_pending_count: number;
  last_known_pending_sen: number;
  db_empty_at: string | null;
};

export type WantedAlert = { type: AlertType; terminal_id: number; project_id: number | null; detail: Record<string, unknown> };

const DAY = 86_400_000;
const daysSince = (iso: string | null, nowMs: number): number | null => (iso ? (nowMs - Date.parse(iso)) / DAY : null);
const mytDate = (ms: number): string => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

/** The alerts a terminal SHOULD have right now. */
export function wantedAlerts(t: TerminalFacts, thresholds: { pendingDays: number; eventEndDays: number }, nowMs: number): WantedAlert[] {
  const out: WantedAlert[] = [];
  if (!t.active) return out;
  if (t.db_empty_at) {
    out.push({ type: "DATA_LOST", terminal_id: t.id, project_id: t.project_id, detail: { last_known_pending_count: t.last_known_pending_count, last_known_pending_sen: t.last_known_pending_sen, last_sync_at: t.last_sync_at, reported_at: t.db_empty_at } });
  }
  if (t.pending_count > 0) {
    const since = daysSince(t.last_sync_at ?? t.prepared_at, nowMs);
    if (since != null && since > thresholds.pendingDays) {
      out.push({ type: "PENDING_STALE", terminal_id: t.id, project_id: t.project_id, detail: { pending_count: t.pending_count, pending_amount_sen: t.pending_amount_sen, days_since_sync: Math.floor(since), last_sync_at: t.last_sync_at } });
    }
  }
  if (t.event_end) {
    const endMs = Date.parse(`${t.event_end.slice(0, 10)}T23:59:59+08:00`);
    const pastGrace = nowMs > endMs + thresholds.eventEndDays * DAY;
    const neverSyncedSinceStart = t.event_start ? !t.last_sync_at || mytDate(Date.parse(t.last_sync_at)) < t.event_start.slice(0, 10) : !t.last_sync_at;
    if (pastGrace && (t.pending_count > 0 || (neverSyncedSinceStart && (t.prepared_at ?? "") !== ""))) {
      out.push({ type: "EVENT_ENDED_PENDING", terminal_id: t.id, project_id: t.project_id, detail: { pending_count: t.pending_count, pending_amount_sen: t.pending_amount_sen, event_end: t.event_end, never_synced: neverSyncedSinceStart } });
    }
  }
  return out;
}

export type OpenAlert = { id: number; type: AlertType; terminal_id: number | null; project_id: number | null; email_sent_at: string | null; last_resent_at: string | null };

/** Diff what is open against what is wanted: open the missing, resolve the
 *  rest (auto-resolve at zero pending, or once the device is back). */
export function reconcileAlerts(open: readonly OpenAlert[], wanted: readonly WantedAlert[]): { toOpen: WantedAlert[]; toResolve: OpenAlert[] } {
  const key = (a: { type: AlertType; terminal_id: number | null }) => `${a.type}:${a.terminal_id ?? ""}`;
  const wantedKeys = new Set(wanted.map(key));
  const openKeys = new Set(open.map(key));
  return { toOpen: wanted.filter((w) => !openKeys.has(key(w))), toResolve: open.filter((o) => !wantedKeys.has(key(o))) };
}

/** One email when opened, then once a day while unresolved. */
export function emailDue(a: Pick<OpenAlert, "email_sent_at" | "last_resent_at">, nowMs: number): boolean {
  if (!a.email_sent_at) return true;
  const last = Date.parse(a.last_resent_at ?? a.email_sent_at);
  return nowMs - last >= DAY;
}

export const ALERT_WORDS: Record<AlertType, { title: string; level: "CRITICAL" | "AMBER" }> = {
  DATA_LOST: { title: "Local data lost", level: "CRITICAL" },
  PENDING_STALE: { title: "Pending > 3 days", level: "AMBER" },
  EVENT_ENDED_PENDING: { title: "Event ended, still pending", level: "AMBER" },
};

export function alertSubject(type: AlertType, terminalCode: string, eventName: string | null): string {
  return `[POS ALERT] ${ALERT_WORDS[type].title} · ${terminalCode} · ${eventName ?? "no event"}`;
}

/** The status word of a terminal row on the Sync Status page. */
export function terminalStatusWord(t: TerminalFacts, pendingDays: number, nowMs: number): "SYNCED" | "PENDING" | "PENDING > 3D" | "DATA LOST" | "INACTIVE" | "NOT PREPARED" {
  if (!t.active) return "INACTIVE";
  if (t.db_empty_at) return "DATA LOST";
  if (!t.prepared_at) return "NOT PREPARED";
  if (t.pending_count > 0) {
    const since = daysSince(t.last_sync_at ?? t.prepared_at, nowMs);
    return since != null && since > pendingDays ? "PENDING > 3D" : "PENDING";
  }
  return "SYNCED";
}

/** The summary goes out once the event has ended and nothing is pending on
 *  any of its terminals; a terminal still pending past the grace period is
 *  the alert's business, and the summary waits for it. */
export function summaryDue(event: { end_date: string | null; summary_sent_at: string | null }, terminals: readonly Pick<TerminalFacts, "pending_count" | "active">[], nowMs: number): boolean {
  if (event.summary_sent_at || !event.end_date) return false;
  if (mytDate(nowMs) <= event.end_date.slice(0, 10)) return false;
  return terminals.filter((t) => t.active).every((t) => t.pending_count === 0);
}
