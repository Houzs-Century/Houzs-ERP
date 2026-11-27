import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { api } from "../api/client";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";

export type BriefPrefs = { briefEnabled: boolean; time: string; days: "weekdays" | "daily"; alertsEnabled: boolean };
export type BriefThresholds = {
  soOverdueMinRm: number;
  poOverdueMinRm: number;
  newlyOverdueDays: number;
  slaNewlyPastHours: number;
  stockNegative: boolean;
  repeatAfterDays: number;
  maxLinesPerEmail: number;
  batchPerRun: number;
  runBudgetMs: number;
};
export type BriefView = {
  allowed: boolean;
  email: string;
  prefs: BriefPrefs;
  lastBriefDay: string | null;
  schedule: { brief: string; alerts: string };
  thresholds?: BriefThresholds;
};

const CARD = "rounded-xl border border-border bg-surface";
const SELECT = "h-9 rounded-lg border border-border bg-surface px-2 text-sm text-ink";

export const BRIEF_TIMES: string[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

const rm = (n: number): string => `RM ${n.toLocaleString("en-MY")}`;

/** Admin-only, read-only: the alert thresholds the 30-minute check uses (services/mcp-proactive.ts ALERT_THRESHOLDS). */
export function ThresholdList({ t }: { t: BriefThresholds }) {
  const rows: [string, string][] = [
    ["Sales order newly overdue, worth at least", rm(t.soOverdueMinRm)],
    ["Purchase order newly past the supplier date, worth at least", rm(t.poOverdueMinRm)],
    ["Counts as newly overdue for", `${t.newlyOverdueDays} day(s)`],
    ["Service case counts as newly past deadline for", `${t.slaNewlyPastHours} hours`],
    ["Stock below zero", t.stockNegative ? "On" : "Off"],
    ["Same item emailed again after", `${t.repeatAfterDays} days`],
    ["Lines per alert email, at most", String(t.maxLinesPerEmail)],
    ["People checked per run, at most", String(t.batchPerRun)],
  ];
  return (
    <div className="border-t border-border px-4 py-3 sm:px-5">
      <p className="mb-2 text-[13px] font-semibold text-ink">Alert thresholds (admin view, read-only)</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[1fr_auto]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-secondary">{k}</dt>
            <dd className="font-medium text-ink sm:text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** System > AI Connector: the person's own morning brief and urgent alert emails. */
export function BriefEmails() {
  const [view, setView] = useState<BriefView | null>(null);
  const [draft, setDraft] = useState<BriefPrefs | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    void api
      .get<BriefView>("/api/mcp-admin/me/brief", { signal: ctl.signal })
      .then((v) => {
        setView(v);
        setDraft(v.prefs);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => ctl.abort();
  }, []);

  if (!view || !draft) {
    return err ? (
      <section className={cn(CARD, "p-4")}>
        <p role="alert" className="text-sm text-err">
          Email brief settings could not be loaded: {err}
        </p>
      </section>
    ) : null;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(view.prefs);
  const save = async () => {
    setBusy("save");
    setErr(null);
    setMsg(null);
    try {
      const v = await api.put<BriefView>("/api/mcp-admin/me/brief", draft);
      setView(v);
      setDraft(v.prefs);
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    setErr(null);
    setMsg(null);
    try {
      const r = await api.post<{ sentTo: string }>("/api/mcp-admin/me/brief/test", {});
      setMsg(`Test brief sent to ${r.sentTo}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={cn(CARD, "overflow-hidden")}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Mail size={18} className="text-ink-secondary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-ink">Email me</h2>
          <p className="text-[13px] text-ink-secondary">A morning brief and urgent alerts, built with your own login: only what you can see in the ERP. Sent to {view.email}.</p>
        </div>
      </div>
      {!view.allowed ? (
        <p className="px-4 py-4 text-sm text-ink-muted sm:px-5">Available once AI Connector is turned on for you.</p>
      ) : (
        <div className="space-y-3 px-4 py-3 sm:px-5">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4" checked={draft.briefEnabled} onChange={(e) => setDraft({ ...draft, briefEnabled: e.target.checked })} />
            Morning brief email
          </label>
          <div className="flex flex-wrap items-center gap-2 pl-6 text-sm text-ink-secondary">
            <label htmlFor="brief-time">Time (Malaysia)</label>
            <select id="brief-time" className={SELECT} value={draft.time} disabled={!draft.briefEnabled} onChange={(e) => setDraft({ ...draft, time: e.target.value })}>
              {BRIEF_TIMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label htmlFor="brief-days">Days</label>
            <select id="brief-days" className={SELECT} value={draft.days} disabled={!draft.briefEnabled} onChange={(e) => setDraft({ ...draft, days: e.target.value === "daily" ? "daily" : "weekdays" })}>
              <option value="weekdays">Weekdays (Mon to Fri)</option>
              <option value="daily">Every day</option>
            </select>
          </div>
          <p className="pl-6 text-[12px] text-ink-muted">{view.schedule.brief}</p>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4" checked={draft.alertsEnabled} onChange={(e) => setDraft({ ...draft, alertsEnabled: e.target.checked })} />
            Urgent alert emails (newly overdue orders and POs, service cases past deadline, stock below zero)
          </label>
          <p className="pl-6 text-[12px] text-ink-muted">{view.schedule.alerts}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!dirty || busy !== null} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void test()}>
              Send me a test brief now
            </Button>
            {view.lastBriefDay && <span className="text-[12px] text-ink-muted">Last brief: {view.lastBriefDay}</span>}
          </div>
          {msg && <p className="text-sm text-synced">{msg}</p>}
          {err && (
            <p role="alert" className="text-sm text-err">
              {err}
            </p>
          )}
        </div>
      )}
      {view.thresholds && <ThresholdList t={view.thresholds} />}
    </section>
  );
}
