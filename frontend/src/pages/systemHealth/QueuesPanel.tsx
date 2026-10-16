import { Inbox } from "lucide-react";
import { ListSkeleton } from "../../components/Skeleton";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";
import { StatusPill, type Verdict } from "./JobsPanel";

const TH = "px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-brand text-ink-muted";
const TD = "px-2 py-1.5 text-[12px] text-ink";

type QueueRow =
  | {
      name: string;
      label: string;
      ok: true;
      waiting: number;
      failed: number;
      oldest_waiting_min: number | null;
      verdict: Verdict;
      reason: string;
    }
  | { name: string; label: string; ok: false; error: string };
type QueuesPayload = {
  ok: boolean;
  error?: string;
  queues: QueueRow[];
  failed_slip_scans: { ok: true; count_7d: number } | { ok: false; error: string };
};

function fmtAge(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

export function QueuesPanel() {
  const q = useQuery<QueuesPayload>("/api/admin/health/queues", () => api.get("/api/admin/health/queues"));
  const rows = q.data?.queues ?? [];
  const slips = q.data?.failed_slip_scans;
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          <Inbox size={13} className="text-accent" />
          Waiting queues
        </div>
        {slips && (
          <span className={cn("text-[10.5px]", slips.ok && slips.count_7d > 0 ? "text-err" : "text-ink-muted")}>
            {slips.ok
              ? `Failed order-slip scans, 7 days: ${slips.count_7d}`
              : `Failed order-slip scans: could not load (${slips.error})`}
          </span>
        )}
      </div>

      {q.loading && !q.data ? (
        <ListSkeleton rows={3} />
      ) : q.error || (q.data && !q.data.ok) ? (
        <div className="py-4 text-center text-[12px] text-ink-muted">
          Could not load queues{q.data?.error ? `: ${q.data.error}` : q.error ? `: ${q.error}` : ""}.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-border">
              <tr>
                <th className={TH}>Queue</th>
                <th className={TH}>Status</th>
                <th className={TH}>Waiting</th>
                <th className={TH}>Oldest waiting</th>
                <th className={TH}>Failed / dead</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-b border-border/60 last:border-0">
                  <td className={TD}>{r.label}</td>
                  {r.ok ? (
                    <>
                      <td className={TD}>
                        <StatusPill verdict={r.verdict} title={r.reason} />
                      </td>
                      <td className={TD}>{r.waiting}</td>
                      <td className={TD}>{fmtAge(r.oldest_waiting_min)}</td>
                      <td className={cn(TD, r.failed > 0 && "font-semibold text-err")}>{r.failed}</td>
                    </>
                  ) : (
                    <td className={cn(TD, "text-err")} colSpan={4}>
                      Could not read: {r.error}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
