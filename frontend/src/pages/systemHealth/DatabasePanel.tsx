import type { ReactNode } from "react";
import { Database } from "lucide-react";
import { ListSkeleton } from "../../components/Skeleton";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";

// Database load for the IT System Health section (DEV-35). Backend:
// backend/src/routes/systemHealthDatabase.ts. Each metric arrives with its
// own verdict; a metric that failed to read shows its error, not a zero.

type Verdict = "ok" | "warning" | "critical";
type Metric<T = object> =
  | ({ ok: true; value: number; limit: number | null; threshold: string; verdict: Verdict } & T)
  | { ok: false; error: string };

export type DatabaseHealth = {
  ok: boolean;
  error?: string;
  checkedAt: string;
  limitedVisibility: boolean;
  visibilityNote: string | null;
  longTransactions: Metric<{
    sessions: Array<{ seconds: number; state: string | null; waitEventType: string | null; query: string | null }>;
  }>;
  lockWaits: Metric<{ longestWaitSeconds: number | null }>;
  connections: Metric<{ maxConnections: number; poolerCap: number }>;
  databaseSize: Metric<{ largestTables: Array<{ name: string; bytes: number }> }>;
  tempFiles: Metric<{ tempFiles: number; statsReset: string | null }>;
};

const PILL: Record<Verdict, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "border-synced/40 bg-synced/10 text-synced" },
  warning: { label: "Warning", cls: "border-amber-300 bg-amber-50 text-amber-800" },
  critical: { label: "Critical", cls: "border-err/40 bg-err/10 text-err" },
};

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function seconds(s: number): string {
  return s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
}

function Row({
  label,
  metric,
  shown,
  detail,
}: {
  label: string;
  metric: Metric;
  shown: (value: number) => string;
  detail?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 border-t border-border py-3 first:border-t-0">
      <div className="w-44 shrink-0 text-[12.5px] font-semibold text-ink">{label}</div>
      {metric.ok ? (
        <>
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold",
              PILL[metric.verdict].cls,
            )}
          >
            {PILL[metric.verdict].label}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-display text-[15px] font-extrabold tracking-tight text-ink">
              {shown(metric.value)}
              {metric.limit !== null && (
                <span className="ml-1 text-[12px] font-normal text-ink-muted">/ {shown(metric.limit)}</span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted">{metric.threshold}</div>
            {detail}
          </div>
        </>
      ) : (
        <div className="min-w-0 flex-1 text-[12px] text-err">Could not read: {metric.error}</div>
      )}
    </div>
  );
}

const PATH = "/api/admin/health/database";

export function DatabasePanel() {
  const q = useQuery<DatabaseHealth>(PATH, () => api.get(PATH));
  const d = q.data;

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          <Database size={13} className="text-accent" /> Database load
        </div>
        {d?.checkedAt && <span className="text-[10.5px] text-ink-muted">Checked {new Date(d.checkedAt).toLocaleTimeString()}</span>}
      </div>

      {q.loading && !d ? (
        <ListSkeleton rows={5} />
      ) : q.error || !d || !d.ok ? (
        <div className="py-4 text-center text-[12px] text-ink-muted">
          Could not load the database figures{q.error ? `: ${q.error}` : d?.error ? `: ${d.error}` : ""}.
        </div>
      ) : (
        <>
          {d.limitedVisibility && d.visibilityNote && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-[11.5px] text-amber-800">
              {d.visibilityNote}
            </div>
          )}
          <Row
            label="Long-running transactions"
            metric={d.longTransactions}
            shown={String}
            detail={
              d.longTransactions.ok &&
              d.longTransactions.sessions.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {d.longTransactions.sessions.map((s, i) => (
                    <li key={i} className="text-[11px] text-ink-secondary">
                      <span className="font-semibold">{seconds(s.seconds)}</span> · {s.state ?? "unknown"}
                      {s.waitEventType ? ` · waiting on ${s.waitEventType}` : ""}
                      {s.query && <div className="truncate font-mono text-[10.5px] text-ink-muted">{s.query}</div>}
                    </li>
                  ))}
                </ul>
              )
            }
          />
          <Row
            label="Lock waits"
            metric={d.lockWaits}
            shown={String}
            detail={
              d.lockWaits.ok &&
              d.lockWaits.longestWaitSeconds !== null && (
                <div className="mt-1 text-[11px] text-ink-secondary">
                  Longest wait {seconds(d.lockWaits.longestWaitSeconds)}
                </div>
              )
            }
          />
          <Row
            label="Connections"
            metric={d.connections}
            shown={String}
            detail={
              d.connections.ok && (
                <div className="mt-1 text-[11px] text-ink-secondary">
                  Database setting {d.connections.maxConnections}, pooler cap {d.connections.poolerCap}
                </div>
              )
            }
          />
          <Row
            label="Database size"
            metric={d.databaseSize}
            shown={formatBytes}
            detail={
              d.databaseSize.ok && (
                <ul className="mt-2 space-y-0.5">
                  {d.databaseSize.largestTables.map((t) => (
                    <li key={t.name} className="text-[11px] text-ink-secondary">
                      <span className="font-mono">{t.name}</span> {formatBytes(t.bytes)}
                    </li>
                  ))}
                </ul>
              )
            }
          />
          <Row
            label="Temporary disk"
            metric={d.tempFiles}
            shown={formatBytes}
            detail={
              d.tempFiles.ok && (
                <div className="mt-1 text-[11px] text-ink-secondary">
                  {d.tempFiles.tempFiles.toLocaleString()} temp files
                  {d.tempFiles.statsReset ? ` since ${new Date(d.tempFiles.statsReset).toLocaleDateString()}` : ""}
                </div>
              )
            }
          />
        </>
      )}
    </div>
  );
}
