import { Send } from "lucide-react";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn, relativeTime } from "../../lib/utils";

// One line: does the 5-minute health report reach the IT Hub
// (backend services/healthHub.ts)? Read from its job_runs rows.

export type HubReportPayload =
  | {
      ok: true;
      configured: boolean;
      last_success_at: string | null;
      last_failure_at: string | null;
      last_error: string | null;
    }
  | { ok: false; configured: boolean; error: string };

/** Pure: the sentence and whether it is bad news. A failure newer than the last
 *  success means the report is not getting through right now. */
export function hubReportText(p: HubReportPayload, ago: (iso: string) => string): { text: string; bad: boolean } {
  if (!p.ok) return { text: `Could not load (${p.error})`, bad: true };
  if (!p.configured) return { text: "Not set up on this system (IT Hub address or key missing), so nothing is sent", bad: false };
  const ok = p.last_success_at ? Date.parse(p.last_success_at) : null;
  const failed = p.last_failure_at ? Date.parse(p.last_failure_at) : null;
  if (failed != null && (ok == null || failed > ok)) {
    return {
      text: `Last attempt failed ${ago(p.last_failure_at!)}${p.last_error ? `: ${p.last_error}` : ""}${ok != null ? ` · last sent ${ago(p.last_success_at!)}` : ""}`,
      bad: true,
    };
  }
  if (ok == null) return { text: "Not sent yet in the last 14 days", bad: true };
  return { text: `Last sent ${ago(p.last_success_at!)}, every 5 minutes`, bad: false };
}

export function HubReportLine() {
  const q = useQuery<HubReportPayload>("/api/admin/health/hub-report", () => api.get("/api/admin/health/hub-report"));
  if (!q.data) return null;
  const { text, bad } = hubReportText(q.data, relativeTime);
  return (
    <div
      data-testid="hub-report-line"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface px-5 py-3 shadow-stone"
    >
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <Send size={13} className={bad ? "text-err" : "text-accent"} />
        Health report to IT Hub
      </span>
      <span className={cn("text-[12px]", bad ? "text-err" : "text-ink")}>{text}</span>
    </div>
  );
}
