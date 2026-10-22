// ---------------------------------------------------------------------------
// AI Usage — what the Anthropic API cost each month, by feature and by company.
// IT pages only (ItPagesGuard + the server's requireItPages). Every number comes
// from GET /api/admin/ai-usage; the page only lays it out. Desktop only.
// ---------------------------------------------------------------------------
import { useSearchParams } from "react-router-dom";
import { RefreshCw, Sparkles } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { ListSkeleton } from "../components/Skeleton";
import { DataTable, type Column } from "../components/DataTable";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";

type FeatureUsage = {
  feature: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rm: number;
};
type CompanyUsage = { companyId: number | null; companyName: string | null; rm: number };
type MonthUsage = {
  month: string;
  totalRm: number;
  partial: boolean;
  note: string | null;
  features: FeatureUsage[];
  companies: CompanyUsage[];
};
export type AiUsageReport = { months: MonthUsage[]; usdToRm: number; firstRecordedAt: string | null };

const MONTHS = 6;

export const fmtRm = (n: number) =>
  `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n: number) => n.toLocaleString("en-MY");

/** "2026-10" -> "Oct 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-MY", { month: "short", year: "numeric", timeZone: "UTC" });
}

const FEATURE_COLUMNS: Column<FeatureUsage>[] = [
  { key: "feature", label: "Feature", getValue: (r) => r.feature, render: (r) => <span className="font-mono text-[11px] text-ink">{r.feature}</span> },
  { key: "calls", label: "Calls", align: "right", getValue: (r) => r.calls, render: (r) => fmtInt(r.calls) },
  {
    key: "failures", label: "Failed", align: "right", getValue: (r) => r.failures,
    render: (r) => <span className={r.failures > 0 ? "font-semibold text-err" : undefined}>{fmtInt(r.failures)}</span>,
  },
  { key: "input", label: "Input tokens", align: "right", getValue: (r) => r.inputTokens, render: (r) => fmtInt(r.inputTokens) },
  { key: "output", label: "Output tokens", align: "right", getValue: (r) => r.outputTokens, render: (r) => fmtInt(r.outputTokens) },
  {
    key: "cache", label: "Cache read / write", align: "right", getValue: (r) => r.cacheReadTokens + r.cacheWriteTokens,
    render: (r) => `${fmtInt(r.cacheReadTokens)} / ${fmtInt(r.cacheWriteTokens)}`,
  },
  { key: "rm", label: "Cost", align: "right", getValue: (r) => r.rm, render: (r) => <span className="font-semibold text-ink">{fmtRm(r.rm)}</span> },
];

const COMPANY_COLUMNS: Column<CompanyUsage>[] = [
  {
    key: "company", label: "Company", getValue: (r) => r.companyName ?? "",
    render: (r) => r.companyName ?? <span className="text-ink-muted">Not tied to a company (crons, agents)</span>,
  },
  { key: "rm", label: "Cost", align: "right", getValue: (r) => r.rm, render: (r) => <span className="font-semibold text-ink">{fmtRm(r.rm)}</span> },
];

function MonthBars({ months, selected, onSelect }: { months: MonthUsage[]; selected: string; onSelect: (m: string) => void }) {
  const max = Math.max(...months.map((m) => m.totalRm), 0.01);
  return (
    <div className="flex h-44 items-end gap-3" role="group" aria-label="Cost per month">
      {months.map((m) => (
        <button
          key={m.month}
          type="button"
          onClick={() => onSelect(m.month)}
          aria-pressed={m.month === selected}
          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          title={m.note ?? undefined}
        >
          <span className="text-[10.5px] font-semibold text-ink">{fmtRm(m.totalRm)}</span>
          <span
            className={cn(
              "w-full rounded-t-md border border-border",
              m.month === selected ? "bg-primary" : "bg-primary/30",
              m.partial && "border-dashed",
            )}
            style={{ height: `${Math.max(2, (m.totalRm / max) * 100)}%` }}
          />
          <span className={cn("text-[11px]", m.month === selected ? "font-semibold text-ink" : "text-ink-muted")}>
            {monthLabel(m.month)}
            {m.partial ? " *" : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

export function AiUsage() {
  const [params, setParams] = useSearchParams();
  const q = useQuery<AiUsageReport>(`/api/admin/ai-usage?months=${MONTHS}`, () => api.get(`/api/admin/ai-usage?months=${MONTHS}`));
  const months = q.data?.months ?? [];
  const current = months.at(-1);
  const selected = months.find((m) => m.month === params.get("month")) ?? current;
  const select = (month: string) => setParams((p) => { p.set("month", month); return p; }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System · IT"
        title="AI Usage"
        description="What the AI features cost each month, from the token counts Anthropic returns on every call. Estimates in RM; the Anthropic invoice is the final figure."
        actions={
          <Button variant="secondary" icon={<RefreshCw size={14} className={q.loading ? "animate-spin" : undefined} />} onClick={() => q.reload()}>
            Refresh
          </Button>
        }
      />

      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">Failed to load AI usage: {q.error}</div>
      )}

      {!q.data && q.loading ? (
        <ListSkeleton rows={4} />
      ) : (
        current && selected && (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  <Sparkles size={13} className="text-accent" /> This month ({monthLabel(current.month)})
                </div>
                <div className="mt-2 font-display text-[26px] font-extrabold leading-none tracking-tight text-ink">{fmtRm(current.totalRm)}</div>
                <p className="mt-2 text-[11px] text-ink-muted">At USD 1 = RM {q.data?.usdToRm}, the same rate as the Agent Console.</p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone lg:col-span-2">
                <div className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Last {months.length} months · click a month for its breakdown
                </div>
                <MonthBars months={months} selected={selected.month} onSelect={select} />
              </div>
            </div>

            {selected.note && (
              <div className="rounded-md border border-amber-300 bg-warning-bg p-3 text-[12px] text-warning-text">
                {monthLabel(selected.month)}: {selected.note}
              </div>
            )}

            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-4 flex items-center justify-between text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                <span>By feature · {monthLabel(selected.month)}</span>
                <span>{fmtRm(selected.totalRm)}</span>
              </div>
              {selected.features.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">No AI calls recorded this month.</div>
              ) : (
                <DataTable<FeatureUsage> tableId="ai-usage-features" columns={FEATURE_COLUMNS} rows={selected.features} getRowKey={(r) => r.feature} />
              )}
            </div>

            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-4 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                By company · {monthLabel(selected.month)}
              </div>
              {selected.companies.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">No AI calls recorded this month.</div>
              ) : (
                <DataTable<CompanyUsage>
                  tableId="ai-usage-companies"
                  columns={COMPANY_COLUMNS}
                  rows={selected.companies}
                  getRowKey={(r) => String(r.companyId)}
                />
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}
