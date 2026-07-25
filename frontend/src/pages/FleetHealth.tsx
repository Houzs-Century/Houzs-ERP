import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Truck, RefreshCw, X, AlertTriangle } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatCard } from "../components/StatCard";
import { ResizableDetailDrawer } from "../components/ResizableDetailDrawer";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Fleet Health — the Phase-1 desktop ops screen for Fleet Maintenance &
// Compliance. KPI ribbon + a compliance reminders strip + a per-lorry status
// board, each row opening a detail drawer with the compliance vault (current
// document + full renewal history per type). All derived state (status,
// reminder levels, KPIs) is computed by the backend from services/
// fleet-status.ts, so this page only renders — it never re-derives the rules.
//
// Reuses the app's own design system: StatCard (KPI), ResizableDetailDrawer
// (the shared SCM detail drawer chrome), PageHeader, Button. Status/expiry
// pills follow the app's tone vocabulary. No dark standalone theme.
// ---------------------------------------------------------------------------

const DOC_TYPES = ["PUSPAKOM", "ROAD_TAX", "INSURANCE", "APAD", "CROSS_BORDER"] as const;
type DocType = (typeof DOC_TYPES)[number];
const DOC_LABEL: Record<DocType, string> = {
  PUSPAKOM: "PUSPAKOM",
  ROAD_TAX: "Road Tax / LKM",
  INSURANCE: "Insurance",
  APAD: "APAD permit",
  CROSS_BORDER: "Cross-border",
};

type Tone = "crit" | "warn" | "ok" | "info" | "neutral";

type DocView = {
  id: number;
  docType: DocType;
  documentRef: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  costCenti: number | null;
  owner: string | null;
  result: "PASS" | "FAIL" | null;
  reinspectionDeadline: string | null;
  notes: string | null;
  daysRemaining: number | null;
  reminderLevel: string;
  tone: Tone;
};

type VehicleRow = {
  id: number;
  plate: string;
  region: string | null;
  driverName: string | null;
  vehicleType: string | null;
  model: string | null;
  mileageKm: number | null;
  nextServiceKm: number | null;
  nextServiceDate: string | null;
  outOfService: boolean;
  outOfServiceReason: string | null;
  notes: string | null;
  status: VehicleStatus;
  statusLabel: string;
  canDispatch: boolean;
  compliance: Partial<Record<DocType, DocView>>;
};

type VehicleStatus =
  | "AVAILABLE"
  | "SERVICE_DUE"
  | "PLANNED_MAINTENANCE"
  | "WAITING_PARTS"
  | "BREAKDOWN"
  | "COMPLIANCE_BLOCKED"
  | "OUT_OF_SERVICE";

type DashboardPayload = {
  today: string;
  kpis: {
    expiredDocs: number;
    expiring30: number;
    expiring60: number;
    expiring90: number;
    serviceDue: number;
    activeBreakdowns: number;
    complianceBlocked: number;
    cantDispatch: number;
    fleetSize: number;
    repairSpendThisMonthCenti: number | null;
    costliestVehicle: string | null;
  };
  statusCounts: Record<string, number>;
  vehicles: VehicleRow[];
};

type VehicleDetailPayload = {
  vehicle: VehicleRow;
  compliance: Record<DocType, { current: number | null; history: DocView[] }>;
};

const STATUS_TONE: Record<VehicleStatus, Tone> = {
  AVAILABLE: "ok",
  SERVICE_DUE: "warn",
  PLANNED_MAINTENANCE: "info",
  WAITING_PARTS: "warn",
  BREAKDOWN: "crit",
  COMPLIANCE_BLOCKED: "crit",
  OUT_OF_SERVICE: "neutral",
};

const TONE_PILL: Record<Tone, string> = {
  crit: "text-err bg-err/10 border-err/25",
  warn: "text-warning-text bg-warning-text/10 border-warning-text/25",
  ok: "text-synced bg-synced/10 border-synced/20",
  info: "text-primary bg-primary/10 border-primary/25",
  neutral: "text-ink-muted bg-ink-muted/10 border-border",
};

function fmtDays(days: number | null): string {
  if (days === null) return "no date on file";
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  return `in ${days}d`;
}

function money(centi: number | null): string {
  if (centi === null) return "—";
  return "RM " + (centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold", TONE_PILL[tone])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", tone === "crit" ? "bg-err" : tone === "warn" ? "bg-warning-text" : tone === "ok" ? "bg-synced" : tone === "info" ? "bg-primary" : "bg-ink-muted")} />
      {children}
    </span>
  );
}

/** A compact expiry cell: the date + a days-remaining sub-line in its tone. */
function ExpiryCell({ doc }: { doc: DocView | undefined }) {
  if (!doc) return <span className="text-[12px] text-ink-muted">—</span>;
  const toneText = doc.tone === "crit" ? "text-err" : doc.tone === "warn" ? "text-warning-text" : "text-ink-muted";
  return (
    <div className="text-[12px]">
      <div className="text-ink">{doc.expiryDate ?? "—"}</div>
      <div className={cn("text-[10.5px]", toneText)}>
        {doc.result === "FAIL" ? "FAILED · " : ""}
        {fmtDays(doc.daysRemaining)}
      </div>
    </div>
  );
}

/** What is wrong right now, in words — derived from Phase-1 facts. */
function openProblem(v: VehicleRow): string | null {
  if (v.status === "OUT_OF_SERVICE") return v.outOfServiceReason || "Out of service";
  if (v.status === "COMPLIANCE_BLOCKED") {
    const failed = DOC_TYPES.map((t) => v.compliance[t])
      .filter((d): d is DocView => !!d && (d.reminderLevel === "EXPIRED" || d.result === "FAIL"))
      .map((d) => (d.result === "FAIL" ? `${DOC_LABEL[d.docType]} failed` : `${DOC_LABEL[d.docType]} expired`));
    return failed.join(", ") || "Compliance blocked";
  }
  if (v.status === "SERVICE_DUE") return "Service due";
  return null;
}

const REGIONS = ["ALL", "KL", "PG"] as const;

export function FleetHealth() {
  const [params, setParams] = useSearchParams();
  const region = (params.get("region") ?? "ALL").toUpperCase();
  const statusFilter = params.get("status") ?? "ALL";
  const [openId, setOpenId] = useState<number | null>(null);

  const dash = useQuery<DashboardPayload>("/api/fleet-maintenance/dashboard", () => api.get("/api/fleet-maintenance/dashboard"));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "ALL" || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const all = dash.data?.vehicles ?? [];
  const regionsPresent = useMemo(() => new Set(all.map((v) => (v.region ?? "").toUpperCase())), [all]);

  const visible = useMemo(
    () =>
      all.filter(
        (v) => (region === "ALL" || (v.region ?? "").toUpperCase() === region) && (statusFilter === "ALL" || v.status === statusFilter),
      ),
    [all, region, statusFilter],
  );

  // The reminders strip: every actionable current document, most-urgent first.
  // Derived from the same payload the KPIs use, so it can never disagree with
  // the board. (The /api/fleet-maintenance/reminders endpoint serves the same
  // computation to a future scheduled-notification job.)
  const reminders = useMemo(() => {
    const scope = region === "ALL" ? all : all.filter((v) => (v.region ?? "").toUpperCase() === region);
    const items: Array<{ v: VehicleRow; doc: DocView }> = [];
    for (const v of scope) {
      for (const t of DOC_TYPES) {
        const doc = v.compliance[t];
        if (doc && doc.reminderLevel !== "OK") items.push({ v, doc });
      }
    }
    return items.sort((a, b) => (a.doc.daysRemaining ?? 1e9) - (b.doc.daysRemaining ?? 1e9));
  }, [all, region]);

  const kpis = dash.data?.kpis;
  const statusCounts = dash.data?.statusCounts ?? {};

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations · Fleet"
        title="Fleet Health"
        description="Lorry compliance, expiry reminders and dispatch readiness. Status is derived from compliance, service mileage and the out-of-service flag — not set by hand."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={14} className={dash.loading ? "animate-spin" : undefined} />}
            onClick={() => dash.reload()}
          >
            Refresh
          </Button>
        }
      />

      {/* Region toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Warehouse</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {REGIONS.map((r) => {
            const enabled = r === "ALL" || regionsPresent.has(r);
            return (
              <button
                key={r}
                type="button"
                disabled={!enabled}
                aria-pressed={region === r}
                onClick={() => setParam("region", r)}
                className={cn(
                  "px-3.5 py-1.5 text-[12px] font-semibold transition-colors",
                  region === r ? "bg-primary-soft text-primary" : "text-ink-secondary hover:bg-surface-2",
                  !enabled && "cursor-not-allowed opacity-40",
                )}
              >
                {r}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
          {visible.length} {visible.length === 1 ? "lorry" : "lorries"}
        </span>
      </div>

      {/* KPI ribbon */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Expired documents" value={kpis?.expiredDocs ?? 0} tone="error" rail="bg-err" pending={dash.loading} onClick={() => setParam("status", "COMPLIANCE_BLOCKED")} active={statusFilter === "COMPLIANCE_BLOCKED"} />
        <StatCard label="Expiring ≤ 30 days" value={kpis?.expiring30 ?? 0} tone="warning" rail="bg-warning-text" pending={dash.loading} />
        <StatCard label="Cannot dispatch" value={kpis?.cantDispatch ?? 0} subtitle={`of ${kpis?.fleetSize ?? 0} lorries`} tone="error" rail="bg-err" pending={dash.loading} />
        <StatCard label="Service due" value={kpis?.serviceDue ?? 0} tone="warning" rail="bg-warning-text" pending={dash.loading} onClick={() => setParam("status", "SERVICE_DUE")} active={statusFilter === "SERVICE_DUE"} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Expiring ≤ 60 days" value={kpis?.expiring60 ?? 0} pending={dash.loading} />
        <StatCard label="Expiring ≤ 90 days" value={kpis?.expiring90 ?? 0} pending={dash.loading} />
        <StatCard label="Active breakdowns" value={kpis?.activeBreakdowns ?? 0} tone={kpis?.activeBreakdowns ? "error" : "default"} pending={dash.loading} />
        <StatCard label="This-month repairs" value="—" subtitle="Tracked from Phase 2" pending={dash.loading} />
      </div>

      {/* Reminders strip */}
      {reminders.length > 0 && (
        <section className="rounded-lg border border-border bg-surface p-4 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle size={15} className="text-warning-text" />
            <h2 className="font-display text-[14px] font-bold text-ink">Compliance reminders</h2>
            <span className="text-[11px] text-ink-muted">60 / 45 / 30 / 14 / 7 / 3 / 1-day ladder · expired grounds the lorry</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {reminders.slice(0, 12).map(({ v, doc }) => (
              <button
                key={`${v.id}-${doc.docType}`}
                type="button"
                onClick={() => setOpenId(v.id)}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <span className="flex items-center gap-2.5 text-[12.5px]">
                  <span className="font-semibold text-ink">{v.plate}</span>
                  <span className="text-ink-muted">{DOC_LABEL[doc.docType]}</span>
                  {v.region && <span className="text-[10.5px] text-ink-muted">{v.region}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-[11.5px] text-ink-secondary">{doc.expiryDate ?? "—"}</span>
                  <Pill tone={doc.tone}>{doc.result === "FAIL" ? "FAILED" : fmtDays(doc.daysRemaining)}</Pill>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        <FilterChip label={`All ${all.length}`} active={statusFilter === "ALL"} onClick={() => setParam("status", "ALL")} />
        {Object.entries(statusCounts)
          .sort()
          .map(([status, count]) => (
            <FilterChip
              key={status}
              label={`${statusLabel(status)} ${count}`}
              tone={STATUS_TONE[status as VehicleStatus]}
              active={statusFilter === status}
              onClick={() => setParam("status", status)}
            />
          ))}
      </div>

      {/* Fleet board */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-[10px] uppercase tracking-brand text-ink-muted">
                <th className="px-3.5 py-2.5 font-semibold">Lorry</th>
                <th className="px-3.5 py-2.5 font-semibold">Status</th>
                <th className="px-3.5 py-2.5 font-semibold">Mileage</th>
                <th className="px-3.5 py-2.5 font-semibold">Next service</th>
                <th className="px-3.5 py-2.5 font-semibold">PUSPAKOM</th>
                <th className="px-3.5 py-2.5 font-semibold">Insurance</th>
                <th className="px-3.5 py-2.5 font-semibold">Road tax</th>
                <th className="px-3.5 py-2.5 font-semibold">Open problem</th>
              </tr>
            </thead>
            <tbody>
              {dash.loading ? (
                <tr>
                  <td colSpan={8} className="p-4">
                    <ListSkeleton />
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3.5 py-8 text-center text-[13px] text-ink-muted">
                    No lorries in this view. Add a vehicle or run the seed script to load the fleet.
                  </td>
                </tr>
              ) : (
                visible.map((v) => {
                  const problem = openProblem(v);
                  return (
                    <tr
                      key={v.id}
                      tabIndex={0}
                      onClick={() => setOpenId(v.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setOpenId(v.id);
                      }}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                    >
                      <td className="px-3.5 py-3">
                        <div className="font-semibold text-ink">{v.plate}</div>
                        <div className="text-[11px] text-ink-muted">
                          {[v.driverName, v.region].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </td>
                      <td className="px-3.5 py-3">
                        <Pill tone={STATUS_TONE[v.status]}>{v.statusLabel}</Pill>
                      </td>
                      <td className="px-3.5 py-3 tabular-nums text-ink">
                        {v.mileageKm != null ? v.mileageKm.toLocaleString() : "—"}
                        <span className="ml-1 text-[10.5px] text-ink-muted">km</span>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-ink-secondary">
                        {v.nextServiceKm != null ? `${v.nextServiceKm.toLocaleString()} km` : v.nextServiceDate ?? "—"}
                      </td>
                      <td className="px-3.5 py-3">
                        <ExpiryCell doc={v.compliance.PUSPAKOM} />
                      </td>
                      <td className="px-3.5 py-3">
                        <ExpiryCell doc={v.compliance.INSURANCE} />
                      </td>
                      <td className="px-3.5 py-3">
                        <ExpiryCell doc={v.compliance.ROAD_TAX} />
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-ink-secondary">
                        {problem ?? <span className="text-ink-muted">—</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {dash.error && (
        <p className="text-[12px] text-err">Could not load the fleet: {dash.error}</p>
      )}

      <VehicleDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function FilterChip({ label, tone, active, onClick }: { label: string; tone?: Tone; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
        active ? "border-primary bg-primary-soft text-primary" : "border-border text-ink-secondary hover:bg-surface-2",
      )}
    >
      {tone && <span className={cn("h-1.5 w-1.5 rotate-45", tone === "crit" ? "bg-err" : tone === "warn" ? "bg-warning-text" : tone === "ok" ? "bg-synced" : tone === "info" ? "bg-primary" : "bg-ink-muted")} />}
      {label}
    </button>
  );
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    AVAILABLE: "Available",
    SERVICE_DUE: "Service Due",
    PLANNED_MAINTENANCE: "Planned Maint.",
    WAITING_PARTS: "Waiting Parts",
    BREAKDOWN: "Breakdown",
    COMPLIANCE_BLOCKED: "Compliance Blocked",
    OUT_OF_SERVICE: "Out of Service",
  };
  return map[status] ?? status;
}

// ── Detail drawer — vehicle header + compliance vault with renewal history ──
function VehicleDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const detail = useQuery<VehicleDetailPayload>(
    `/api/fleet-maintenance/vehicles/${id}`,
    () => api.get(`/api/fleet-maintenance/vehicles/${id}`),
    [id],
    { enabled: id != null },
  );
  const v = detail.data?.vehicle;
  const compliance = detail.data?.compliance;

  return (
    <ResizableDetailDrawer open={id != null} onClose={onClose} ariaLabel="Lorry detail">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Truck size={18} className="text-primary" />
            <span className="font-display text-[18px] font-bold text-ink">{v?.plate ?? "…"}</span>
          </div>
          <div className="mt-1 text-[12px] text-ink-muted">
            {v ? [v.driverName, v.region ? `${v.region} warehouse` : null, v.mileageKm != null ? `${v.mileageKm.toLocaleString()} km` : null].filter(Boolean).join(" · ") : ""}
          </div>
          {v && (
            <div className="mt-2">
              <Pill tone={STATUS_TONE[v.status]}>{v.statusLabel}</Pill>
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md border border-border p-1.5 text-ink-muted hover:text-ink">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {detail.loading && <ListSkeleton />}
        {v && compliance && (
          <>
            {v.outOfService && (
              <p className="mb-4 rounded-md border border-err/25 bg-err/10 px-3 py-2 text-[12px] text-err">
                Out of service{v.outOfServiceReason ? ` — ${v.outOfServiceReason}` : ""}.
              </p>
            )}

            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Compliance vault</h3>
              <span className="text-[10.5px] text-ink-muted">current document + renewal history (append-only)</span>
            </div>

            <div className="space-y-4">
              {DOC_TYPES.map((t) => {
                const group = compliance[t];
                const history = group?.history ?? [];
                const currentId = group?.current ?? null;
                return (
                  <div key={t} className="rounded-lg border border-border bg-surface-2/40 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[12.5px] font-semibold text-ink">{DOC_LABEL[t]}</span>
                      {history.length === 0 && <span className="text-[11px] text-ink-muted">No document on file</span>}
                    </div>
                    {history.length > 0 && (
                      <div className="space-y-1.5">
                        {history.map((doc) => (
                          <div
                            key={doc.id}
                            className={cn(
                              "flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-[12px]",
                              doc.id === currentId ? "border-border bg-surface" : "border-transparent bg-transparent opacity-70",
                            )}
                          >
                            <div>
                              <div className="text-ink">
                                {doc.documentRef || DOC_LABEL[t]}
                                {doc.id === currentId && <span className="ml-2 rounded bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-primary">Current</span>}
                              </div>
                              <div className="text-[10.5px] text-ink-muted">
                                {doc.issueDate ? `Issued ${doc.issueDate}` : "No issue date"}
                                {doc.owner ? ` · ${doc.owner}` : ""}
                                {doc.costCenti != null ? ` · ${money(doc.costCenti)}` : ""}
                                {doc.result ? ` · ${doc.result}` : ""}
                                {doc.result === "FAIL" && doc.reinspectionDeadline ? ` · reinspect by ${doc.reinspectionDeadline}` : ""}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="tabular-nums text-ink">{doc.expiryDate ?? "—"}</div>
                              <div
                                className={cn(
                                  "text-[10.5px]",
                                  doc.tone === "crit" ? "text-err" : doc.tone === "warn" ? "text-warning-text" : "text-ink-muted",
                                )}
                              >
                                {doc.result === "FAIL" ? "FAILED · " : ""}
                                {fmtDays(doc.daysRemaining)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="mt-5 text-[11px] text-ink-muted">
              Preventive-maintenance plans, work orders and breakdown history arrive in a later phase. Renew a document by adding a new
              row via the API (never overwrite) — the history above is the audit trail.
            </p>
          </>
        )}
      </div>
    </ResizableDetailDrawer>
  );
}
