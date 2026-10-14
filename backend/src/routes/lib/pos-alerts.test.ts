// The Sync Status rules: which alerts a terminal needs, auto-resolve, the
// daily re-send, the status word, and when the end-of-event summary is due.
import { describe, expect, test } from "vitest";
import { alertSubject, emailDue, reconcileAlerts, summaryDue, terminalStatusWord, wantedAlerts, type TerminalFacts } from "./pos-alerts";

const NOW = Date.parse("2026-10-24T04:00:00Z");
const t = (over: Partial<TerminalFacts>): TerminalFacts => ({
  id: 1, code: "T02", device_name: "Tab", active: true, project_id: 9, event_name: "AEON C&C", event_start: "2026-10-10", event_end: "2026-10-20",
  prepared_at: "2026-10-09T02:00:00Z", last_seen_at: "2026-10-24T03:00:00Z", last_sync_at: "2026-10-23T10:00:00Z", pending_count: 0, pending_amount_sen: 0,
  last_known_pending_count: 0, last_known_pending_sen: 0, db_empty_at: null, ...over,
});
const th = { pendingDays: 3, eventEndDays: 3 };

describe("wantedAlerts", () => {
  test("a synced terminal, or one merely offline during the event, needs nothing", () => {
    expect(wantedAlerts(t({}), th, NOW)).toEqual([]);
    expect(wantedAlerts(t({ pending_count: 4, last_sync_at: "2026-10-23T10:00:00Z", event_end: "2026-10-30" }), th, NOW)).toEqual([]);
  });
  test("pending for more than the threshold is PENDING_STALE; never synced counts from Prepare", () => {
    expect(wantedAlerts(t({ pending_count: 4, last_sync_at: "2026-10-20T10:00:00Z", event_end: "2026-10-30" }), th, NOW).map((a) => a.type)).toEqual(["PENDING_STALE"]);
    expect(wantedAlerts(t({ pending_count: 1, last_sync_at: null, prepared_at: "2026-10-19T00:00:00Z", event_end: "2026-10-30" }), th, NOW).map((a) => a.type)).toEqual(["PENDING_STALE"]);
  });
  test("event end + grace with pending, or never synced since the event, is EVENT_ENDED_PENDING", () => {
    expect(wantedAlerts(t({ pending_count: 2, last_sync_at: "2026-10-23T10:00:00Z" }), th, NOW).map((a) => a.type)).toEqual(["EVENT_ENDED_PENDING"]);
    expect(wantedAlerts(t({ pending_count: 0, last_sync_at: "2026-10-05T10:00:00Z" }), th, NOW).map((a) => a.type)).toEqual(["EVENT_ENDED_PENDING"]);
    expect(wantedAlerts(t({ pending_count: 2 }), th, Date.parse("2026-10-22T04:00:00Z"))).toEqual([]);
  });
  test("an empty device that last reported pending is DATA_LOST, critical, immediately; inactive terminals never alert", () => {
    const a = wantedAlerts(t({ db_empty_at: "2026-10-24T03:00:00Z", last_known_pending_count: 7, last_known_pending_sen: 123400 }), th, NOW);
    expect(a.map((x) => x.type)).toEqual(["DATA_LOST"]);
    expect(a[0]!.detail).toMatchObject({ last_known_pending_count: 7, last_known_pending_sen: 123400 });
    expect(wantedAlerts(t({ active: false, db_empty_at: "2026-10-24T03:00:00Z", pending_count: 9 }), th, NOW)).toEqual([]);
  });
});

describe("reconcile, email cadence, words", () => {
  test("opens what is missing and resolves what is no longer wanted", () => {
    const r = reconcileAlerts(
      [{ id: 1, type: "PENDING_STALE", terminal_id: 1, project_id: 9, email_sent_at: null, last_resent_at: null }, { id: 2, type: "DATA_LOST", terminal_id: 2, project_id: 9, email_sent_at: null, last_resent_at: null }],
      [{ type: "PENDING_STALE", terminal_id: 1, project_id: 9, detail: {} }, { type: "EVENT_ENDED_PENDING", terminal_id: 1, project_id: 9, detail: {} }],
    );
    expect(r.toOpen.map((a) => a.type)).toEqual(["EVENT_ENDED_PENDING"]);
    expect(r.toResolve.map((a) => a.id)).toEqual([2]);
  });
  test("one email at open, then daily", () => {
    expect(emailDue({ email_sent_at: null, last_resent_at: null }, NOW)).toBe(true);
    expect(emailDue({ email_sent_at: "2026-10-23T05:00:00Z", last_resent_at: null }, NOW)).toBe(false);
    expect(emailDue({ email_sent_at: "2026-10-22T05:00:00Z", last_resent_at: null }, NOW)).toBe(true);
    expect(emailDue({ email_sent_at: "2026-10-20T05:00:00Z", last_resent_at: "2026-10-23T05:00:00Z" }, NOW)).toBe(false);
  });
  test("subject and status word", () => {
    expect(alertSubject("DATA_LOST", "T02", "AEON C&C")).toBe("[POS ALERT] Local data lost · T02 · AEON C&C");
    expect(terminalStatusWord(t({}), 3, NOW)).toBe("SYNCED");
    expect(terminalStatusWord(t({ pending_count: 1 }), 3, NOW)).toBe("PENDING");
    expect(terminalStatusWord(t({ pending_count: 1, last_sync_at: "2026-10-19T00:00:00Z" }), 3, NOW)).toBe("PENDING > 3D");
    expect(terminalStatusWord(t({ db_empty_at: "x" }), 3, NOW)).toBe("DATA LOST");
    expect(terminalStatusWord(t({ active: false }), 3, NOW)).toBe("INACTIVE");
    expect(terminalStatusWord(t({ prepared_at: null }), 3, NOW)).toBe("NOT PREPARED");
  });
  test("the summary is due once the event is over and every active terminal is clean, and only once", () => {
    expect(summaryDue({ end_date: "2026-10-20", summary_sent_at: null }, [t({}), t({ pending_count: 0 })], NOW)).toBe(true);
    expect(summaryDue({ end_date: "2026-10-20", summary_sent_at: null }, [t({}), t({ pending_count: 2 })], NOW)).toBe(false);
    expect(summaryDue({ end_date: "2026-10-20", summary_sent_at: null }, [t({}), t({ pending_count: 2, active: false })], NOW)).toBe(true);
    expect(summaryDue({ end_date: "2026-10-24", summary_sent_at: null }, [t({})], NOW)).toBe(false);
    expect(summaryDue({ end_date: "2026-10-20", summary_sent_at: "2026-10-22T00:00:00Z" }, [t({})], NOW)).toBe(false);
  });
});
