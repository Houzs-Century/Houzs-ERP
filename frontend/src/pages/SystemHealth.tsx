import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bug,
  Database,
  Gauge,
  ShieldAlert,
  RefreshCw,
  Clock,
  Users,
  ClipboardCheck,
  HardDrive,
  KeyRound,
  Boxes,
  Timer,
  ArrowUp,
  X,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DashboardBreakdown } from "../components/Dashboard";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery, type QueryState } from "../hooks/useQuery";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

// ---------------------------------------------------------------------------
// System Health — owner-only ("*"). "Real data" phase 1, ported from Hookka's
// /admin/health but limited to what runs on Houzs's current infra (no
// Cloudflare Analytics Engine yet): live DB/connection health (so the
// cold-start stall is visible), KV reachability, headcount, and the
// audit_events feed. AE-backed latency-percentile / slow-SQL / RUM panels are
// deferred to phase 2.
// ---------------------------------------------------------------------------

type LivePayload = {
  ok: boolean;
  time: string;
  db: { ok: boolean; latency_ms: number; error?: string };
  kv: { bound: boolean; ok: boolean; latency_ms: number };
  // R2 slip/photo bucket, Anthropic-key presence, and the SCM-route probe — all
  // fed by /live but previously ignored here, so the banner showed green while
  // SCM or R2 was down. Optional-ish (older deploys may omit them) so the banner
  // logic guards on presence.
  r2?: { bound: boolean; ok: boolean; latency_ms: number };
  anthropic?: { configured: boolean };
  scm?: { configured: boolean; ok: boolean; latency_ms: number; error?: string };
  counts: {
    users_active: number;
    users_invited: number;
    users_disabled: number;
    audit_24h: number;
    audit_7d: number;
    sensitive_24h: number;
    last_event_at: string | null;
  };
};

type AuditRow = {
  // public.audit_events rows are numeric ids; merged SCM rows arrive as
  // "scm:<uuid>" strings — so the key type is widened to string | number.
  id: number | string;
  created_at: string;
  actor_id: number | string | null;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
};

type LedgerPayload = {
  check: string;
  label: string;
  ok: boolean;
  status: "ok" | "warn" | "unknown";
  configured: boolean;
  issueCount: number;
  asOf?: string;
  error?: string;
};
type AuditFeed = {
  success: boolean;
  data: AuditRow[];
  summary: {
    byAction: Array<{ action: string; n: number }>;
    byResource: Array<{ resource: string; n: number }>;
  };
};

// Self-hosted client error reporting (no Sentry): grouped 7-day summary from
// GET /api/client-errors/summary. Super-admin only — the query is hard-gated
// (enabled:false) AND the section not rendered for anyone else, per "off, not
// hide".
type ClientErrorsSummary = {
  success: boolean;
  days: number;
  data: Array<{
    dedup_hash: string;
    message: string;
    route: string;
    build_id: string;
    count: number;
    affected_users: number;
    last_seen_at: string;
  }>;
  totals: { errors: number; occurrences: number };
  error?: string;
};

type Range = "24h" | "7d" | "30d" | "90d";
const RANGES: Range[] = ["24h", "7d", "30d", "90d"];

// Cold-start thresholds (ms). A warm request-path ping is ~0.5s; the
// Hyperdrive cold-connection stall pushes it to ~20s before it warms.
const SLOW_MS = 2500;
const VERY_SLOW_MS = 6000;

type Tone = "green" | "amber" | "red" | "loading";

function StatCard({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "accent" | "warning" | "error";
}) {
  const bar = {
    neutral: "bg-border",
    accent: "bg-accent",
    warning: "bg-amber-500",
    error: "bg-err",
  }[tone];
  const valC = {
    neutral: "text-ink",
    accent: "text-accent",
    warning: "text-amber-700",
    error: "text-err",
  }[tone];
  const icoC = {
    neutral: "text-ink-muted",
    accent: "text-accent",
    warning: "text-amber-600",
    error: "text-err",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
      <span className={cn("absolute left-0 top-0 h-full w-[3px]", bar)} aria-hidden />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <span className={icoC}>{icon}</span>
        <span>{label}</span>
      </div>
      <div
        className={cn(
          "mt-1.5 font-display text-[22px] font-extrabold leading-none tracking-tight",
          valC
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && <div className="mt-1 text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function HealthBanner({ tone, label, detail }: { tone: Tone; label: string; detail: string }) {
  const cls: Record<Tone, string> = {
    green: "border-synced/40 bg-synced/10 text-synced",
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    red: "border-err/40 bg-err/10 text-err",
    loading: "border-border bg-surface text-ink-muted",
  };
  const dot: Record<Tone, string> = {
    green: "bg-synced",
    amber: "bg-amber-500",
    red: "bg-err",
    loading: "bg-ink-muted",
  };
  return (
    <div className={cn("flex items-center gap-3 rounded-lg border p-3", cls[tone])}>
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot[tone], tone !== "loading" && "animate-pulse")} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">{label}</div>
        {detail && <div className="mt-0.5 text-[11px] opacity-90">{detail}</div>}
      </div>
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function SystemHealth() {
  const [range, setRange] = useState<Range>("24h");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const { can } = useAuth();
  // Client errors panel is super-admin only (the backend gates /summary on "*"
  // too). Hard-gate the query so a non-owner with system_health page access
  // never fires a 403 fetch.
  const isOwner = can("*");

  const live = useQuery<LivePayload>("/api/admin/health/live", () => api.get("/api/admin/health/live"));
  // Inventory-ledger integrity — the working corruption-check endpoint that was
  // previously never called by the frontend. Surfaces silent partial stock
  // writes as a count the operator can act on.
  const ledger = useQuery<LedgerPayload>("/api/admin/health/ledger", () => api.get("/api/admin/health/ledger"));
  const clientErrors = useQuery<ClientErrorsSummary>(
    "/api/client-errors/summary?days=7",
    () => api.get("/api/client-errors/summary?days=7"),
    [],
    { enabled: isOwner }
  );
  const feed = useQuery<AuditFeed>("/api/admin/health/audit-feed?range=::",
    () =>
      api.get(
        `/api/admin/health/audit-feed?range=${range}${sensitiveOnly ? "&sensitive=1" : ""}`
      ),
    [range, sensitiveOnly]
  );

  const d = live.data;
  const banner = useMemo<{ tone: Tone; label: string; detail: string }>(() => {
    if (!d) return { tone: "loading", label: "Checking…", detail: "" };
    const detail = `DB ${fmtMs(d.db.latency_ms)} · KV ${d.kv.bound ? fmtMs(d.kv.latency_ms) : "—"} · ${d.counts.users_active} active users`;
    if (!d.db.ok)
      return { tone: "red", label: "Database unreachable", detail: d.db.error || detail };
    if (d.db.latency_ms >= VERY_SLOW_MS)
      return {
        tone: "red",
        label: `Database very slow (${fmtMs(d.db.latency_ms)}) — cold-connection stall`,
        detail,
      };
    // SCM / R2 outages: the backend already flips d.ok for these, but surface the
    // specific subsystem so the banner names what's down instead of silently
    // staying green. SCM 500ing or slip-photo storage unreachable is red — those
    // break document flows and photo/slip storage outright.
    const scmDown = !!(d.scm && d.scm.configured && !d.scm.ok);
    const r2Down = !!(d.r2 && d.r2.bound && !d.r2.ok);
    if (scmDown || r2Down) {
      const which = [scmDown && "SCM stack", r2Down && "R2 storage"].filter(Boolean).join(" + ");
      return {
        tone: "red",
        label: `${which} unreachable`,
        detail: (scmDown && d.scm?.error) || detail,
      };
    }
    if (!d.ok || d.db.latency_ms >= SLOW_MS || (d.kv.bound && !d.kv.ok))
      return {
        tone: "amber",
        label: "Investigate — connection warming up",
        detail,
      };
    return { tone: "green", label: "All systems normal", detail };
  }, [d]);

  const rows = feed.data?.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System · Health"
        title="System Health"
        description="Live database and connection health, plus the audit trail of who changed what. Restricted to positions granted System Health access."
        actions={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowSetup((v) => !v)}
              aria-expanded={showSetup}
              aria-controls="system-health-setup-notes"
              className="text-[12px] font-semibold text-primary underline underline-offset-[3px] decoration-primary/40 hover:text-primary-ink hover:decoration-primary"
            >
              Setup notes
            </button>
            <Button
              variant="secondary"
              icon={<RefreshCw size={14} className={live.loading ? "animate-spin" : undefined} />}
              onClick={() => {
                live.reload();
                feed.reload();
                ledger.reload();
                // reload() bypasses `enabled`, so only refetch for the owner.
                if (isOwner) clientErrors.reload();
              }}
            >
              Refresh
            </Button>
          </div>
        }
      />

      <HealthBanner tone={banner.tone} label={banner.label} detail={banner.detail} />

      {showSetup && <SetupNotesCard onClose={() => setShowSetup(false)} />}

      {live.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Failed to load live health: {live.error}
        </div>
      )}

      {!live.data && live.loading ? (
        <ListSkeleton rows={3} />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                icon={<Gauge size={14} />}
                label="DB latency"
                value={fmtMs(d.db.latency_ms)}
                sub={d.db.ok ? "Live request-path ping" : "Ping failed"}
                tone={!d.db.ok || d.db.latency_ms >= VERY_SLOW_MS ? "error" : d.db.latency_ms >= SLOW_MS ? "warning" : "accent"}
              />
              <StatCard
                icon={<Database size={14} />}
                label="KV cache"
                value={d.kv.bound ? fmtMs(d.kv.latency_ms) : "—"}
                sub={d.kv.bound ? (d.kv.ok ? "Reachable" : "Unreachable") : "Not bound"}
                tone={d.kv.bound && !d.kv.ok ? "warning" : "neutral"}
              />
              <StatCard
                icon={<Users size={14} />}
                label="Active users"
                value={d.counts.users_active}
                sub={`${d.counts.users_invited} invited · ${d.counts.users_disabled} disabled`}
              />
              <StatCard
                icon={<Activity size={14} />}
                label="Audit events 24h"
                value={d.counts.audit_24h}
                sub={`${d.counts.audit_7d} in 7d`}
                tone={d.counts.sensitive_24h > 0 ? "warning" : "neutral"}
              />
              <StatCard
                icon={<ClipboardCheck size={14} />}
                label="Ledger integrity"
                value={
                  ledger.loading && !ledger.data
                    ? "…"
                    : !ledger.data || ledger.data.status === "unknown"
                      ? "—"
                      : ledger.data.issueCount
                }
                sub={
                  !ledger.data
                    ? ledger.error || "Checking…"
                    : ledger.data.status === "unknown"
                      ? ledger.data.error || "Not configured"
                      : ledger.data.issueCount === 0
                        ? "No silent stock writes"
                        : `${ledger.data.issueCount} doc${ledger.data.issueCount === 1 ? "" : "s"} moved stock on paper only`
                }
                tone={
                  !ledger.data || ledger.data.status === "unknown"
                    ? "neutral"
                    : ledger.data.issueCount > 0
                      ? "error"
                      : "accent"
                }
              />
              {/* SCM-route probe — one bounded PostgREST read; red when the SCM
                  stack is configured but 500ing (the page must not stay green). */}
              <StatCard
                icon={<Boxes size={14} />}
                label="SCM stack"
                value={d.scm ? (d.scm.configured ? fmtMs(d.scm.latency_ms) : "—") : "—"}
                sub={
                  !d.scm || !d.scm.configured
                    ? "Not configured"
                    : d.scm.ok
                      ? "Reachable"
                      : d.scm.error || "Unreachable"
                }
                tone={d.scm && d.scm.configured && !d.scm.ok ? "error" : "neutral"}
              />
              {/* R2 slip/photo bucket reachability. */}
              <StatCard
                icon={<HardDrive size={14} />}
                label="R2 storage"
                value={d.r2 ? (d.r2.bound ? fmtMs(d.r2.latency_ms) : "—") : "—"}
                sub={
                  !d.r2 || !d.r2.bound
                    ? "Not bound"
                    : d.r2.ok
                      ? "Reachable"
                      : "Unreachable"
                }
                tone={d.r2 && d.r2.bound && !d.r2.ok ? "error" : "neutral"}
              />
              {/* Anthropic key presence — SO-slip OCR /extract 503s when unset. */}
              <StatCard
                icon={<KeyRound size={14} />}
                label="Anthropic key"
                value={d.anthropic ? (d.anthropic.configured ? "Set" : "Missing") : "—"}
                sub={
                  !d.anthropic
                    ? "Unknown"
                    : d.anthropic.configured
                      ? "OCR /extract enabled"
                      : "OCR /extract will 503"
                }
                tone={d.anthropic && !d.anthropic.configured ? "warning" : "neutral"}
              />
            </div>

            {/* DB / connection health explainer — the cold-start signal. */}
            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                <Gauge size={13} className="text-accent" /> Database / connection
              </div>
              <div className="font-display text-[26px] font-extrabold leading-none tracking-tight text-ink">
                {fmtMs(d.db.latency_ms)}
                <span className="ml-2 text-[12px] font-normal text-ink-muted">
                  this check{" "}
                  {d.counts.last_event_at && (
                    <>· last write {relativeTime(d.counts.last_event_at)}</>
                  )}
                </span>
              </div>
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-secondary">
                A warm ping is well under a second. Anything over ~{SLOW_MS / 1000}s means the
                pooled DB connection went cold and is re-establishing — the Hyperdrive cold-start
                stall behind the occasional "Failed to fetch". Reads now auto-retry once the
                connection warms, so users recover instead of erroring; the lasting fix is moving
                Supabase off the micro tier.
              </p>
            </div>

            {/* Audit feed — who changed what, from audit_events. */}
            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Audit feed — recent changes
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSensitiveOnly((v) => !v)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10.5px] font-semibold transition-colors",
                      sensitiveOnly
                        ? "border-amber-400 bg-amber-50 text-amber-800"
                        : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent"
                    )}
                    title="Show only security-sensitive actions (user disable/delete/reset, role changes, finance, TOTP)"
                  >
                    <ShieldAlert size={12} /> Sensitive only
                  </button>
                  <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
                    {RANGES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRange(r)}
                        className={cn(
                          "h-6 rounded px-2 text-[10.5px] font-semibold transition-colors",
                          range === r
                            ? "bg-accent text-white"
                            : "text-ink-secondary hover:text-accent"
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {(feed.data?.summary.byAction.length ?? 0) > 0 && (
                <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <DashboardBreakdown
                    title="By action"
                    items={(feed.data?.summary.byAction ?? []).map((a) => ({
                      label: a.action,
                      count: a.n,
                    }))}
                  />
                  <DashboardBreakdown
                    title="By resource"
                    items={(feed.data?.summary.byResource ?? []).map((a) => ({
                      label: a.resource,
                      count: a.n,
                    }))}
                  />
                </div>
              )}

              {feed.loading && rows.length === 0 ? (
                <ListSkeleton rows={4} />
              ) : rows.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">
                  No {sensitiveOnly ? "sensitive " : ""}events in the last {range}.
                </div>
              ) : (
                <div className="thin-scroll max-h-[28rem] overflow-auto">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0">
                      <tr className="border-b-2 border-border bg-surface-dim text-left text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                        <th className="py-1.5 pr-3">When</th>
                        <th className="py-1.5 pr-3">Who</th>
                        <th className="py-1.5 pr-3">Action</th>
                        <th className="py-1.5">What</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="border-b border-border/60 align-top">
                          <td
                            className="whitespace-nowrap py-1.5 pr-3 font-mono text-[10.5px] text-ink-muted"
                            title={r.created_at}
                          >
                            {relativeTime(r.created_at)}
                          </td>
                          <td className="py-1.5 pr-3 text-ink-secondary">
                            {r.actor_email || (r.actor_id ? `#${r.actor_id}` : "system")}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-[10.5px] text-ink">{r.action}</td>
                          <td className="py-1.5 text-ink-secondary">
                            {r.summary ||
                              [r.entity_type, r.entity_id].filter(Boolean).join(" ") ||
                              "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {isOwner && <ClientErrorsPanel q={clientErrors} />}

            <PerformancePhase2 onOpenSetup={() => setShowSetup(true)} />
          </>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client Errors (7d) — read-only rollup of the self-hosted error reporter
// (client_errors table, grouped by dedup hash). Super-admin only: the caller
// renders it behind can("*") and the query is hard-gated to match the
// backend's requirePermission("*") on /api/client-errors/summary.
// ---------------------------------------------------------------------------

function ClientErrorsPanel({ q }: { q: QueryState<ClientErrorsSummary> }) {
  const rows = q.data?.data ?? [];
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          <Bug size={13} className={rows.length > 0 ? "text-err" : "text-accent"} />
          Client errors — last 7 days
        </div>
        {q.data && (
          <span className="text-[10.5px] text-ink-muted">
            {q.data.totals.errors} distinct · {q.data.totals.occurrences} occurrence
            {q.data.totals.occurrences === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {q.loading && !q.data ? (
        <ListSkeleton rows={3} />
      ) : q.error || (q.data && !q.data.success) ? (
        <div className="py-4 text-center text-[12px] text-ink-muted">
          Could not load client errors{q.data?.error ? `: ${q.data.error}` : ""}.
        </div>
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-ink-muted">
          No client errors reported in the last 7 days.
        </div>
      ) : (
        <div className="thin-scroll max-h-[22rem] overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0">
              <tr className="border-b-2 border-border bg-surface-dim text-left text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                <th className="py-1.5 pr-3">Route</th>
                <th className="py-1.5 pr-3">Message</th>
                <th className="py-1.5 pr-3 text-right">Count</th>
                <th className="py-1.5 pr-3 text-right">Users</th>
                <th className="py-1.5">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.dedup_hash} className="border-b border-border/60 align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-[10.5px] text-ink">
                    {r.route || "—"}
                  </td>
                  <td className="max-w-[28rem] break-words py-1.5 pr-3 text-ink-secondary" title={r.build_id ? `build ${r.build_id}` : undefined}>
                    {r.message}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-semibold text-ink">
                    {r.count.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-secondary">{r.affected_users}</td>
                  <td className="whitespace-nowrap py-1.5 font-mono text-[10.5px] text-ink-muted" title={r.last_seen_at}>
                    {relativeTime(r.last_seen_at)}
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

// ---------------------------------------------------------------------------
// Performance & Slow Queries — placeholder.
// Once a Cloudflare Analytics Engine endpoint exists, this becomes the
// p50/p95/p99 + slow-SQL + Web Vitals panels (see Final design F1). Until then
// we render the "AE not wired · Phase 2" empty state from the States design:
// ghosted scaffolding for the 4 percentile stat cards + a latency chart card
// with an overlay explaining what's needed.
// ---------------------------------------------------------------------------

// Eyebrow = bare metric name (per shared pattern); plain-language read goes in
// the sub-label so the row reads at a glance.
const PERCENTILE_SLOTS: Array<{
  label: string;
  sub: string;
  bar: string;
}> = [
  { label: "p50", sub: "Median request time", bar: "bg-synced" },
  { label: "p95", sub: "Tail latency · slowest 5%", bar: "bg-accent" },
  { label: "p99", sub: "Outliers · cold-start range", bar: "bg-err" },
  { label: "Requests · 7d", sub: "Window total · all routes", bar: "bg-border-strong" },
];

function PerformancePhase2({ onOpenSetup }: { onOpenSetup: () => void }) {
  const scrollTop = () => {
    if (typeof window === "undefined") return;
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };
  const handleOpenSetup = () => {
    onOpenSetup();
    scrollTop();
  };
  return (
    <section aria-labelledby="perf-phase2" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
            System · Performance
          </div>
          <h2
            id="perf-phase2"
            className="mt-1 font-display text-[18px] font-extrabold tracking-tight text-ink"
          >
            Performance &amp; Slow Queries
          </h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-warning-bg px-2.5 py-0.5 text-[10.5px] font-semibold text-warning-text">
          <Clock size={11} /> AE not wired · Phase 2
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
        {PERCENTILE_SLOTS.map((s) => (
          <div
            key={s.label}
            className="relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-3 opacity-60 shadow-stone"
          >
            <span className={cn("absolute left-0 top-0 h-full w-[3px]", s.bar)} />
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {s.label}
            </div>
            <div className="mt-1.5 font-display text-[22px] font-extrabold leading-none tracking-tight text-ink-muted">
              —
            </div>
            <div className="mt-1 text-[10.5px] text-ink-muted">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="relative overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
        <div className="px-5 pt-5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Request latency · p50 / p95 / p99
            </div>
            <div className="flex gap-3 text-[10px] text-ink-muted">
              <LegendDot color="bg-synced" label="p50" />
              <LegendDot color="bg-accent-bright" label="p95" />
              <LegendDot color="bg-err" label="p99" />
            </div>
          </div>
          <div
            className="mt-3 flex h-[120px] items-end gap-1.5 opacity-30 grayscale"
            aria-hidden
          >
            {Array.from({ length: 14 }).map((_, i) => {
              const seed = (i * 37) % 100;
              return (
                <div key={i} className="flex h-full flex-1 flex-col justify-end gap-[2px]">
                  <div
                    className="rounded-t-[2px] bg-err/80"
                    style={{ height: `${10 + (seed % 22)}%` }}
                  />
                  <div className="bg-accent-bright" style={{ height: `${10 + (seed % 18)}%` }} />
                  <div
                    className="rounded-b-[2px] bg-synced"
                    style={{ height: `${20 + (seed % 30)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 h-4" />
        </div>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-surface/70 to-surface/95 px-6 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
            <Timer size={18} />
          </div>
          <div className="mt-3 text-[14px] font-bold text-ink">
            Latency percentiles · slow SQL · front-end performance
          </div>
          <p className="mt-1.5 max-w-[380px] text-[12px] leading-relaxed text-ink-muted">
            These panels need{" "}
            <span className="font-money text-accent">Cloudflare Analytics Engine</span>. Base DB
            / KV / audit metrics work today; perf panels are staged for Phase 2.
          </p>
          <div className="pointer-events-auto mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={handleOpenSetup}>
              Setup notes
            </Button>
            <Button
              variant="secondary"
              icon={<ArrowUp size={14} />}
              onClick={scrollTop}
            >
              View base metrics
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("h-2 w-2 rounded-[2px]", color)} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SetupNotesCard — petrol-tinted disclosure listing what's needed to take the
// Performance & Slow Queries panel out of "Phase 2" mode. Stays present even
// when AE is wired (per the shared "Setup notes" pattern: owners can always
// find the infra notes for this page).
// ---------------------------------------------------------------------------

function SetupNotesCard({ onClose }: { onClose: () => void }) {
  return (
    <div
      id="system-health-setup-notes"
      className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-[12px] text-primary-ink shadow-stone"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-primary">
            Setup notes · Analytics Engine
          </div>
          <p className="mt-1.5 leading-relaxed">
            The Performance &amp; Slow Queries panel needs the{" "}
            <span className="font-money">ERP_METRICS</span> Cloudflare Analytics Engine binding —
            currently commented out in <span className="font-money">backend/wrangler.toml</span>.
            Once wired, the worker writes per-request latency / route samples to AE; an admin
            endpoint reads them back as p50 / p95 / p99 + slow-SQL.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              Uncomment <span className="font-money">[[analytics_engine_datasets]]</span> for{" "}
              <span className="font-money">ERP_METRICS</span> in{" "}
              <span className="font-money">backend/wrangler.toml</span> and redeploy.
            </li>
            <li>
              Add a request-path middleware that writes one AE row per request (path, status,
              duration).
            </li>
            <li>
              Ship a small <span className="font-money">/api/admin/health/perf</span> endpoint
              that aggregates AE rows for the selected window.
            </li>
            <li>
              Front-end Web Vitals: send a beacon to{" "}
              <span className="font-money">/api/admin/health/rum</span> from{" "}
              <span className="font-money">frontend/src/main.tsx</span>.
            </li>
          </ul>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close setup notes"
          className="-m-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-primary hover:bg-primary/10"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
