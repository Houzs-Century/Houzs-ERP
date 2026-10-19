import { Plug } from "lucide-react";
import { ListSkeleton } from "../../components/Skeleton";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn, relativeTime } from "../../lib/utils";

// Outside services (DEV-35): one row per service from GET /api/admin/health/services.
// The verdicts are computed server-side (backend/src/services/serviceHealth.ts).

export type ServiceStatus = "ok" | "warning" | "critical" | "not_tracked" | "not_tracked_yet" | "unknown";

export type ServiceRow = {
  key: string;
  name: string;
  status: ServiceStatus;
  ok: boolean;
  error?: string;
  note: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  attempts_24h: number | null;
  failures_24h: number | null;
};

type ServicesPayload = { ok: boolean; time: string; services: ServiceRow[] };

const PILL: Record<ServiceStatus, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "border-synced/40 bg-synced/10 text-synced" },
  warning: { label: "Warning", cls: "border-amber-300 bg-amber-50 text-amber-800" },
  critical: { label: "Critical", cls: "border-err/40 bg-err/10 text-err" },
  not_tracked: { label: "Not tracked", cls: "border-border bg-surface text-ink-muted" },
  not_tracked_yet: { label: "Not tracked", cls: "border-border bg-surface text-ink-muted" },
  unknown: { label: "Unknown", cls: "border-border bg-surface text-ink-muted" },
};

const when = (d: string | null) => (
  <span className="font-mono text-[10.5px] text-ink-muted" title={d ?? undefined}>{relativeTime(d)}</span>
);

export function ServicesPanel() {
  const q = useQuery<ServicesPayload>("/api/admin/health/services", () => api.get("/api/admin/health/services"));
  const rows = q.data?.services ?? [];
  const bad = rows.some((r) => r.status === "critical" || !r.ok);

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <Plug size={13} className={bad ? "text-err" : "text-accent"} />
        Outside services
      </div>

      {q.loading && !q.data ? (
        <ListSkeleton rows={4} />
      ) : q.error ? (
        <div className="py-4 text-center text-[12px] text-ink-muted">Could not load services: {q.error}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                <th className="py-2 pr-3">Service</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last success</th>
                <th className="py-2 pr-3">Last failure</th>
                <th className="py-2 pr-3 text-right">Failures 24 h</th>
                <th className="py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pill = PILL[r.status];
                const tracked = r.status !== "not_tracked" && r.status !== "not_tracked_yet";
                return (
                  <tr key={r.key} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-2 pr-3 font-semibold text-ink">{r.name}</td>
                    <td className="py-2 pr-3">
                      <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", pill.cls)}>
                        {pill.label}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{tracked ? when(r.last_success_at) : "—"}</td>
                    <td className="py-2 pr-3">{tracked ? when(r.last_failure_at) : "—"}</td>
                    <td className="py-2 pr-3 text-right font-semibold text-ink">
                      {r.failures_24h == null ? "—" : `${r.failures_24h} / ${r.attempts_24h ?? 0}`}
                    </td>
                    <td className="py-2 text-ink-muted">
                      {!r.ok ? (
                        <span className="text-err">Could not read: {r.error}</span>
                      ) : (
                        [r.note, r.last_error].filter(Boolean).join(" · ") || "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
