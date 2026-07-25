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
  id: string | null;
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

type NextPlanView = {
  component: string;
  componentLabel: string;
  nextDueKm: number | null;
  nextDueDate: string | null;
  kmRemaining: number | null;
  daysRemaining: number | null;
  tone: Tone;
  overdue: boolean;
};

type PlanView = {
  id: string;
  component: string;
  componentLabel: string;
  intervalKm: number | null;
  intervalMonths: number | null;
  lastDoneDate: string | null;
  lastDoneKm: number | null;
  workshop: string | null;
  estCostCenti: number | null;
  notes: string | null;
  active: boolean;
  nextDueKm: number | null;
  nextDueDate: string | null;
  kmRemaining: number | null;
  daysRemaining: number | null;
  dueSoon: boolean;
  overdue: boolean;
  tone: Tone;
};

type MileageView = {
  id: string;
  readingDate: string | null;
  odometerKm: number | null;
  source: string | null;
  photoRef: string | null;
  flagged: boolean;
  note: string | null;
};

type VehicleRow = {
  id: string;
  plate: string;
  region: string | null;
  driverName: string | null;
  vehicleType: string | null;
  model: string | null;
  mileageKm: number | null;
  mileageDate: string | null;
  mileageSource: "reading" | "service" | null;
  mileageFlagged: boolean;
  nextServiceKm: number | null;
  nextServiceDate: string | null;
  outOfService: boolean;
  outOfServiceReason: string | null;
  notes: string | null;
  status: VehicleStatus;
  statusLabel: string;
  canDispatch: boolean;
  compliance: Partial<Record<DocType, DocView>>;
  planCount: number;
  plansOverdue: number;
  plansDueSoon: number;
  nextPlan: NextPlanView | null;
  // Phase 3
  breakdownActive?: boolean;
  openBreakdowns?: number;
  openWorkOrders?: number;
  downtimeHours?: number | null;
  openProblem?: string | null;
};

const WORK_ORDER_STATES = [
  "REPORTED",
  "DIAGNOSED",
  "APPROVED",
  "IN_REPAIR",
  "WAITING_PARTS",
  "COMPLETED",
  "VERIFIED",
] as const;
type WorkOrderState = (typeof WORK_ORDER_STATES)[number];
const WORK_ORDER_STATE_LABEL: Record<WorkOrderState, string> = {
  REPORTED: "Reported",
  DIAGNOSED: "Diagnosed",
  APPROVED: "Approved",
  IN_REPAIR: "In Repair",
  WAITING_PARTS: "Waiting Parts",
  COMPLETED: "Completed",
  VERIFIED: "Verified",
};

type PartView = { id: string; name: string; partNo: string | null; qty: number; unitPriceCenti: number; lineCenti: number; serial: string | null };
type WorkOrderView = {
  id: string;
  status: WorkOrderState;
  statusLabel: string;
  open: boolean;
  nextStates: WorkOrderState[];
  problem: string | null;
  diagnosis: string | null;
  workshop: string | null;
  labourCenti: number;
  outsideServiceCenti: number;
  towingCenti: number;
  taxCenti: number;
  totalCenti: number;
  warrantyUntil: string | null;
  reportedAt: string | null;
  estComplete: string | null;
  actualComplete: string | null;
  breakdownCaseId: string | null;
  componentId: string | null;
  notes: string | null;
  parts: PartView[];
};

type BreakdownView = {
  id: string;
  occurredAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  faultType: string | null;
  severity: "MINOR" | "MAJOR" | "CRITICAL";
  stillDrivable: boolean;
  mediaRefs: string[];
  driverDescription: string | null;
  towingCompany: string | null;
  towingCostCenti: number | null;
  workshop: string | null;
  breakdownStart: string | null;
  recoveryTime: string | null;
  affectedTripId: string | null;
  status: "OPEN" | "TOWING" | "IN_WORKSHOP" | "RESOLVED";
  grounding: boolean;
  downtimeHours: number | null;
  notes: string | null;
};

type ComponentEventView = { id: string; eventType: string; eventDate: string | null; odometerKm: number | null; toPosition: string | null; costCenti: number | null; note: string | null };
type ComponentView = {
  id: string;
  componentType: string;
  componentTypeLabel: string;
  position: string;
  positionLabel: string;
  brand: string | null;
  model: string | null;
  size: string | null;
  serial: string | null;
  fittedDate: string | null;
  fittedKm: number | null;
  purchasePriceCenti: number | null;
  treadDepth: number | null;
  removedDate: string | null;
  removedKm: number | null;
  warrantyUntil: string | null;
  status: "ACTIVE" | "REMOVED";
  notes: string | null;
  kmUsed: number | null;
  costPerKmCenti: number | null;
  underWarranty: boolean | null;
  events: ComponentEventView[];
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
    serviceOverdue: number;
    activeBreakdowns: number;
    complianceBlocked: number;
    cantDispatch: number;
    openWorkOrders: number;
    fleetSize: number;
    repairSpendThisMonthCenti: number | null;
    costliestVehicle: string | null;
    costliestVehicleCenti: number | null;
  };
  statusCounts: Record<string, number>;
  vehicles: VehicleRow[];
};

type VehicleDetailPayload = {
  vehicle: VehicleRow & { lastServiceWorkshop?: string | null };
  compliance: Record<DocType, { currentId: string | null; flatExpiry: string | null; history: DocView[] }>;
  plans: PlanView[];
  mileage: MileageView[];
  maintenanceWindows: Array<{ from: string | null; to: string | null; reason: string | null }>;
  breakdowns: BreakdownView[];
  workOrders: WorkOrderView[];
  components: ComponentView[];
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

/** Downtime hours as a compact "2d 4h" / "6h" string. */
function fmtDowntime(hours: number | null): string {
  if (hours == null) return "—";
  if (hours < 24) return `${Math.round(hours)}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 8 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
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

/** The days/km remaining for the most-urgent plan, in words. */
function fmtPlanRemaining(p: { kmRemaining: number | null; daysRemaining: number | null; overdue: boolean }): string {
  const parts: string[] = [];
  if (p.kmRemaining !== null) parts.push(p.kmRemaining < 0 ? `${(-p.kmRemaining).toLocaleString()} km over` : `${p.kmRemaining.toLocaleString()} km`);
  if (p.daysRemaining !== null) parts.push(p.daysRemaining < 0 ? `${-p.daysRemaining}d over` : `${p.daysRemaining}d`);
  return parts.join(" · ") || "—";
}

/** The board's "Next service" cell: the single most-urgent plan (per-component),
 *  falling back to the legacy next-service target when no plans exist yet. */
function NextServiceCell({ v }: { v: VehicleRow }) {
  if (v.nextPlan) {
    const np = v.nextPlan;
    const toneText = np.tone === "crit" ? "text-err" : np.tone === "warn" ? "text-warning-text" : "text-ink-muted";
    return (
      <div className="text-[12px]">
        <div className="text-ink">{np.componentLabel}</div>
        <div className={cn("text-[10.5px]", toneText)}>
          {np.overdue ? "OVERDUE · " : ""}
          {fmtPlanRemaining(np)}
        </div>
      </div>
    );
  }
  if (v.nextServiceKm != null) return <span className="text-[12px] text-ink-secondary">{v.nextServiceKm.toLocaleString()} km</span>;
  if (v.nextServiceDate) return <span className="text-[12px] text-ink-secondary">{v.nextServiceDate}</span>;
  return <span className="text-[12px] text-ink-muted">No plan</span>;
}

/** What is wrong right now, in words — derived facts. The backend supplies the
 *  breakdown / work-order problem (the most urgent operational fault); fall back
 *  to the compliance / out-of-service / service-due reasons derived here. */
function openProblem(v: VehicleRow): string | null {
  if (v.openProblem) return v.openProblem;
  if (v.status === "OUT_OF_SERVICE") return v.outOfServiceReason || "Out of service";
  if (v.status === "COMPLIANCE_BLOCKED") {
    const failed = DOC_TYPES.map((t) => v.compliance[t])
      .filter((d): d is DocView => !!d && (d.reminderLevel === "EXPIRED" || d.result === "FAIL"))
      .map((d) => (d.result === "FAIL" ? `${DOC_LABEL[d.docType]} failed` : `${DOC_LABEL[d.docType]} expired`));
    return failed.join(", ") || "Compliance blocked";
  }
  if (v.status === "SERVICE_DUE") {
    if (v.plansOverdue > 0 && v.nextPlan) return `${v.nextPlan.componentLabel} overdue`;
    if (v.nextPlan) return `${v.nextPlan.componentLabel} due`;
    return "Service due";
  }
  return null;
}

const REGIONS = ["ALL", "KL", "PG"] as const;

export function FleetHealth() {
  const [params, setParams] = useSearchParams();
  const region = params.get("region") ?? "ALL";
  const statusFilter = params.get("status") ?? "ALL";
  const [openId, setOpenId] = useState<string | null>(null);

  const dash = useQuery<DashboardPayload>("/api/fleet-maintenance/dashboard", () => api.get("/api/fleet-maintenance/dashboard"));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "ALL" || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const all = dash.data?.vehicles ?? [];
  const regionOptions = useMemo(() => {
    const present = [...new Set(all.map((v) => v.region).filter((r): r is string => !!r))].sort();
    return ["ALL", ...present];
  }, [all]);

  const visible = useMemo(
    () =>
      all.filter(
        (v) => (region === "ALL" || v.region === region) && (statusFilter === "ALL" || v.status === statusFilter),
      ),
    [all, region, statusFilter],
  );

  // The reminders strip: every actionable current document, most-urgent first.
  // Derived from the same payload the KPIs use, so it can never disagree with
  // the board. (The /api/fleet-maintenance/reminders endpoint serves the same
  // computation to a future scheduled-notification job.)
  const reminders = useMemo(() => {
    const scope = region === "ALL" ? all : all.filter((v) => v.region === region);
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
          {regionOptions.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={region === r}
              onClick={() => setParam("region", r)}
              className={cn(
                "px-3.5 py-1.5 text-[12px] font-semibold transition-colors",
                region === r ? "bg-primary-soft text-primary" : "text-ink-secondary hover:bg-surface-2",
              )}
            >
              {r}
            </button>
          ))}
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
        <StatCard label="Service due" value={kpis?.serviceDue ?? 0} subtitle={kpis?.serviceOverdue ? `${kpis.serviceOverdue} overdue` : "on plan"} tone="warning" rail="bg-warning-text" pending={dash.loading} onClick={() => setParam("status", "SERVICE_DUE")} active={statusFilter === "SERVICE_DUE"} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Expiring ≤ 60 days" value={kpis?.expiring60 ?? 0} pending={dash.loading} />
        <StatCard label="Expiring ≤ 90 days" value={kpis?.expiring90 ?? 0} pending={dash.loading} />
        <StatCard label="Active breakdowns" value={kpis?.activeBreakdowns ?? 0} subtitle={kpis?.openWorkOrders ? `${kpis.openWorkOrders} open work order${kpis.openWorkOrders === 1 ? "" : "s"}` : "no open work orders"} tone={kpis?.activeBreakdowns ? "error" : "default"} pending={dash.loading} onClick={() => setParam("status", "BREAKDOWN")} active={statusFilter === "BREAKDOWN"} />
        <StatCard
          label="This-month repairs"
          value={kpis?.repairSpendThisMonthCenti != null ? money(kpis.repairSpendThisMonthCenti) : "—"}
          subtitle={kpis?.costliestVehicle ? `Costliest ${kpis.costliestVehicle} ${money(kpis.costliestVehicleCenti ?? 0)}` : "No repairs logged"}
          pending={dash.loading}
        />
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
                <th className="px-3.5 py-2.5 font-semibold">Downtime</th>
              </tr>
            </thead>
            <tbody>
              {dash.loading ? (
                <tr>
                  <td colSpan={9} className="p-4">
                    <ListSkeleton />
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3.5 py-8 text-center text-[13px] text-ink-muted">
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
                        {v.mileageFlagged && <span className="ml-1.5 text-[10px] text-warning-text" title="Abnormal jump — review">flagged</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        <NextServiceCell v={v} />
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
                        {(v.openWorkOrders ?? 0) > 0 && (
                          <span className="ml-1.5 text-[10px] text-ink-muted">{v.openWorkOrders} WO</span>
                        )}
                      </td>
                      <td className="px-3.5 py-3 text-[12px]">
                        {v.downtimeHours != null ? (
                          <span className="tabular-nums text-err">{fmtDowntime(v.downtimeHours)}</span>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
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

      <VehicleDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => dash.reload()} />
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
function VehicleDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const detail = useQuery<VehicleDetailPayload>(
    `/api/fleet-maintenance/vehicles/${id}`,
    () => api.get(`/api/fleet-maintenance/vehicles/${id}`),
    [id],
    { enabled: id != null },
  );
  const v = detail.data?.vehicle;
  const compliance = detail.data?.compliance;
  const refresh = () => {
    detail.reload();
    onChanged?.();
  };

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

            {/* Breakdown & incidents */}
            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Breakdown &amp; incidents</h3>
              <span className="text-[10.5px] text-ink-muted">a critical, unresolved case grounds the lorry</span>
            </div>
            <BreakdownSection vehicleId={v.id} breakdowns={detail.data?.breakdowns ?? []} onChanged={refresh} />

            {/* Maintenance work orders */}
            <div className="mb-2 mt-6 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Work orders</h3>
              <span className="text-[10.5px] text-ink-muted">Reported → Diagnosed → Approved → In Repair → Waiting Parts → Completed → Verified</span>
            </div>
            <WorkOrdersSection vehicleId={v.id} workOrders={detail.data?.workOrders ?? []} onChanged={refresh} />

            {/* Tyre & component lifecycle */}
            <div className="mb-2 mt-6 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Tyres &amp; components</h3>
              <span className="text-[10.5px] text-ink-muted">serial lifecycle · km used + cost/km derived</span>
            </div>
            <ComponentsSection vehicleId={v.id} currentKm={v.mileageKm} components={detail.data?.components ?? []} onChanged={refresh} />

            {/* Preventive maintenance — per-component plans with due-bars */}
            <div className="mt-6" />

            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Preventive maintenance</h3>
              <span className="text-[10.5px] text-ink-muted">per component · due on whichever comes first (km or months)</span>
            </div>
            <PlansSection plans={detail.data?.plans ?? []} currentKm={v.mileageKm} />

            {/* Mileage — daily odometer readings (day-complete capture) */}
            <div className="mb-2 mt-6 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Mileage</h3>
              <span className="text-[10.5px] text-ink-muted">
                {v.mileageKm != null ? `${v.mileageKm.toLocaleString()} km` : "no reading"}
                {v.mileageDate ? ` · ${v.mileageDate}` : ""}
                {v.mileageSource === "service" ? " · from service record" : ""}
              </span>
            </div>
            <MileageSection readings={detail.data?.mileage ?? []} />

            <div className="mb-2 mt-6 flex items-center gap-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Compliance vault</h3>
              <span className="text-[10.5px] text-ink-muted">current document + renewal history (append-only)</span>
            </div>

            <div className="space-y-4">
              {DOC_TYPES.map((t) => {
                const group = compliance[t];
                const history = group?.history ?? [];
                const currentId = group?.currentId ?? null;
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
                            key={doc.id ?? `${doc.docType}-${doc.expiryDate}`}
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
              Renew a compliance document by adding a new row (never overwrite) — the history above is the audit trail. Mileage is
              captured daily by the driver on day-complete. Work-order totals and active breakdowns feed the fleet KPIs.
            </p>
          </>
        )}
      </div>
    </ResizableDetailDrawer>
  );
}

/** Per-component preventive-maintenance plans, each with a due-bar showing how
 *  far through its interval it is (km OR months — whichever is more consumed). */
function PlansSection({ plans, currentKm }: { plans: PlanView[]; currentKm: number | null }) {
  if (plans.length === 0) {
    return (
      <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">
        No preventive-maintenance plans on this lorry yet. Seed the default set (backend/scripts/seed-fleet-plans.mjs) or add plans via the API.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {plans.map((p) => (
        <PlanRow key={p.id} p={p} currentKm={currentKm} />
      ))}
    </div>
  );
}

/** Fraction of a plan's interval consumed, 0..1, on whichever axis is furthest
 *  along (closest to due). Used only for the visual bar. */
function planProgress(p: PlanView, currentKm: number | null): number {
  const fracs: number[] = [];
  if (p.intervalKm && p.lastDoneKm != null && currentKm != null) {
    fracs.push((currentKm - p.lastDoneKm) / p.intervalKm);
  } else if (p.intervalKm && p.kmRemaining != null) {
    fracs.push((p.intervalKm - p.kmRemaining) / p.intervalKm);
  }
  if (p.intervalMonths && p.daysRemaining != null) {
    const totalDays = p.intervalMonths * 30.44;
    fracs.push((totalDays - p.daysRemaining) / totalDays);
  }
  if (fracs.length === 0) return 0;
  return Math.max(0, Math.min(1, Math.max(...fracs)));
}

function PlanRow({ p, currentKm }: { p: PlanView; currentKm: number | null }) {
  const pct = Math.round(planProgress(p, currentKm) * 100);
  const barColor = p.tone === "crit" ? "bg-err" : p.tone === "warn" ? "bg-warning-text" : "bg-synced";
  const interval = [p.intervalKm ? `${p.intervalKm.toLocaleString()} km` : null, p.intervalMonths ? `${p.intervalMonths} mo` : null].filter(Boolean).join(" / ");
  const due = [
    p.nextDueKm != null ? `${p.nextDueKm.toLocaleString()} km` : null,
    p.nextDueDate ?? null,
  ].filter(Boolean).join(" · ");
  return (
    <div className={cn("rounded-lg border p-3", p.active ? "border-border bg-surface-2/40" : "border-transparent bg-transparent opacity-60")}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[12.5px] font-semibold text-ink">
          {p.componentLabel}
          {!p.active && <span className="ml-2 text-[10px] font-normal text-ink-muted">inactive</span>}
        </span>
        <Pill tone={p.tone}>{p.overdue ? "Overdue" : p.dueSoon ? "Due soon" : "OK"}</Pill>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[10.5px] text-ink-muted">
        <span>
          {interval ? `every ${interval}` : "no interval"}
          {due ? ` · next ${due}` : (p.lastDoneKm == null && p.lastDoneDate == null ? " · never done" : "")}
        </span>
        <span className={cn(p.tone === "crit" ? "text-err" : p.tone === "warn" ? "text-warning-text" : "text-ink-muted")}>
          {p.overdue ? "OVERDUE · " : ""}
          {fmtPlanRemaining(p)}
        </span>
      </div>
    </div>
  );
}

/** Recent daily mileage readings — day-complete captures, with flags. */
function MileageSection({ readings }: { readings: MileageView[] }) {
  if (readings.length === 0) {
    return (
      <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">
        No mileage readings yet. The driver captures the odometer on day-complete from the mobile app.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {readings.slice(0, 8).map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2.5 py-1.5 text-[12px]">
          <span className="flex items-center gap-2.5">
            <span className="tabular-nums font-semibold text-ink">{r.odometerKm != null ? r.odometerKm.toLocaleString() : "—"} km</span>
            <span className="text-[10.5px] text-ink-muted">{r.readingDate ?? "—"}</span>
            <span className="text-[10px] uppercase tracking-brand text-ink-muted">{r.source ?? ""}</span>
          </span>
          <span className="flex items-center gap-2">
            {r.flagged && <Pill tone="warn">Review</Pill>}
            {r.photoRef && <span className="text-[10.5px] text-ink-muted">photo</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Phase 3 drawer sections ──────────────────────────────────────────────────

const FIELD_CLS = "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink focus:border-primary focus:outline-none";
const FIELD_LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

function apiErrText(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  const known: Record<string, string> = {
    illegal_transition: "That step is not allowed from the current state.",
    position_occupied: "Another active component already occupies that position.",
    vehicle_not_found: "Vehicle not found.",
  };
  for (const [k, msg] of Object.entries(known)) if (m.includes(k)) return msg;
  return "Could not save. Please try again.";
}

const SEVERITY_TONE: Record<BreakdownView["severity"], Tone> = { MINOR: "info", MAJOR: "warn", CRITICAL: "crit" };
const BREAKDOWN_STATUS_LABEL: Record<BreakdownView["status"], string> = { OPEN: "Open", TOWING: "Towing", IN_WORKSHOP: "In workshop", RESOLVED: "Resolved" };

/** Breakdown & incident cases — report a new one, advance status / resolve. */
function BreakdownSection({ vehicleId, breakdowns, onChanged }: { vehicleId: string; breakdowns: BreakdownView[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [faultType, setFaultType] = useState("");
  const [severity, setSeverity] = useState<BreakdownView["severity"]>("MAJOR");
  const [stillDrivable, setStillDrivable] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [impact, setImpact] = useState<{ trips: number; suggestions: { plate: string }[] } | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ grounding: boolean; affectedTrips: unknown[]; replacementSuggestions: { plate: string }[] }>(
        `/api/fleet-maintenance/vehicles/${vehicleId}/breakdowns`,
        { faultType: faultType.trim() || undefined, severity, stillDrivable, driverDescription: description.trim() || undefined, breakdownStart: new Date().toISOString() },
      );
      if (res.grounding) setImpact({ trips: res.affectedTrips.length, suggestions: res.replacementSuggestions ?? [] });
      setAdding(false); setFaultType(""); setDescription(""); setSeverity("MAJOR"); setStillDrivable(false);
      onChanged();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  const setStatus = async (id: string, status: BreakdownView["status"]) => {
    try {
      const patch: Record<string, unknown> = { status };
      if (status === "RESOLVED") patch.recoveryTime = new Date().toISOString();
      await api.patch(`/api/fleet-maintenance/breakdowns/${id}`, patch);
      onChanged();
    } catch { /* surfaced on reload */ }
  };

  return (
    <div className="space-y-2">
      {impact && (
        <div className="rounded-md border border-err/25 bg-err/10 px-3 py-2 text-[11.5px] text-err">
          Lorry grounded. {impact.trips} trip(s) affected. Dispatch notified.
          {impact.suggestions.length > 0 && <> Suggested replacements: {impact.suggestions.map((s) => s.plate).join(", ")}.</>}
        </div>
      )}
      {breakdowns.length === 0 && !adding && (
        <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">No breakdown cases on file.</p>
      )}
      {breakdowns.map((b) => (
        <div key={b.id} className={cn("rounded-lg border p-3", b.grounding ? "border-err/30 bg-err/5" : "border-border bg-surface-2/40")}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
              <Pill tone={SEVERITY_TONE[b.severity]}>{b.severity}</Pill>
              {b.faultType || "Incident"}
            </span>
            <span className="text-[10.5px] text-ink-muted">{fmtDateTime(b.occurredAt)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
            <span>{b.stillDrivable ? "Still drivable" : "Not drivable"}</span>
            {b.downtimeHours != null && <span className="text-err">Downtime {fmtDowntime(b.downtimeHours)}</span>}
            {b.towingCompany && <span>Tow: {b.towingCompany}</span>}
            {b.workshop && <span>Workshop: {b.workshop}</span>}
            {b.gpsLat != null && b.gpsLng != null && <span>GPS {b.gpsLat.toFixed(4)}, {b.gpsLng.toFixed(4)}</span>}
          </div>
          {b.driverDescription && <div className="mt-1 text-[11px] text-ink-secondary">{b.driverDescription}</div>}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10.5px] uppercase tracking-brand text-ink-muted">{BREAKDOWN_STATUS_LABEL[b.status]}</span>
            {b.status !== "RESOLVED" && (
              <select
                className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-ink"
                value={b.status}
                onChange={(e) => setStatus(b.id, e.target.value as BreakdownView["status"])}
              >
                {(["OPEN", "TOWING", "IN_WORKSHOP", "RESOLVED"] as const).map((s) => (
                  <option key={s} value={s}>{BREAKDOWN_STATUS_LABEL[s]}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      ))}

      {adding ? (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="col-span-2">
              <label className={FIELD_LABEL}>Fault</label>
              <input className={FIELD_CLS} value={faultType} onChange={(e) => setFaultType(e.target.value)} placeholder="e.g. Tyre burst, engine overheat" />
            </div>
            <div>
              <label className={FIELD_LABEL}>Severity</label>
              <select className={FIELD_CLS} value={severity} onChange={(e) => setSeverity(e.target.value as BreakdownView["severity"])}>
                <option value="MINOR">Minor</option>
                <option value="MAJOR">Major</option>
                <option value="CRITICAL">Critical (grounds lorry)</option>
              </select>
            </div>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-[11.5px] text-ink-secondary">
                <input type="checkbox" checked={stillDrivable} onChange={(e) => setStillDrivable(e.target.checked)} />
                Still drivable
              </label>
            </div>
            <div className="col-span-2">
              <label className={FIELD_LABEL}>Description</label>
              <input className={FIELD_CLS} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened" />
            </div>
          </div>
          {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Report breakdown"}</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>Report a breakdown</Button>
      )}
    </div>
  );
}

/** Maintenance work orders — the state-machine stepper + parts table. */
function WorkOrdersSection({ vehicleId, workOrders, onChanged }: { vehicleId: string; workOrders: WorkOrderView[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState("");
  const [workshop, setWorkshop] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (busy || !problem.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/fleet-maintenance/vehicles/${vehicleId}/work-orders`, { problem: problem.trim(), workshop: workshop.trim() || undefined });
      setAdding(false); setProblem(""); setWorkshop(""); onChanged();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {workOrders.length === 0 && !adding && (
        <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">No work orders on this lorry.</p>
      )}
      {workOrders.map((wo) => (
        <WorkOrderCard key={wo.id} wo={wo} onChanged={onChanged} />
      ))}
      {adding ? (
        <div className="rounded-lg border border-border bg-surface p-3">
          <label className={FIELD_LABEL}>Problem</label>
          <input className={FIELD_CLS} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="What needs fixing" />
          <label className={cn(FIELD_LABEL, "mt-2")}>Workshop</label>
          <input className={FIELD_CLS} value={workshop} onChange={(e) => setWorkshop(e.target.value)} placeholder="Optional" />
          {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={create} disabled={busy || !problem.trim()}>{busy ? "Saving…" : "Open work order"}</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>New work order</Button>
      )}
    </div>
  );
}

const WO_TONE: Record<WorkOrderState, Tone> = {
  REPORTED: "info", DIAGNOSED: "info", APPROVED: "info", IN_REPAIR: "warn", WAITING_PARTS: "warn", COMPLETED: "ok", VERIFIED: "ok",
};

function WorkOrderCard({ wo, onChanged }: { wo: WorkOrderView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [addingPart, setAddingPart] = useState(false);
  const [pName, setPName] = useState("");
  const [pQty, setPQty] = useState("1");
  const [pPrice, setPPrice] = useState("");

  const transition = async (to: WorkOrderState) => {
    if (busy) return;
    setBusy(true);
    try { await api.post(`/api/fleet-maintenance/work-orders/${wo.id}/transition`, { to }); onChanged(); }
    catch { /* surfaced on reload */ } finally { setBusy(false); }
  };
  const addPart = async () => {
    if (busy || !pName.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/fleet-maintenance/work-orders/${wo.id}/parts`, {
        name: pName.trim(), qty: Number(pQty) || 1, unitPriceCenti: Math.round((Number(pPrice) || 0) * 100),
      });
      setAddingPart(false); setPName(""); setPQty("1"); setPPrice(""); onChanged();
    } catch { /* surfaced on reload */ } finally { setBusy(false); }
  };
  const removePart = async (partId: string) => {
    setBusy(true);
    try { await api.del(`/api/fleet-maintenance/work-orders/${wo.id}/parts/${partId}`); onChanged(); }
    catch { /* ignore */ } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-ink">{wo.problem || "Work order"}</span>
        <Pill tone={WO_TONE[wo.status]}>{wo.statusLabel}</Pill>
      </div>
      {/* Stepper */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {WORK_ORDER_STATES.map((s, i) => {
          const idx = WORK_ORDER_STATES.indexOf(wo.status);
          const reached = i <= idx;
          return (
            <span key={s} className="flex items-center gap-1">
              <span className={cn("rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-brand", reached ? "bg-primary-soft text-primary" : "bg-surface-2 text-ink-muted")}>
                {WORK_ORDER_STATE_LABEL[s]}
              </span>
              {i < WORK_ORDER_STATES.length - 1 && <span className="text-ink-muted">›</span>}
            </span>
          );
        })}
      </div>
      {wo.nextStates.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {wo.nextStates.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => transition(s)} className="rounded-md border border-primary/40 bg-primary-soft px-2 py-1 text-[10.5px] font-semibold text-primary hover:bg-primary-soft/70 disabled:opacity-50">
              → {WORK_ORDER_STATE_LABEL[s]}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
        {wo.workshop && <span>{wo.workshop}</span>}
        <span>Reported {fmtDateTime(wo.reportedAt)}</span>
        {wo.actualComplete && <span>Done {fmtDateTime(wo.actualComplete)}</span>}
        {wo.warrantyUntil && <span>Warranty to {wo.warrantyUntil}</span>}
      </div>
      {/* Parts table */}
      {wo.parts.length > 0 && (
        <table className="mt-2 w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-[9.5px] uppercase tracking-brand text-ink-muted">
              <th className="py-1 pr-2 font-semibold">Part</th>
              <th className="py-1 pr-2 font-semibold">Qty</th>
              <th className="py-1 pr-2 text-right font-semibold">Unit</th>
              <th className="py-1 pr-2 text-right font-semibold">Line</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wo.parts.map((p) => (
              <tr key={p.id} className="border-t border-border/60">
                <td className="py-1 pr-2 text-ink">{p.name}{p.partNo ? <span className="text-ink-muted"> · {p.partNo}</span> : ""}{p.serial ? <span className="text-ink-muted"> · SN {p.serial}</span> : ""}</td>
                <td className="py-1 pr-2 tabular-nums">{p.qty}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(p.unitPriceCenti)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(p.lineCenti)}</td>
                <td className="py-1 text-right"><button type="button" onClick={() => removePart(p.id)} className="text-ink-muted hover:text-err" aria-label="Remove part"><X size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {addingPart ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[120px] flex-1"><label className={FIELD_LABEL}>Part</label><input className={FIELD_CLS} value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Name" /></div>
          <div className="w-16"><label className={FIELD_LABEL}>Qty</label><input className={FIELD_CLS} value={pQty} onChange={(e) => setPQty(e.target.value)} inputMode="decimal" /></div>
          <div className="w-24"><label className={FIELD_LABEL}>Unit RM</label><input className={FIELD_CLS} value={pPrice} onChange={(e) => setPPrice(e.target.value)} inputMode="decimal" /></div>
          <Button variant="primary" onClick={addPart} disabled={busy || !pName.trim()}>Add</Button>
          <Button variant="secondary" onClick={() => setAddingPart(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between">
          <button type="button" onClick={() => setAddingPart(true)} className="text-[10.5px] font-semibold text-primary hover:underline">+ Add part</button>
          <span className="text-[12px] font-semibold text-ink">Total {money(wo.totalCenti)}</span>
        </div>
      )}
    </div>
  );
}

/** Tyre & component lifecycle — serial cards with derived km/cost, fit + remove +
 *  event logging. */
function ComponentsSection({ vehicleId, currentKm, components, onChanged }: { vehicleId: string; currentKm: number | null; components: ComponentView[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState("TYRE");
  const [position, setPosition] = useState("NA");
  const [brand, setBrand] = useState("");
  const [serial, setSerial] = useState("");
  const [fittedKm, setFittedKm] = useState(currentKm != null ? String(currentKm) : "");
  const [price, setPrice] = useState("");
  const [warranty, setWarranty] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/fleet-maintenance/vehicles/${vehicleId}/components`, {
        componentType: type, position, brand: brand.trim() || undefined, serial: serial.trim() || undefined,
        fittedKm: fittedKm ? Number(fittedKm) : undefined, fittedDate: new Date().toISOString().slice(0, 10),
        purchasePriceCenti: price ? Math.round(Number(price) * 100) : undefined, warrantyUntil: warranty || undefined,
      });
      setAdding(false); setBrand(""); setSerial(""); setPrice(""); setWarranty(""); onChanged();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  const active = components.filter((c) => c.status === "ACTIVE");
  const removed = components.filter((c) => c.status === "REMOVED");

  return (
    <div className="space-y-2">
      {components.length === 0 && !adding && (
        <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">No components tracked. Fit a tyre, battery or part to start its lifecycle.</p>
      )}
      {active.map((c) => <ComponentCard key={c.id} c={c} currentKm={currentKm} onChanged={onChanged} />)}
      {removed.length > 0 && <div className="pt-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Removed</div>}
      {removed.map((c) => <ComponentCard key={c.id} c={c} currentKm={currentKm} onChanged={onChanged} />)}

      {adding ? (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={FIELD_LABEL}>Type</label>
              <select className={FIELD_CLS} value={type} onChange={(e) => setType(e.target.value)}>
                {["TYRE", "BATTERY", "BRAKE_PADS", "ALTERNATOR", "STARTER", "GEARBOX", "AIR_COMPRESSOR", "OTHER"].map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div>
              <label className={FIELD_LABEL}>Position</label>
              <select className={FIELD_CLS} value={position} onChange={(e) => setPosition(e.target.value)}>
                {["NA", "FRONT_L", "FRONT_R", "REAR_L", "REAR_R"].map((p) => <option key={p} value={p}>{p.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div><label className={FIELD_LABEL}>Brand</label><input className={FIELD_CLS} value={brand} onChange={(e) => setBrand(e.target.value)} /></div>
            <div><label className={FIELD_LABEL}>Serial</label><input className={FIELD_CLS} value={serial} onChange={(e) => setSerial(e.target.value)} /></div>
            <div><label className={FIELD_LABEL}>Fitted km</label><input className={FIELD_CLS} value={fittedKm} onChange={(e) => setFittedKm(e.target.value)} inputMode="numeric" /></div>
            <div><label className={FIELD_LABEL}>Price RM</label><input className={FIELD_CLS} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></div>
            <div className="col-span-2"><label className={FIELD_LABEL}>Warranty until</label><input className={FIELD_CLS} type="date" value={warranty} onChange={(e) => setWarranty(e.target.value)} /></div>
          </div>
          {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={fit} disabled={busy}>{busy ? "Saving…" : "Fit component"}</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>Fit a component</Button>
      )}
    </div>
  );
}

const EVENT_TYPES = ["ROTATION", "PUNCTURE", "REPAIR", "INSPECTION", "OTHER"] as const;

function ComponentCard({ c, currentKm, onChanged }: { c: ComponentView; currentKm: number | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [logging, setLogging] = useState(false);
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>("ROTATION");
  const [eventNote, setEventNote] = useState("");

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/fleet-maintenance/components/${c.id}`, { status: "REMOVED", removedDate: new Date().toISOString().slice(0, 10), removedKm: currentKm ?? undefined });
      onChanged();
    } catch { /* surfaced on reload */ } finally { setBusy(false); }
  };
  const logEvent = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/fleet-maintenance/components/${c.id}/events`, { eventType, eventDate: new Date().toISOString().slice(0, 10), odometerKm: currentKm ?? undefined, note: eventNote.trim() || undefined });
      setLogging(false); setEventNote(""); onChanged();
    } catch { /* surfaced on reload */ } finally { setBusy(false); }
  };

  return (
    <div className={cn("rounded-lg border p-3", c.status === "ACTIVE" ? "border-border bg-surface-2/40" : "border-transparent bg-transparent opacity-70")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          {c.componentTypeLabel}
          {c.position !== "NA" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{c.positionLabel}</span>}
        </span>
        {c.underWarranty != null && <Pill tone={c.underWarranty ? "ok" : "neutral"}>{c.underWarranty ? "Under warranty" : "Warranty expired"}</Pill>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
        {c.brand && <span>{[c.brand, c.model, c.size].filter(Boolean).join(" ")}</span>}
        {c.serial && <span>SN {c.serial}</span>}
        {c.fittedDate && <span>Fitted {c.fittedDate}{c.fittedKm != null ? ` @ ${c.fittedKm.toLocaleString()} km` : ""}</span>}
        {c.removedDate && <span>Removed {c.removedDate}{c.removedKm != null ? ` @ ${c.removedKm.toLocaleString()} km` : ""}</span>}
        {c.treadDepth != null && <span>Tread {c.treadDepth} mm</span>}
        {c.kmUsed != null && <span className="text-ink-secondary">{c.kmUsed.toLocaleString()} km used</span>}
        {c.costPerKmCenti != null && <span className="text-ink-secondary">{money(c.costPerKmCenti)}/km</span>}
      </div>
      {c.events.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {c.events.slice(0, 5).map((e) => (
            <div key={e.id} className="flex items-center gap-2 text-[10.5px] text-ink-muted">
              <span className="uppercase tracking-brand">{e.eventType}</span>
              <span>{e.eventDate}</span>
              {e.odometerKm != null && <span className="tabular-nums">{e.odometerKm.toLocaleString()} km</span>}
              {e.toPosition && <span>→ {e.toPosition}</span>}
              {e.note && <span className="text-ink-secondary">{e.note}</span>}
            </div>
          ))}
        </div>
      )}
      {c.status === "ACTIVE" && (
        logging ? (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-32"><label className={FIELD_LABEL}>Event</label>
              <select className={FIELD_CLS} value={eventType} onChange={(e) => setEventType(e.target.value as (typeof EVENT_TYPES)[number])}>
                {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="min-w-[120px] flex-1"><label className={FIELD_LABEL}>Note</label><input className={FIELD_CLS} value={eventNote} onChange={(e) => setEventNote(e.target.value)} /></div>
            <Button variant="primary" onClick={logEvent} disabled={busy}>Log</Button>
            <Button variant="secondary" onClick={() => setLogging(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="mt-2 flex gap-3">
            <button type="button" onClick={() => setLogging(true)} className="text-[10.5px] font-semibold text-primary hover:underline">+ Log event</button>
            <button type="button" onClick={remove} disabled={busy} className="text-[10.5px] font-semibold text-ink-muted hover:text-err disabled:opacity-50">Remove</button>
          </div>
        )
      )}
    </div>
  );
}
