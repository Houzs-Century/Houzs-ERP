// ----------------------------------------------------------------------------
// MemberOrgPerformance — second tab on MemberDetail (Team page).
//
// Left  · Reporting line card (manager → current rep → direct reports, with
//         elbow connectors). Wrapped in .org-print-area so the existing
//         window.print path can scope to just the tree.
// Left  · 6-month sales bar chart (latest month in primary).
// Right · Dark attainment hero (gold % MTD, sales, progress bar w/ target
//         marker, inline KPIs — conversion / avg deal / rank).
// Right · Team leaderboard (rank · avatar · name · attainment bar · % ;
//         current member row bolded with "You" chip).
//
// Backend (per BACKEND-CHECKLIST · C2 — not yet built):
//   GET /api/sales/team-perf/:userId      → MTD attainment + KPIs
//   GET /api/sales/by-rep/:userId?months=N → monthly sales for the bar chart
//   GET /api/sales/team-leaderboard       → ranked attainment list
// Until C2 lands, every panel renders the "Not yet wired · Setup notes"
// state. The reporting tree (the LEFT pane) always works — it derives from
// the members array already loaded by Team.tsx.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Building2,
  Crown,
  Loader2,
  Printer,
  RotateCw,
  TrendingUp,
  Users,
} from "lucide-react";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { usePageAccess } from "../../auth/PageGuard";
import { isDirectorUser, isSalesStaff } from "../../auth/salesAccess";
import { classifyLoadError, errMsg } from "../../components/scm-v2/PhotoGallery";
import { PrintPreviewModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import { cn } from "../../lib/utils";
import { ACCESS_RANK, type TeamMember } from "../../types";
import { fmtCenti } from "@2990s/shared";

// ── Types ───────────────────────────────────────────────────────────────────

export type TeamPerf = {
  mtd_sen: number;
  target_sen: number;
  attainment: number; // 0–2 (1 = 100%)
  conversion: number; // 0–1
  avg_deal_sen: number;
  rank: number;
  total_ranked: number;
  mom_delta: number; // 0.18 for +18%
};

export type MonthlySales = {
  months: Array<{ month: string; sen: number }>;
};

export type LeaderboardRow = {
  user_id: number;
  name: string;
  rank: number;
  attainment: number;
  avatar_initials?: string;
};

const fmtRm = (sen: number | null | undefined, { compact = false } = {}): string => {
  // An absent/non-finite amount reads as "—", never "RM NaN" (owner's plain-
  // language rule: a number the ERP does not have must not render as broken).
  if (sen == null || !Number.isFinite(sen)) return "—";
  if (compact) {
    const k = sen / 1000 / 100;
    if (Math.abs(k) >= 1) {
      return `RM ${k.toLocaleString("en-MY", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}k`;
    }
  }
  return fmtCenti(sen);
};

const fmtPct = (n: number): string => `${Math.round(n * 100)}%`;
const initialsOf = (name: string | null, email: string): string => {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length === 1) return src.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
};

// ── Component ───────────────────────────────────────────────────────────────

export function MemberOrgPerformance({
  user,
  members,
  posName,
  onOpenMember,
}: {
  user: TeamMember;
  members: TeamMember[];
  posName?: string;
  onOpenMember: (id: number) => void;
}) {
  const manager =
    user.manager_id != null
      ? members.find((m) => m.id === user.manager_id) ?? null
      : null;
  const reports = members
    .filter((m) => m.manager_id === user.id)
    .slice()
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  // These three panels are sales-performance reads: a rep's attainment/targets
  // and the ORG-WIDE leaderboard (every rep's numbers). Gate the fetch on the
  // same capability the /api/sales/* routes enforce server-side
  // (requirePageAccessOrSalesView("sales")) — matrix "sales" >= partial OR a
  // code-keyed Sales-staff / director — mirroring the Projects.tsx sales section
  // verbatim so the two can't drift. Off, not hide: a user who can't access
  // sales neither renders these panels (see the canViewSales branch below) nor
  // fires the request, so there is no fetch-then-hide and no render-then-403.
  // The endpoints are not built yet (BACKEND-CHECKLIST C2), so this is
  // pre-emptive today — but it must be in place BEFORE C2 makes the leaderboard
  // return real cross-rep numbers.
  const auth = useAuth();
  const salesLevel = usePageAccess("sales");
  const canViewSales =
    ACCESS_RANK[salesLevel] >= ACCESS_RANK["partial"] ||
    isSalesStaff(auth.user) ||
    isDirectorUser(auth.user);

  // Data queries — gracefully degrade to not-configured.
  const perfQ = useQuery<TeamPerf>({
    queryKey: ["team-perf", user.id],
    queryFn: () => api.get(`/api/sales/team-perf/${user.id}`),
    enabled: canViewSales,
    retry: false,
    staleTime: 60_000,
  });
  const monthlyQ = useQuery<MonthlySales>({
    queryKey: ["team-monthly", user.id, 6],
    queryFn: () => api.get(`/api/sales/by-rep/${user.id}?months=6`),
    enabled: canViewSales,
    retry: false,
    staleTime: 60_000,
  });
  const leaderboardQ = useQuery<{ rows: LeaderboardRow[] }>({
    queryKey: ["team-leaderboard"],
    queryFn: () => api.get(`/api/sales/team-leaderboard`),
    enabled: canViewSales,
    retry: false,
    staleTime: 60_000,
  });

  const [showSetup, setShowSetup] = useState(false);

  const exportOrgChart = () => {
    if (typeof window === "undefined") return;
    document.documentElement.style.setProperty("--print-zoom", "0.85");
    window.print();
  };
  /* Same Print preview every printable surface in the app opens. The chart
     prints from the page itself (.org-print-area), so there is no PDF to
     download or open in a tab — Print is the only exit. */
  const print = usePrintPreview(exportOrgChart);

  return (
    <div className="space-y-4">
      {/* Header row — Export + Setup notes */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Sales Team · Org &amp; Performance
          </div>
          <h2 className="mt-1 font-display text-[16px] font-extrabold tracking-tight text-ink">
            Reporting line, attainment &amp; leaderboard
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowSetup((v) => !v)}
            aria-expanded={showSetup}
            className="text-[12px] font-semibold text-primary underline underline-offset-[3px] decoration-primary/40 hover:text-primary-ink hover:decoration-primary"
          >
            Setup notes
          </button>
          <Button
            variant="primary"
            icon={<Printer size={14} />}
            onClick={print.openPreview}
          >
            Export org chart
          </Button>
          <PrintPreviewModal
            open={print.open}
            onClose={print.close}
            docTitle="Org Chart"
            docNo="Sales team"
            rows={[
              { label: "Prints", value: "The reporting tree only — app chrome is hidden" },
              { label: "Fit", value: "Scaled to 85% so a wide tree isn't clipped" },
            ]}
            onPrint={print.handlers.onPrint}
          />
        </div>
      </div>

      {showSetup && (
        <div className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-[12px] text-primary-ink">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-primary">
            Setup notes · Org &amp; Performance
          </div>
          <p className="mt-1.5 leading-relaxed">
            The reporting tree (left) reads from the same{" "}
            <span className="font-money">manager_id</span> chain that drives the Org Chart
            page — no extra wiring needed. The performance panels (right) and the
            6-month bar chart need three endpoints that aren't built yet
            (BACKEND-CHECKLIST · C2).
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              <span className="font-money">GET /api/sales/team-perf/:userId</span> — MTD
              attainment, conversion, avg deal, rank.
            </li>
            <li>
              <span className="font-money">GET /api/sales/by-rep/:userId?months=6</span> —
              monthly totals for the bar chart.
            </li>
            <li>
              <span className="font-money">GET /api/sales/team-leaderboard</span> — ranked
              attainment list for the leaderboard card.
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-ink-secondary">
            Print path: the existing <span className="font-money">.org-print-area</span>{" "}
            CSS scopes <span className="font-money">window.print()</span> to just the
            reporting tree (no headers / chart / leaderboard). Export org chart triggers it.
          </p>
        </div>
      )}

      {/* Two-pane body — stacks on mobile */}
      <div className="grid gap-4 lg:grid-cols-[312px_1fr] items-start">
        {/* LEFT */}
        <div className="space-y-4">
          {/* Reporting tree */}
          <section
            className="org-print-area rounded-xl border border-border bg-surface p-4 shadow-stone"
            aria-label="Reporting line"
          >
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Reporting line
            </div>
            <div className="mt-3">
              {manager ? (
                <button
                  type="button"
                  onClick={() => onOpenMember(manager.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary-soft/40"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink-secondary text-[10px] font-bold text-white">
                    {initialsOf(manager.name, manager.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-bold text-ink">
                      {manager.name || manager.email}
                    </span>
                    <span className="block truncate text-[10.5px] text-ink-muted">
                      {manager.position_name || manager.role_name}
                    </span>
                  </span>
                  <Crown size={12} className="shrink-0 text-accent" />
                </button>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-surface-2 px-3 py-2 text-[11.5px] italic text-ink-muted">
                  No manager — root of the reporting tree.
                </div>
              )}

              {/* Vertical connector */}
              <div className="ml-[26px] h-3.5 w-[2px] bg-border-strong" aria-hidden />

              {/* Current rep — highlighted */}
              <div className="flex items-center gap-2.5 rounded-lg border-[1.5px] border-primary bg-primary-soft px-3 py-2">
                <Avatar
                  userId={user.id}
                  hasImage={user.profile_pic_r2_key}
                  name={user.name}
                  email={user.email}
                  size={28}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-bold text-primary-ink">
                    {user.name || user.email}
                  </span>
                  <span className="block truncate text-[10.5px] text-primary">
                    {posName || user.position_name || user.role_name} · current
                  </span>
                </span>
                {reports.length > 0 && (
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[9.5px] font-bold text-primary-ink">
                    {reports.length} report{reports.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {/* Reports — elbow connectors */}
              {reports.length > 0 ? (
                <div className="ml-[26px] mt-0 flex">
                  <div
                    className="w-[2px] bg-border-strong"
                    style={{ height: `${reports.length * 48 - 16}px` }}
                    aria-hidden
                  />
                  <div className="-ml-px flex-1 space-y-2 pt-2.5">
                    {reports.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => onOpenMember(r.id)}
                        className="relative flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-primary/40 hover:bg-primary-soft/30"
                      >
                        <span
                          className="absolute top-1/2 h-[2px] w-3.5 bg-border-strong"
                          style={{ left: "-14px" }}
                          aria-hidden
                        />
                        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-dim text-[9.5px] font-bold text-ink-secondary">
                          {initialsOf(r.name, r.email)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] font-semibold text-ink">
                            {r.name || r.email}
                          </span>
                          <span className="block truncate text-[10px] text-ink-muted">
                            {r.position_name || r.role_name}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="ml-[26px] mt-2 rounded-lg border border-dashed border-border bg-surface-2 px-3 py-1.5 text-[10.5px] italic text-ink-muted">
                  No direct reports.
                </div>
              )}
            </div>
          </section>

          {/* 6-month sales bar chart — sales-performance data (off, not hide). */}
          {canViewSales && (
            <MonthlySalesCard q={monthlyQ} onOpenSetup={() => setShowSetup(true)} />
          )}
        </div>

        {/* RIGHT — attainment + leaderboard are sales-performance data. Absent
            entirely for a user who can't view sales; their queries are disabled
            in step with this, so nothing renders and nothing fetches. The
            reporting tree on the LEFT is org-chart data and stays visible. */}
        <div className="space-y-4">
          {canViewSales && (
            <AttainmentHero
              perf={perfQ.data ?? null}
              loading={perfQ.isPending}
              error={perfQ.error ?? null}
              onRetry={() => perfQ.refetch()}
              onOpenSetup={() => setShowSetup(true)}
            />
          )}
          {canViewSales && (
            <LeaderboardCard
              q={leaderboardQ}
              currentUserId={user.id}
              onOpenMember={onOpenMember}
              onOpenSetup={() => setShowSetup(true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Attainment hero (dark) ──────────────────────────────────────────────────

function AttainmentHero({
  perf,
  loading,
  error,
  onRetry,
  onOpenSetup,
}: {
  perf: TeamPerf | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpenSetup: () => void;
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-sidebar p-5 shadow-stone">
        <div className="flex items-center justify-center py-8 text-sidebar-ink-muted">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading attainment…
        </div>
      </div>
    );
  }
  if (error || !perf) {
    const status = error ? classifyLoadError(error) : "ok";
    if (status === "not-configured" || !perf) {
      return (
        <DarkNotConfigured
          title="Attainment not yet wired"
          message="Needs GET /api/sales/team-perf/:userId — see BACKEND-CHECKLIST · C2."
          onRetry={onRetry}
          onOpenSetup={onOpenSetup}
        />
      );
    }
    return (
      <div className="rounded-xl border border-err/40 bg-err/10 p-4 text-[12px] text-err">
        <div className="flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">Couldn't load attainment: {errMsg(error)}</span>
          <Button variant="secondary" icon={<RotateCw size={12} />} onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  const pct = Math.round(perf.attainment * 100);
  // Progress bar fills with petrol→synced; target marker at target/attainment ratio.
  // If attainment ≥ 1, bar is full (100%) and the marker shows where 100% sits.
  const fillPct = Math.min(100, Math.round(perf.attainment * 100));
  const targetMarkerPct =
    perf.attainment > 0 ? Math.round((1 / perf.attainment) * 100) : 100;
  return (
    <div className="rounded-xl bg-sidebar p-5 text-sidebar-ink shadow-[0_8px_24px_-14px_rgba(17,24,16,.5)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-brand text-sidebar-ink-muted">
            Target attainment · MTD
          </div>
          <div className="mt-3 flex items-end gap-1.5">
            <span className="font-money text-[42px] font-extrabold leading-none text-accent-bright">
              {pct}
            </span>
            <span className="text-[18px] font-bold text-accent-bright">%</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9px] font-bold uppercase tracking-brand text-sidebar-ink-muted">
            Sales MTD
          </div>
          <div className="mt-1 font-money text-[18px] font-extrabold">
            {fmtRm(perf.mtd_sen, { compact: true })}
          </div>
          {Number.isFinite(perf.mom_delta) && perf.mom_delta !== 0 && (
            <div
              className={cn(
                "mt-0.5 text-[10px]",
                perf.mom_delta > 0 ? "text-synced" : "text-err",
              )}
            >
              {perf.mom_delta > 0 ? "▲" : "▼"} {fmtPct(Math.abs(perf.mom_delta))} MoM
            </div>
          )}
        </div>
      </div>
      <div className="relative mt-3 h-2.5 overflow-hidden rounded-md bg-sidebar-ink/10">
        <div
          className="h-full rounded-md"
          style={{
            width: `${fillPct}%`,
            background: "linear-gradient(90deg, var(--tw-color-primary, #16695f), #2f8a5b)",
            backgroundColor: "#2f8a5b",
          }}
        />
        {perf.attainment > 0 && (
          <div
            className="absolute -top-1 h-4 w-[2px] bg-accent-bright"
            style={{ left: `${targetMarkerPct}%` }}
            aria-hidden
            title="Target"
          />
        )}
      </div>
      <div className="mt-2 flex justify-between font-money text-[9.5px] text-sidebar-ink-muted">
        <span>Actual {fmtRm(perf.mtd_sen, { compact: true })}</span>
        <span>Target {fmtRm(perf.target_sen, { compact: true })}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-5 border-t border-sidebar-border pt-3">
        <KpiSlot label="Conv. rate" value={fmtPct(perf.conversion)} />
        <KpiSlot label="Avg deal" value={fmtRm(perf.avg_deal_sen, { compact: true })} />
        <KpiSlot
          label="Team rank"
          value={`#${perf.rank} / ${perf.total_ranked}`}
          accent
        />
      </div>
    </div>
  );
}

function KpiSlot({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-brand text-sidebar-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-money text-[16px] font-extrabold",
          accent ? "text-accent-bright" : "text-sidebar-ink",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function DarkNotConfigured({
  title,
  message,
  onRetry,
  onOpenSetup,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  onOpenSetup: () => void;
}) {
  return (
    <div className="rounded-xl bg-sidebar p-5 text-sidebar-ink shadow-[0_8px_24px_-14px_rgba(17,24,16,.5)]">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
        <TrendingUp size={18} />
      </div>
      <div className="mt-3 text-center font-display text-[14px] font-bold text-sidebar-ink">
        {title}
      </div>
      <p className="mx-auto mt-1.5 max-w-[360px] text-center text-[11.5px] leading-relaxed text-sidebar-ink-muted">
        {message}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={onOpenSetup}>
          Setup notes
        </Button>
        <Button
          variant="secondary"
          icon={<RotateCw size={14} />}
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

// ── 6-month bar chart ──────────────────────────────────────────────────────

function MonthlySalesCard({
  q,
  onOpenSetup,
}: {
  q: { data?: MonthlySales; isPending: boolean; error: unknown; refetch: () => void };
  onOpenSetup: () => void;
}) {
  // isPending, not isLoading — isLoading is false while a query is pending but
  // not fetching (offline-paused), which would drop through to the
  // "not configured" branch below before the request had ever run.
  if (q.isPending) {
    return (
      <section className="rounded-xl border border-border bg-surface p-4 shadow-stone">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Monthly sales · last 6 mo
        </div>
        <div className="mt-3 grid grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded" />
          ))}
        </div>
      </section>
    );
  }
  if (q.error || !q.data) {
    const status = q.error ? classifyLoadError(q.error) : "not-configured";
    if (status === "not-configured") {
      return (
        <section className="rounded-xl border border-border bg-surface-2 p-5 text-center shadow-stone">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Monthly sales · last 6 mo
          </div>
          <div className="mx-auto mt-3 flex h-10 w-10 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
            <TrendingUp size={18} />
          </div>
          <div className="mt-2 text-[13px] font-bold text-ink">Chart not yet wired</div>
          <p className="mx-auto mt-1 max-w-[260px] text-[11.5px] text-ink-muted">
            Needs <span className="font-money">GET /api/sales/by-rep/:userId</span> — see
            C2.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={onOpenSetup}>
              Setup notes
            </Button>
            <Button
              variant="secondary"
              icon={<RotateCw size={14} />}
              onClick={q.refetch}
            >
              Retry
            </Button>
          </div>
        </section>
      );
    }
    return (
      <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
        Couldn't load monthly sales: {errMsg(q.error)}
      </div>
    );
  }
  const months = q.data.months ?? [];
  if (months.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface p-4 shadow-stone">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Monthly sales · last 6 mo
        </div>
        <div className="mt-3 rounded-md border border-dashed border-border bg-surface-2 px-3 py-6 text-center text-[11.5px] text-ink-muted">
          No sales recorded yet.
        </div>
      </section>
    );
  }
  const max = Math.max(...months.map((m) => m.sen), 1);
  const lastIdx = months.length - 1;
  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Monthly sales · last 6 mo
      </div>
      <div className="mt-3 flex h-28 items-end gap-2">
        {months.map((m, i) => {
          const h = Math.max(6, Math.round((m.sen / max) * 100));
          return (
            <div
              key={`${m.month}-${i}`}
              className="flex flex-1 flex-col items-center justify-end gap-1"
            >
              <span
                className={cn(
                  "font-money text-[9px] font-bold",
                  i === lastIdx ? "text-primary" : "text-ink-secondary",
                )}
              >
                {fmtRm(m.sen, { compact: true })}
              </span>
              <div
                className={cn(
                  "w-full max-w-[26px] rounded-t-md",
                  i === lastIdx ? "bg-primary" : "bg-primary/40",
                )}
                style={{ height: `${h}%` }}
              />
              <span className="text-[9.5px] text-ink-muted">{m.month}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

function LeaderboardCard({
  q,
  currentUserId,
  onOpenMember,
  onOpenSetup,
}: {
  q: {
    data?: { rows: LeaderboardRow[] };
    isPending: boolean;
    error: unknown;
    refetch: () => void;
  };
  currentUserId: number;
  onOpenMember: (id: number) => void;
  onOpenSetup: () => void;
}) {
  // isPending, not isLoading — see MonthlySalesCard.
  if (q.isPending) {
    return (
      <section className="rounded-xl border border-border bg-surface p-4 shadow-stone">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Team leaderboard · MTD attainment
        </div>
        <div className="mt-3 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-8 rounded" />
          ))}
        </div>
      </section>
    );
  }
  if (q.error || !q.data) {
    const status = q.error ? classifyLoadError(q.error) : "not-configured";
    if (status === "not-configured") {
      return (
        <section className="rounded-xl border border-border bg-surface-2 p-5 text-center shadow-stone">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Team leaderboard · MTD attainment
          </div>
          <div className="mx-auto mt-3 flex h-10 w-10 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
            <Users size={18} />
          </div>
          <div className="mt-2 text-[13px] font-bold text-ink">
            Leaderboard not yet wired
          </div>
          <p className="mx-auto mt-1 max-w-[260px] text-[11.5px] text-ink-muted">
            Needs <span className="font-money">GET /api/sales/team-leaderboard</span> —
            see C2.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={onOpenSetup}>
              Setup notes
            </Button>
            <Button
              variant="secondary"
              icon={<RotateCw size={14} />}
              onClick={q.refetch}
            >
              Retry
            </Button>
          </div>
        </section>
      );
    }
    return (
      <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
        Couldn't load leaderboard: {errMsg(q.error)}
      </div>
    );
  }
  const rows = (q.data.rows ?? [])
    .slice()
    .sort((a, b) => a.rank - b.rank);
  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Team leaderboard · MTD attainment
      </div>
      {rows.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-border bg-surface-2 px-3 py-6 text-center text-[11.5px] text-ink-muted">
          No ranked reps yet.
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-border-subtle">
          {rows.map((r) => {
            const isSelf = r.user_id === currentUserId;
            const pct = Math.round(r.attainment * 100);
            const fill = Math.min(100, pct);
            return (
              <li key={r.user_id}>
                <button
                  type="button"
                  onClick={() => onOpenMember(r.user_id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-1 py-2 text-left transition-colors hover:bg-primary-soft/40",
                  )}
                >
                  <span
                    className={cn(
                      "w-5 text-center font-money text-[12px] font-extrabold",
                      r.rank === 1 ? "text-accent" : "text-ink-secondary",
                    )}
                  >
                    {r.rank}
                  </span>
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white",
                      isSelf ? "bg-primary" : "bg-ink-secondary",
                    )}
                  >
                    {(r.avatar_initials || initialsOf(r.name, "")).slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "truncate text-[12.5px]",
                          isSelf ? "font-extrabold text-ink" : "font-semibold text-ink",
                        )}
                      >
                        {r.name}
                      </span>
                      {isSelf && (
                        <span className="rounded-full bg-primary-soft px-1.5 py-px text-[9px] font-bold text-primary-ink">
                          You
                        </span>
                      )}
                    </span>
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-surface-dim">
                      <div
                        className={cn(
                          "h-full rounded",
                          pct >= 100 ? "bg-synced" : pct >= 80 ? "bg-accent-bright" : "bg-err",
                        )}
                        style={{ width: `${fill}%` }}
                      />
                    </div>
                  </span>
                  <span
                    className={cn(
                      "w-12 text-right font-money text-[12px] font-extrabold tabular-nums",
                      pct >= 100 ? "text-synced" : pct >= 80 ? "text-accent" : "text-err",
                    )}
                  >
                    {pct}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
