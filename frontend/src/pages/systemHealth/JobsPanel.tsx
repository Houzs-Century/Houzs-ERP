import { Timer } from "lucide-react";
import { ListSkeleton } from "../../components/Skeleton";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn, relativeTime } from "../../lib/utils";

export type Verdict = "ok" | "warning" | "critical";

type JobRow = {
  job: string;
  cadence_min: number | null;
  last_start: string | null;
  last_status: "running" | "ok" | "error" | null;
  last_error: string | null;
  duration_ms: number | null;
  runs_24h: number;
  failures_24h: number;
  verdict: Verdict;
  reason: string;
};
type JobsPayload = { ok: boolean; data: JobRow[]; error?: string };

const PILL: Record<Verdict, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "border-synced/40 bg-synced/10 text-synced" },
  warning: { label: "Warning", cls: "border-amber-300 bg-amber-50 text-amber-800" },
  critical: { label: "Critical", cls: "border-err/40 bg-err/10 text-err" },
};

export function StatusPill({ verdict, title }: { verdict: Verdict; title?: string }) {
  const p = PILL[verdict];
  return (
    <span
      className={cn("inline-block rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", p.cls)}
      title={title || undefined}
    >
      {p.label}
    </span>
  );
}

const TH = "px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted";
const TD = "px-2 py-1.5 text-[12px] text-ink";

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function JobsPanel() {
  const q = useQuery<JobsPayload>("/api/admin/health/jobs", () => api.get("/api/admin/health/jobs"));
  const rows = q.data?.data ?? [];
  const bad = rows.filter((r) => r.verdict !== "ok").length;
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          <Timer size={13} className={bad > 0 ? "text-err" : "text-accent"} />
          Background jobs
        </div>
        {q.data?.ok && (
          <span className="text-[10.5px] text-ink-muted">
            {rows.length} jobs · {bad} need attention
          </span>
        )}
      </div>

      {q.loading && !q.data ? (
        <ListSkeleton rows={3} />
      ) : q.error || (q.data && !q.data.ok) ? (
        <div className="py-4 text-center text-[12px] text-ink-muted">
          Could not load background jobs{q.data?.error ? `: ${q.data.error}` : q.error ? `: ${q.error}` : ""}.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-border">
              <tr>
                <th className={TH}>Job</th>
                <th className={TH}>Status</th>
                <th className={TH}>Last start</th>
                <th className={TH}>Took</th>
                <th className={TH}>Runs 24h</th>
                <th className={TH}>Failed 24h</th>
                <th className={TH}>Last error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.job} className="border-b border-border/60 last:border-0">
                  <td className={cn(TD, "font-mono text-[11px]")}>{r.job}</td>
                  <td className={TD}>
                    <StatusPill verdict={r.verdict} title={r.reason} />
                  </td>
                  <td className={cn(TD, "text-ink-muted")} title={r.last_start ?? undefined}>
                    {relativeTime(r.last_start)}
                  </td>
                  <td className={TD}>{fmtMs(r.duration_ms)}</td>
                  <td className={TD}>{r.runs_24h}</td>
                  <td className={cn(TD, r.failures_24h > 0 && "font-semibold text-err")}>{r.failures_24h}</td>
                  <td className={cn(TD, "max-w-[320px] truncate text-ink-muted")} title={r.last_error ?? undefined}>
                    {r.last_error ?? r.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
