import { KeyRound } from "lucide-react";
import { ListSkeleton } from "../../components/Skeleton";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn, relativeTime } from "../../lib/utils";

type Verdict = "ok" | "warning" | "critical";

export type LoginsPayload = {
  ok: boolean;
  error?: string;
  verdict?: Verdict;
  failed_24h?: number;
  failed_7d?: number;
  rate_limited_24h?: number;
  rate_limited_7d?: number;
  top_emails_24h?: Array<{ email: string; user_id: number | null; failures: number; last_attempt_at: string }>;
  top_ips_24h?: Array<{ ip: string; failures: number; last_attempt_at: string }>;
};

const PILL: Record<Verdict, { cls: string; label: string }> = {
  ok: { cls: "border-synced/40 bg-synced/10 text-synced", label: "Normal" },
  warning: { cls: "border-amber-300 bg-amber-50 text-amber-800", label: "Warning" },
  critical: { cls: "border-err/40 bg-err/10 text-err", label: "Critical" },
};

const LOGINS_URL = "/api/admin/health/logins";

/** Failed sign-ins (DEV-35): totals, a verdict, and the top emails and IPs in the last 24 h. */
export function LoginsPanel() {
  const q = useQuery<LoginsPayload>(LOGINS_URL, () => api.get(LOGINS_URL));
  const d = q.data;
  const pill = d?.verdict ? PILL[d.verdict] : null;

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          <KeyRound size={13} className="text-accent" />
          Failed logins
        </div>
        {pill && (
          <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", pill.cls)}>
            {pill.label}
          </span>
        )}
      </div>

      {q.loading && !d ? (
        <ListSkeleton rows={3} />
      ) : q.error || !d?.ok ? (
        <div className="py-4 text-center text-[12px] text-ink-muted">
          Could not load failed logins{d?.error ? `: ${d.error}` : q.error ? `: ${q.error}` : ""}.
        </div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3">
            <Total label="Last 24 hours" value={d.failed_24h ?? 0} rateLimited={d.rate_limited_24h ?? 0} />
            <Total label="Last 7 days" value={d.failed_7d ?? 0} rateLimited={d.rate_limited_7d ?? 0} />
          </div>
          <div className="grid grid-cols-2 gap-5">
            <TopList
              title="Most tried emails (24 h)"
              empty="No failed logins in the last 24 hours."
              rows={(d.top_emails_24h ?? []).map((r) => ({
                key: r.email,
                name: r.email,
                note: r.user_id == null ? "no such account" : `user #${r.user_id}`,
                failures: r.failures,
                last: r.last_attempt_at,
              }))}
            />
            <TopList
              title="Most active IPs (24 h)"
              empty="No failed logins in the last 24 hours."
              rows={(d.top_ips_24h ?? []).map((r) => ({
                key: r.ip,
                name: r.ip,
                note: null,
                failures: r.failures,
                last: r.last_attempt_at,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Total({ label, value, rateLimited }: { label: string; value: number; rateLimited: number }) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1.5 font-display text-[22px] font-extrabold leading-none tracking-tight text-ink">
        {value.toLocaleString()}
      </div>
      <div className="mt-1 text-[10.5px] text-ink-muted">{rateLimited.toLocaleString()} blocked by the rate limit</div>
    </div>
  );
}

type TopRow = { key: string; name: string; note: string | null; failures: number; last: string };

function TopList({ title, empty, rows }: { title: string; empty: string; rows: TopRow[] }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold text-ink">{title}</div>
      {rows.length === 0 ? (
        <div className="py-3 text-[12px] text-ink-muted">{empty}</div>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-brand text-ink-muted">
              <th className="pb-1 font-semibold">Who</th>
              <th className="pb-1 text-right font-semibold">Failures</th>
              <th className="pb-1 text-right font-semibold">Last try</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="py-1.5">
                  <div className="text-ink">{r.name}</div>
                  {r.note && <div className="text-[10.5px] text-ink-muted">{r.note}</div>}
                </td>
                <td className="py-1.5 text-right font-semibold tabular-nums">{r.failures.toLocaleString()}</td>
                <td className="py-1.5 text-right text-ink-muted">{relativeTime(r.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
