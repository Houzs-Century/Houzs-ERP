/* POS Admin > Sync Status (layout E7): the one page that says whether every
 * booth terminal's sales have reached the ERP. KPI tiles, the terminals
 * table with last seen / last sync colour-coded and a status word, the
 * alert log with its email state, and a red / amber banner while an alert
 * is open. Alerts open, email and resolve on their own (cron, every 30
 * minutes); Acknowledge is for the case the watchdog cannot see: the bills
 * were recovered from a backup, or the device is written off. */
import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDateTime } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { POS_ADMIN, useSyncStatus, type SyncAlert, type SyncStatusWord, type SyncTerminal } from "./posAdminApi";
import { Empty, Pill, Table, errText, ghostBtn, td, th } from "./posAdminUi";

const HOUR = 3600_000;

/** Colour of a "last seen" / "last sync" stamp: fresh, stale, or old. */
export function ageTone(iso: string | null, now: number, warnHours: number, badHours: number): "ok" | "warn" | "bad" | "muted" {
  if (!iso) return "muted";
  const h = (now - Date.parse(iso)) / HOUR;
  return h > badHours ? "bad" : h > warnHours ? "warn" : "ok";
}

export const statusTone = (w: SyncStatusWord): "ok" | "warn" | "bad" | "muted" | "info" =>
  w === "SYNCED" ? "ok" : w === "PENDING" ? "info" : w === "PENDING > 3D" ? "warn" : w === "DATA LOST" ? "bad" : "muted";

const ageCls = { ok: "text-emerald-800", warn: "text-amber-800 font-semibold", bad: "text-rose-800 font-semibold", muted: "text-ink-muted" };

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "warn" }) {
  return (
    <div className={cn("rounded-md border border-border bg-surface px-3 py-2", tone === "bad" && "border-rose-400 bg-rose-50", tone === "warn" && "border-amber-400 bg-amber-50")}>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={cn("text-[20px] font-semibold leading-tight", tone === "bad" && "text-rose-800", tone === "warn" && "text-amber-800")}>{value}</div>
      {sub && <div className="text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

export function PosSyncStatusTab() {
  const toast = useToast();
  const dialog = useDialog();
  const nav = useNavigate();
  const status = useSyncStatus();
  const [showResolved, setShowResolved] = useState(false);
  const [detail, setDetail] = useState<SyncTerminal | null>(null);
  const d = status.data;
  const now = d ? Date.parse(d.at) : Date.now();
  const open = (d?.alerts ?? []).filter((a) => !a.resolved_at);
  const critical = open.filter((a) => a.level === "CRITICAL");
  const shown = showResolved ? d?.alerts ?? [] : open;

  async function acknowledge(a: SyncAlert) {
    const ok = await dialog.confirm({
      title: `Acknowledge "${a.title}" on ${a.terminal_code ?? "terminal"}?`,
      message: "Only do this after the bills were recovered with Import backup, or the device is written off. The terminal's pending count is reset to zero and the alert closes; the watchdog will not reopen it unless the device reports pending again.",
      confirmLabel: "Acknowledge", danger: a.level === "CRITICAL",
    });
    if (!ok) return;
    try {
      await api.post(`${POS_ADMIN}/alerts/${a.id}/acknowledge`, {});
      toast.success("Alert acknowledged");
      status.reload();
    } catch (e) {
      toast.error(errText(e, "Could not acknowledge the alert."));
    }
  }

  return (
    <div>
      {critical.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-rose-500 bg-rose-50 p-2 text-[11.5px] text-rose-900">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div><b>CRITICAL: local data lost.</b> {critical.map((a) => `${a.terminal_code ?? "?"} (${a.event_name ?? "no event"}) last reported ${Number(a.detail.last_known_pending_count ?? 0)} unsynced bill(s), ${fmtSen(Number(a.detail.last_known_pending_sen ?? 0))}`).join("; ")}. Recover with <button type="button" className="underline" onClick={() => nav("/pos-admin?tab=import")}>Import backup</button>, then acknowledge below.</div>
        </div>
      )}
      {critical.length === 0 && open.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500 bg-amber-50 p-2 text-[11.5px] text-amber-900">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>{open.map((a) => `${a.terminal_code ?? "?"}: ${a.title.toLowerCase()}`).join("; ")}. Connect the device and open the POS app to sync; the alert closes on its own at zero pending.</div>
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] text-ink-muted">{d ? `As at ${formatDateTime(d.at)} · alerts go to ${d.thresholds.alert_email} · pending > ${d.thresholds.pending_days} days, event end + ${d.thresholds.event_end_days} days` : ""}</span>
        <span className="ml-auto"><button type="button" className={ghostBtn} onClick={() => status.reload()} disabled={status.fetching}><RefreshCw size={11} className={cn(status.fetching && "animate-spin")} /> Refresh</button></span>
      </div>
      {status.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{status.error}</div>}
      {d && (
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Kpi label="Terminals active" value={`${d.kpis.terminals_active} / ${d.kpis.terminals_total}`} sub="prepared / enabled" />
          <Kpi label="Sales pending" value={String(d.kpis.pending_count)} sub="bills still on devices" tone={d.kpis.pending_count > 0 ? "warn" : undefined} />
          <Kpi label="Pending RM" value={fmtSen(d.kpis.pending_sen)} tone={d.kpis.pending_sen > 0 ? "warn" : undefined} />
          <Kpi label="Open alerts" value={String(d.kpis.open_alerts)} sub={d.kpis.critical_alerts > 0 ? `${d.kpis.critical_alerts} critical` : undefined} tone={d.kpis.critical_alerts > 0 ? "bad" : d.kpis.open_alerts > 0 ? "warn" : undefined} />
        </div>
      )}
      {d && d.terminals.length === 0 && <Empty>No terminal yet. Create one on the Terminals tab, then prepare the device.</Empty>}
      {d && d.terminals.length > 0 && (
        <Table minWidth={1040} head={<>
          <th className={th}>Terminal</th><th className={th}>Device</th><th className={th}>Event</th><th className={th}>Last seen</th><th className={th}>Last sync</th><th className={cn(th, "text-right")}>Pending</th><th className={cn(th, "text-right")}>Pending RM</th><th className={th}>Status</th><th className={th} />
        </>}>
          {d.terminals.map((t) => {
            const hb = Math.max(1, d.thresholds.heartbeat_minutes) / 60;
            const seen = ageTone(t.last_seen_at, now, hb * 6, 24);
            const sync = ageTone(t.last_sync_at, now, 24, d.thresholds.pending_days * 24);
            return (
              <tr key={t.id} className={cn("border-t border-border-subtle", t.status_word === "DATA LOST" && "bg-rose-50/60", !t.active && "opacity-60")}>
                <td className={cn(td, "font-mono font-semibold text-accent")}>{t.code}</td>
                <td className={td}>{t.device_name ?? "--"}<div className="text-[9.5px] text-ink-muted">{[t.platform, t.app_version && `v${t.app_version}`].filter(Boolean).join(" · ")}</div></td>
                <td className={td}>{t.event_name ?? <span className="text-ink-muted">none</span>}{t.event_end && <div className="text-[9.5px] text-ink-muted">ends {t.event_end}</div>}</td>
                <td className={cn(td, "text-[10.5px]", ageCls[seen])}>{t.last_seen_at ? formatDateTime(t.last_seen_at) : "never"}</td>
                <td className={cn(td, "text-[10.5px]", t.pending_count > 0 ? ageCls[sync] : ageCls[t.last_sync_at ? "ok" : "muted"])}>{t.last_sync_at ? formatDateTime(t.last_sync_at) : "never"}</td>
                <td className={cn(td, "text-right font-mono", t.pending_count > 0 && "font-semibold text-amber-800")}>{t.pending_count}</td>
                <td className={cn(td, "text-right font-mono", t.pending_amount_sen > 0 && "font-semibold text-amber-800")}>{fmtSen(t.pending_amount_sen)}</td>
                <td className={td}><Pill tone={statusTone(t.status_word)}>{t.status_word}</Pill></td>
                <td className={cn(td, "whitespace-nowrap")}>
                  <button type="button" className={ghostBtn} onClick={() => setDetail(t)}>Details</button>{" "}
                  <button type="button" className={ghostBtn} onClick={() => nav("/pos-admin?tab=import")}>Import backup</button>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      {detail && (
        <div className="mt-2 rounded-md border border-border bg-bg/30 p-2 text-[11px]">
          <div className="mb-1 flex items-center gap-2"><b>{detail.code}</b> {detail.device_name} <button type="button" className={cn(ghostBtn, "ml-auto")} onClick={() => setDetail(null)}>Close</button></div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 md:grid-cols-3">
            <span>Event: {detail.event_name ?? "none"} {detail.event_start && `(${detail.event_start} to ${detail.event_end ?? "?"})`}</span>
            <span>Prepared: {detail.prepared_at ? formatDateTime(detail.prepared_at) : "never"}</span>
            <span>Printer: {detail.printer ?? "--"}</span>
            <span>Receipt counter: {detail.receipt_counter}</span>
            <span>Last known pending: {detail.last_known_pending_count} ({fmtSen(detail.last_known_pending_sen)})</span>
            <span>Data lost reported: {detail.db_empty_at ? formatDateTime(detail.db_empty_at) : "no"}</span>
          </div>
        </div>
      )}
      <div className="mb-1 mt-4 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">Alert log</h3>
        <label className="ml-auto flex items-center gap-1 text-[11px] text-ink-secondary"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved</label>
      </div>
      {d && shown.length === 0 && <Empty>{showResolved ? "No alert has ever been raised." : "No open alert. Every terminal is accounted for."}</Empty>}
      {d && shown.length > 0 && (
        <Table minWidth={900} head={<>
          <th className={th}>Raised</th><th className={th}>Level</th><th className={th}>Alert</th><th className={th}>Terminal</th><th className={th}>Event</th><th className={th}>Detail</th><th className={th}>Email</th><th className={th}>Resolved</th><th className={th} />
        </>}>
          {shown.map((a) => (
            <tr key={a.id} className={cn("border-t border-border-subtle", a.resolved_at && "opacity-60")}>
              <td className={cn(td, "text-[10.5px]")}>{formatDateTime(a.created_at)}</td>
              <td className={td}><Pill tone={a.level === "CRITICAL" ? "bad" : "warn"}>{a.level}</Pill></td>
              <td className={td}>{a.title}</td>
              <td className={cn(td, "font-mono")}>{a.terminal_code ?? "--"}</td>
              <td className={td}>{a.event_name ?? "--"}</td>
              <td className={cn(td, "text-[10.5px] text-ink-muted")}>{alertDetail(a)}</td>
              <td className={cn(td, "text-[10.5px]")}>{a.email_sent_at ? <>sent {formatDateTime(a.email_sent_at)}{a.last_resent_at && <div>re-sent {formatDateTime(a.last_resent_at)}</div>}</> : <Pill tone="muted">NOT YET</Pill>}</td>
              <td className={cn(td, "text-[10.5px]")}>{a.resolved_at ? formatDateTime(a.resolved_at) : <Pill tone="warn">OPEN</Pill>}</td>
              <td className={td}>{!a.resolved_at && <button type="button" className={ghostBtn} onClick={() => void acknowledge(a)}>Acknowledge</button>}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

export function alertDetail(a: Pick<SyncAlert, "type" | "detail">): string {
  const n = (k: string) => Number(a.detail[k] ?? 0);
  if (a.type === "DATA_LOST") return `${n("last_known_pending_count")} bill(s), ${fmtSen(n("last_known_pending_sen"))}, never reached the ERP`;
  if (a.type === "PENDING_STALE") return `${n("pending_count")} bill(s), ${fmtSen(n("pending_amount_sen"))}, ${n("days_since_sync")} day(s) without sync`;
  if (a.type === "EVENT_ENDED_PENDING") return `${n("pending_count")} bill(s), ${fmtSen(n("pending_amount_sen"))}, event ended ${String(a.detail.event_end ?? "").slice(0, 10)}${a.detail.never_synced ? ", never synced" : ""}`;
  return "";
}
