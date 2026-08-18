import { useMemo, useState, useRef, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { Truck, RefreshCw, X, AlertTriangle, ChevronRight, FileUp } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatCard } from "../components/StatCard";
import { ResizableDetailDrawer } from "../components/ResizableDetailDrawer";
import { ListSkeleton } from "../components/Skeleton";
import { RepairDocumentImport } from "../components/RepairDocumentImport";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { fmtDate, fmtDateTime } from "@2990s/shared";
import { DateField } from "../vendor/scm/components/DateField";

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

export const DOC_TYPES = ["PUSPAKOM", "ROAD_TAX", "INSURANCE", "APAD", "CROSS_BORDER"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_LABEL: Record<DocType, string> = {
  PUSPAKOM: "PUSPAKOM",
  ROAD_TAX: "Road Tax / LKM",
  INSURANCE: "Insurance",
  APAD: "APAD permit",
  CROSS_BORDER: "Cross-border",
};

export type Tone = "crit" | "warn" | "ok" | "info" | "neutral";

export type DocView = {
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
  /** mig 0238 - the scans attached to this renewal. */
  files?: ComplianceFile[];
};

type ComplianceFile = {
  id: string;
  r2Key: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
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

export type PlanView = {
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

export type MileageView = {
  id: string;
  readingDate: string | null;
  odometerKm: number | null;
  source: string | null;
  photoRef: string | null;
  flagged: boolean;
  note: string | null;
};

export type VehicleRow = {
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

/* A copy of WORK_ORDER_STATES in services/fleet-status.ts, kept in step by
   `npm run audit:work-order-states`. The stepper needs the ORDER, which the API
   does not send. */
const WORK_ORDER_STATES = [
  "REPORTED",
  "DIAGNOSED",
  "QUOTED",
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
  QUOTED: "Quoted",
  APPROVED: "Approved",
  IN_REPAIR: "In Repair",
  WAITING_PARTS: "Waiting Parts",
  COMPLETED: "Completed",
  VERIFIED: "Verified",
};

type PartView = { id: string; name: string; partNo: string | null; qty: number; unitPriceCenti: number; lineCenti: number; serial: string | null };
export type WorkOrderView = {
  id: string;
  /** WO-#### (mig 0248) — OURS. quotationNo is the workshop's own number, off
   *  their document; it is not unique across vendors and is often absent. */
  woNo?: string | null;
  status: WorkOrderState;
  statusLabel: string;
  open: boolean;
  nextStates: WorkOrderState[];
  problem: string | null;
  diagnosis: string | null;
  workshop: string | null;
  /** THEIRS — off the workshop's own document (mig 0241). Shown beside woNo so
   *  the two are never confused for each other. */
  quotationNo?: string | null;
  invoiceNo?: string | null;
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

export type BreakdownView = {
  id: string;
  /** BD-#### (mig 0248) — ours. */
  caseNo?: string | null;
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
export type ComponentView = {
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

export type VehicleDetailPayload = {
  vehicle: VehicleRow & {
    lastServiceWorkshop?: string | null;
    /* WS3 (mig 0209) has stored the box since it shipped; the drawer never
       showed it until 2026-08-01. capacity_m3 is derived from L x W x H. */
    isInternal?: boolean;
    /* Mig 0245 — four dates that answer four different questions and are
       routinely confused. Surfaced on the full record page. */
    manufactureDate?: string | null;
    registrationDate?: string | null;
    inServiceDate?: string | null;
    purchaseDate?: string | null;
    purchasePriceCenti?: number | null;
    capacityM3?: number | null;
    lengthFt?: number | null;
    widthFt?: number | null;
    heightFt?: number | null;
  };
  compliance: Record<DocType, { currentId: string | null; flatExpiry: string | null; history: DocView[] }>;
  plans: PlanView[];
  planComponents?: { value: string; label: string }[];
  mileage: MileageView[];
  maintenanceWindows: Array<{ from: string | null; to: string | null; reason: string | null }>;
  breakdowns: BreakdownView[];
  workOrders: WorkOrderView[];
  components: ComponentView[];
};

export const STATUS_TONE: Record<VehicleStatus, Tone> = {
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

export function fmtDays(days: number | null): string {
  if (days === null) return "no date on file";
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  return `in ${days}d`;
}

export function money(centi: number | null): string {
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

/* Re-exported, not re-implemented — this printed the STORAGE shape at the
   user. LorryRecord.tsx imports the name from here. */
export { fmtDateTime };

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
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
export function fmtPlanRemaining(p: { kmRemaining: number | null; daysRemaining: number | null; overdue: boolean }): string {
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
export function openProblem(v: VehicleRow): string | null {
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
  const navigate = useNavigate();

  /* Sales Order's interaction, which the owner asked for by name: "单击：弹出一个
     shortcut，让我简单看一个简介; 双击：点进去看细节".

     A double click fires click, click, dblclick — so opening the drawer on the
     first click would flash it open and then navigate away underneath it. The
     peek is held for one double-click interval and cancelled if the second
     click lands. 250ms is under the platform default (500ms) on purpose: the
     drawer should not feel laggy, and a slow double click still works because
     the navigation fires regardless. */
  const peekTimer = useRef<number | null>(null);
  const cancelPeek = () => {
    if (peekTimer.current != null) { window.clearTimeout(peekTimer.current); peekTimer.current = null; }
  };
  // The suite had no unmount for a year and leaked exactly this kind of timer
  // into a torn-down jsdom (BUG-HISTORY, 2026-08-02).
  useEffect(() => cancelPeek, []);
  const peek = (id: string) => {
    cancelPeek();
    peekTimer.current = window.setTimeout(() => { peekTimer.current = null; setOpenId(id); }, 250);
  };
  const openRecord = (id: string) => { cancelPeek(); navigate(`/fleet-health/${id}`); };

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
        <p className="border-b border-border bg-surface-2/40 px-3.5 py-1.5 text-[10.5px] text-ink-muted">
          Click a row for the quick look. Double-click, or click the plate, to open the full record — the plate is a link, so it opens in a new tab too.
        </p>
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
                      onClick={() => peek(v.id)}
                      onDoubleClick={() => openRecord(v.id)}
                      onKeyDown={(e) => {
                        // Keyboard cannot double-click: Enter peeks, Shift+Enter
                        // is the "go in" that the second click is with a mouse.
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        if (e.shiftKey) openRecord(v.id); else setOpenId(v.id);
                      }}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                    >
                      <td className="px-3.5 py-3">
                        {/* A REAL anchor, so the browser's own affordances work:
                            Cmd/Ctrl-click and middle-click open the record in a
                            new tab, and right-click offers "Open link in new
                            tab". Owner, 2026-08-03: "我在第二个页面打开进去是不能
                            的吗?" — it was not, because the row was a <tr> with
                            an onClick and there was nothing to open.

                            stopPropagation so the plate does not ALSO fire the
                            row's peek: a link means "go there", and one click
                            should not both navigate and open a drawer. */}
                        <Link
                          to={`/fleet-health/${v.id}`}
                          onClick={(e) => { e.stopPropagation(); cancelPeek(); }}
                          className="font-semibold text-ink hover:text-primary hover:underline"
                        >
                          {v.plate}
                        </Link>
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

export function statusLabel(status: string): string {
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
            {v ? [
              v.driverName,
              v.region ? `${v.region} warehouse` : null,
              v.mileageKm != null ? `${v.mileageKm.toLocaleString()} km` : null,
              v.isInternal === false ? "Outsource" : "In-house",
              boxLabel(v),
            ].filter(Boolean).join(" · ") : ""}
          </div>
          {v && <MissingComplianceNote vehicle={v} compliance={compliance} />}
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
        {v && (
          <div className="space-y-4">
            {/* THE DRAWER ANSWERS ONE QUESTION: can I use this lorry today.
                Owner, 2026-08-02 — "它应该只需要看得到现在的 Mileage，以及下一次
                什么时候要去维修，有一些基础功能就行了... 要不然界面会显得非常乱".
                The compliance vault, work orders, the workshop-document import,
                tyres, plans and mileage history all moved to /fleet-health/:id.
                Reporting a breakdown stays: it is the one thing that is urgent
                while you are standing at the lorry. */}
            {v.outOfService && (
              <p className="rounded-md border border-err/25 bg-err/10 px-3 py-2 text-[12px] text-err">
                Out of service{v.outOfServiceReason ? ` — ${v.outOfServiceReason}` : ""}.
              </p>
            )}
            {openProblem(v) && !v.outOfService && (
              <p className="rounded-md border border-warning-text/25 bg-warning-text/10 px-3 py-2 text-[12px] text-warning-text">
                {openProblem(v)}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-surface-2/40 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Mileage</div>
                <div className="mt-1 text-[16px] font-semibold tabular-nums text-ink">
                  {v.mileageKm != null ? v.mileageKm.toLocaleString() : "—"}
                  <span className="ml-1 text-[11px] font-normal text-ink-muted">km</span>
                </div>
                <div className="text-[10.5px] text-ink-muted">
                  {v.mileageDate ? `read ${v.mileageDate}` : "no reading yet"}
                  {v.mileageFlagged ? " · flagged" : ""}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-surface-2/40 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Next service</div>
                <div className="mt-1"><NextServiceCell v={v} /></div>
              </div>
            </div>

            <Link
              to={`/fleet-health/${v.id}`}
              className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5 text-[12px] text-ink transition-colors hover:border-primary/40 hover:bg-primary-soft"
            >
              <span>
                <span className="font-semibold">Open the full record</span>
                <span className="ml-2 text-[11px] text-ink-muted">
                  compliance, work orders, tyres, plans, mileage history
                </span>
              </span>
              <ChevronRight size={15} className="text-ink-muted" />
            </Link>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">Breakdown &amp; incidents</h3>
                <span className="text-[10.5px] text-ink-muted">a critical, unresolved case grounds the lorry</span>
              </div>
              <BreakdownSection vehicleId={v.id} breakdowns={detail.data?.breakdowns ?? []} onChanged={refresh} />
            </div>
          </div>
        )}
      </div>
    </ResizableDetailDrawer>
  );
}

/** Per-component preventive-maintenance plans, each with a due-bar showing how
 *  far through its interval it is (km OR months — whichever is more consumed). */
export function PlansSection({ plans, currentKm, vehicleId, components, onChanged }: {
  plans: PlanView[];
  currentKm: number | null;
  /* Optional so the section still renders read-only where there is nothing to
     write to (the dashboard's own preview). Given all three, it can be edited. */
  vehicleId?: string;
  components?: { value: string; label: string }[];
  onChanged?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PlanView | null>(null);
  const canWrite = !!vehicleId && !!onChanged;

  return (
    <div className="space-y-2">
      {plans.length === 0 && !adding && (
        <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">
          {/* This used to read "Seed the default set (backend/scripts/
              seed-fleet-plans.mjs) or add plans via the API" — an empty state
              that told the owner to run a Node script. The write routes existed
              the whole time; only the form was missing. Owner: "我该怎么去用?" */}
          No preventive-maintenance plans on this lorry yet. A plan is one component and how often it is due —
          by kilometres, by months, or both, whichever comes first.
        </p>
      )}

      {plans.map((p) => (
        <PlanRow key={p.id} p={p} currentKm={currentKm} onEdit={canWrite ? () => { setEditing(p); setAdding(false); } : undefined} />
      ))}

      {canWrite && (adding || editing) && (
        <PlanForm
          vehicleId={vehicleId}
          components={components ?? []}
          /* Editing an existing plan re-POSTs it: the route UPSERTs on
             (lorry, component), so the component is the identity and PATCH by
             id would be a second way to write the same row. */
          plan={editing}
          taken={new Set(plans.map((p) => p.component))}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); onChanged(); }}
        />
      )}

      {canWrite && !adding && !editing && (
        <Button variant="secondary" onClick={() => setAdding(true)}>Add a plan</Button>
      )}
    </div>
  );
}

/** Create or edit one plan. The route UPSERTs on (lorry, component), so the
 *  component picker is disabled while editing — changing it would silently move
 *  the plan to a different component instead of renaming this one. */
function PlanForm({ vehicleId, components, plan, taken, onCancel, onSaved }: {
  vehicleId: string;
  components: { value: string; label: string }[];
  plan: PlanView | null;
  taken: Set<string>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const free = components.filter((c) => !taken.has(c.value));
  const [component, setComponent] = useState(plan?.component ?? free[0]?.value ?? components[0]?.value ?? "");
  const [intervalKm, setIntervalKm] = useState(plan?.intervalKm != null ? String(plan.intervalKm) : "");
  const [intervalMonths, setIntervalMonths] = useState(plan?.intervalMonths != null ? String(plan.intervalMonths) : "");
  const [lastDoneKm, setLastDoneKm] = useState(plan?.lastDoneKm != null ? String(plan.lastDoneKm) : "");
  const [lastDoneDate, setLastDoneDate] = useState(plan?.lastDoneDate ?? "");
  const [workshop, setWorkshop] = useState(plan?.workshop ?? "");
  const [estCost, setEstCost] = useState(plan?.estCostCenti != null ? (plan.estCostCenti / 100).toFixed(2) : "");
  const [active, setActive] = useState(plan?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const num = (v: string): number | null => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  // The route refuses a plan with neither interval — nothing could make it due.
  const ok = component !== "" && (num(intervalKm) !== null || num(intervalMonths) !== null);

  const save = async () => {
    if (busy || !ok) return;
    setBusy(true); setErr(null);
    try {
      const rm = estCost.trim() === "" ? null : Number(estCost);
      await api.post(`/api/fleet-maintenance/vehicles/${vehicleId}/plans`, {
        component,
        intervalKm: num(intervalKm),
        intervalMonths: num(intervalMonths),
        lastDoneKm: num(lastDoneKm),
        lastDoneDate: lastDoneDate || null,
        workshop: workshop.trim() || null,
        estCostCenti: rm != null && Number.isFinite(rm) ? Math.round(rm * 100) : null,
        active,
      });
      onSaved();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className={FIELD_LABEL}>Component</label>
          <select className={FIELD_CLS} value={component} disabled={!!plan} onChange={(e) => setComponent(e.target.value)}>
            {(plan ? components.filter((c) => c.value === plan.component) : free).map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          {!plan && free.length === 0 && (
            <p className="mt-1 text-[10.5px] text-ink-muted">Every component already has a plan on this lorry. Edit one instead.</p>
          )}
        </div>
        <div>
          <label className={FIELD_LABEL}>Every … km</label>
          <input className={FIELD_CLS} inputMode="numeric" value={intervalKm} onChange={(e) => setIntervalKm(e.target.value)} placeholder="10000" />
        </div>
        <div>
          <label className={FIELD_LABEL}>Every … months</label>
          <input className={FIELD_CLS} inputMode="numeric" value={intervalMonths} onChange={(e) => setIntervalMonths(e.target.value)} placeholder="6" />
        </div>
        <div>
          <label className={FIELD_LABEL}>Last done at (km)</label>
          <input className={FIELD_CLS} inputMode="numeric" value={lastDoneKm} onChange={(e) => setLastDoneKm(e.target.value)} />
        </div>
        <div>
          <label className={FIELD_LABEL}>Last done on</label>
          <DateField fullWidth className={FIELD_CLS} value={lastDoneDate} onChange={(iso) => setLastDoneDate(iso)}/>
        </div>
        <div>
          <label className={FIELD_LABEL}>Workshop</label>
          <input className={FIELD_CLS} value={workshop} onChange={(e) => setWorkshop(e.target.value)} placeholder="Optional" />
        </div>
        <div>
          <label className={FIELD_LABEL}>Estimated cost (RM)</label>
          <input className={FIELD_CLS} inputMode="decimal" value={estCost} onChange={(e) => setEstCost(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      <p className="mt-2 text-[10.5px] leading-snug text-ink-muted">
        Give at least one interval. With both, the plan falls due on whichever comes first. Leave
        &ldquo;last done&rdquo; blank and it reads as never done.
      </p>

      <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[12px] text-ink">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
      </label>

      {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy || !ok}>{busy ? "Saving…" : plan ? "Save plan" : "Add plan"}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
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

function PlanRow({ p, currentKm, onEdit }: { p: PlanView; currentKm: number | null; onEdit?: () => void }) {
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
        <span className="flex items-center gap-2">
          {onEdit && (
            <button type="button" onClick={onEdit} className="text-[10.5px] text-primary hover:underline">Edit</button>
          )}
          <Pill tone={p.tone}>{p.overdue ? "Overdue" : p.dueSoon ? "Due soon" : "OK"}</Pill>
        </span>
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
export function MileageSection({ readings, vehicleId, onChanged }: {
  readings: MileageView[];
  /* Optional so a read-only caller still renders. Given both, a reading can be
     taken here — owner, 2026-08-03: "这部分应该用来记录每周的里程。比如我们每一次
     检测的记录：在什么时间、当时的里程数是多少". The route has always accepted a
     MANUAL reading; only the form was missing, so the odometer could be captured
     from the driver's phone and nowhere else. */
  vehicleId?: string;
  onChanged?: () => void;
}) {
  const canWrite = !!vehicleId && !!onChanged;
  const [adding, setAdding] = useState(false);
  const [km, setKm] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const latest = readings.find((r) => r.odometerKm != null)?.odometerKm ?? null;

  const save = async () => {
    const n = Number(km);
    if (busy || !Number.isFinite(n)) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/fleet-maintenance/vehicles/${vehicleId}/mileage`, {
        odometerKm: Math.round(n), readingDate: date, source: "MANUAL", note: note.trim() || undefined,
      });
      setAdding(false); setKm(""); setNote(""); onChanged?.();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {readings.length === 0 && !adding && (
        <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">
          No mileage readings yet. The driver captures the odometer on day-complete from the mobile app, and you can
          record a weekly check here.
        </p>
      )}

      {readings.length > 0 && (
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
      )}

      {canWrite && adding && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FIELD_LABEL}>Odometer (km)</label>
              <input className={FIELD_CLS} inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value)} placeholder={latest != null ? String(latest) : "e.g. 154300"} />
            </div>
            <div>
              <label className={FIELD_LABEL}>Read on</label>
              <DateField fullWidth className={FIELD_CLS} value={date} onChange={(iso) => setDate(iso)}/>
            </div>
            <div className="col-span-2">
              <label className={FIELD_LABEL}>Note</label>
              <input className={FIELD_CLS} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional — e.g. weekly check" />
            </div>
          </div>
          {/* Two rules the route enforces, stated before you hit them: a reading
              below the last one is a rollback and is REFUSED, and an abnormal
              jump saves but is flagged for a human. */}
          <p className="mt-2 text-[10.5px] leading-snug text-ink-muted">
            {latest != null ? `The last reading was ${latest.toLocaleString()} km. ` : ""}
            An odometer cannot go backwards, so a lower number is refused. A very large jump saves but is flagged for review.
          </p>
          {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={save} disabled={busy || km.trim() === ""}>{busy ? "Saving…" : "Record reading"}</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      {canWrite && !adding && (
        <Button variant="secondary" onClick={() => setAdding(true)}>Record a reading</Button>
      )}
    </div>
  );
}

// ── Phase 3 drawer sections ──────────────────────────────────────────────────

export const FIELD_CLS = "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink focus:border-primary focus:outline-none";
export const FIELD_LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

export function apiErrText(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  const known: Record<string, string> = {
    illegal_transition: "That step is not allowed from the current state.",
    position_occupied: "Another active component already occupies that position.",
    vehicle_not_found: "Vehicle not found.",
  };
  for (const [k, msg] of Object.entries(known)) if (m.includes(k)) return msg;
  return "Could not save. Please try again.";
}

/** One record, closed to a single line and opened on demand.
 *
 *  Owner, 2026-08-03: "这个卡片或区域应该设计成可以展开和收起... 展开后能看到具体
 *  信息" and "要确保当资料密密麻麻、数据量很大的时候，界面依然清晰". A lorry with
 *  nineteen billed lines and four incidents was rendering every field of every
 *  record at once; the page could only get worse as the fleet aged.
 *
 *  CLOSED SHOWS WHAT YOU SCAN FOR: the number, how bad, what it was, when. The
 *  detail is one click away, never a scroll away. */
export function RecordCard({ code, badge, title, when, subtitle, tone, defaultOpen = false, children }: {
  code?: string | null;
  badge?: React.ReactNode;
  title: string;
  when?: string | null;
  subtitle?: string | null;
  tone?: "crit" | "plain";
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("rounded-lg border", tone === "crit" ? "border-err/30 bg-err/5" : "border-border bg-surface-2/40")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <ChevronRight size={14} className={cn("shrink-0 text-ink-muted transition-transform", open && "rotate-90")} />
        {code && (
          <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] font-semibold tracking-wide text-ink-secondary">
            {code}
          </span>
        )}
        {badge}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-ink">{title}</span>
          {subtitle && <span className="block truncate text-[10.5px] text-ink-muted">{subtitle}</span>}
        </span>
        {when && <span className="shrink-0 text-[10.5px] text-ink-muted">{when}</span>}
      </button>
      {open && <div className="border-t border-border/60 px-3 pb-3 pt-2.5">{children}</div>}
    </div>
  );
}

/** One label + value inside an opened record. A grid of these reads far faster
 *  than the run-on "a · b · c · d" line it replaces. */
/** One field inside an inline edit form. The forms own their own state, so a
 *  half-typed edit is never sent and Cancel really does discard. */
export function EditField({ label, span, children }: { label: string; span?: boolean; children: React.ReactNode }) {
  return (
    <div className={span ? "col-span-2" : undefined}>
      <label className={FIELD_LABEL}>{label}</label>
      {children}
    </div>
  );
}

export function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

const SEVERITY_TONE: Record<BreakdownView["severity"], Tone> = { MINOR: "info", MAJOR: "warn", CRITICAL: "crit" };
const BREAKDOWN_STATUS_LABEL: Record<BreakdownView["status"], string> = { OPEN: "Open", TOWING: "Towing", IN_WORKSHOP: "In workshop", RESOLVED: "Resolved" };

/** Breakdown & incident cases — report a new one, advance status / resolve. */
export function BreakdownSection({ vehicleId, breakdowns, onChanged }: { vehicleId: string; breakdowns: BreakdownView[]; onChanged: () => void }) {
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
        <RecordCard
          key={b.id}
          code={b.caseNo}
          tone={b.grounding ? "crit" : "plain"}
          badge={<Pill tone={SEVERITY_TONE[b.severity]}>{b.severity}</Pill>}
          title={b.faultType || "Incident"}
          subtitle={[BREAKDOWN_STATUS_LABEL[b.status], b.stillDrivable ? "still drivable" : "not drivable",
            b.downtimeHours != null ? `downtime ${fmtDowntime(b.downtimeHours)}` : null].filter(Boolean).join(" · ")}
          when={fmtDateTime(b.occurredAt)}
          /* An unresolved case is the one you opened the page for. */
          defaultOpen={b.status !== "RESOLVED"}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
            <Detail label="Occurred" value={fmtDateTime(b.occurredAt)} />
            <Detail label="Recovered" value={b.recoveryTime ? fmtDateTime(b.recoveryTime) : "still down"} />
            <Detail label="Downtime" value={b.downtimeHours != null ? fmtDowntime(b.downtimeHours) : "—"} />
            <Detail label="Towing" value={b.towingCompany ?? "—"} />
            <Detail label="Workshop" value={b.workshop ?? "—"} />
            <Detail label="GPS" value={b.gpsLat != null && b.gpsLng != null ? `${b.gpsLat.toFixed(4)}, ${b.gpsLng.toFixed(4)}` : "—"} />
          </dl>
          {b.driverDescription && (
            <p className="mt-2 rounded-md bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary">{b.driverDescription}</p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-[10.5px] uppercase tracking-brand text-ink-muted">Status</span>
            {b.status === "RESOLVED" ? (
              <span className="text-[11px] text-ink">Resolved</span>
            ) : (
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
            {/* Owner, 2026-08-03: "这些数据我要怎么去编辑呢? 所有的内容都是可以
                编辑并保存的吗?". PATCH /breakdowns/:id has accepted every one of
                these fields since Phase 3; only the status dropdown was wired,
                so a typo in the fault was permanent. */}
            <BreakdownEdit b={b} onChanged={onChanged} />
          </div>
        </RecordCard>
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
export function WorkOrdersSection({ vehicleId, plate, workOrders, breakdowns = [], onChanged }: { vehicleId: string; plate: string | null; workOrders: WorkOrderView[]; breakdowns?: BreakdownView[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  /* Importing a document is the OTHER way to open a work order, not a mode of
     the manual form — the two share nothing but the outcome. */
  const [importing, setImporting] = useState(false);
  const [problem, setProblem] = useState("");
  const [workshop, setWorkshop] = useState("");
  /* The case this repair came FROM. lorry_work_orders.breakdown_case_id has
     existed since mig 0204 and the create route has always accepted it — no UI
     ever wrote it, so every repair and the breakdown that caused it were two
     unrelated rows. Owner: "它不是应该跟我们的 breakdown 还有 incident 有串联吗?" */
  const [caseId, setCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Only cases still open are offered. Attaching a repair to a case that was
  // resolved weeks ago is almost always a mis-click, not a late link.
  const openCases = breakdowns.filter((b) => b.status !== "RESOLVED");

  const create = async () => {
    if (busy || !problem.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/fleet-maintenance/vehicles/${vehicleId}/work-orders`, {
        problem: problem.trim(),
        workshop: workshop.trim() || undefined,
        breakdownCaseId: caseId || undefined,
      });
      setAdding(false); setProblem(""); setWorkshop(""); setCaseId(""); onChanged();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {workOrders.length === 0 && !adding && (
        <p className="rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-[11.5px] text-ink-muted">No work orders on this lorry.</p>
      )}
      {workOrders.map((wo) => (
        <WorkOrderCard key={wo.id} wo={wo} cause={breakdowns.find((b) => b.id === wo.breakdownCaseId)} onChanged={onChanged} />
      ))}
      {importing && (
        <RepairDocumentImport
          vehicleId={vehicleId}
          plate={plate}
          onCancel={() => setImporting(false)}
          onDone={() => { setImporting(false); onChanged(); }}
        />
      )}
      {adding ? (
        <div className="rounded-lg border border-border bg-surface p-3">
          <label className={FIELD_LABEL}>Problem</label>
          <input className={FIELD_CLS} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="What needs fixing" />
          <label className={cn(FIELD_LABEL, "mt-2")}>Workshop</label>
          <input className={FIELD_CLS} value={workshop} onChange={(e) => setWorkshop(e.target.value)} placeholder="Optional" />
          <label className={cn(FIELD_LABEL, "mt-2")}>Caused by</label>
          {openCases.length === 0 ? (
            <p className="text-[11px] text-ink-muted">No open breakdown case on this lorry — this is scheduled or ad-hoc work.</p>
          ) : (
            <>
              <select className={FIELD_CLS} value={caseId} onChange={(e) => setCaseId(e.target.value)}>
                <option value="">Not from a breakdown</option>
                {openCases.map((b) => (
                  <option key={b.id} value={b.id}>
                    {[b.severity, b.faultType || b.driverDescription, b.occurredAt ? fmtDate(b.occurredAt) : null].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[10.5px] text-ink-muted">Link the repair to the case that caused it, so the downtime and the spend belong to the same incident.</p>
            </>
          )}
          {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={create} disabled={busy || !problem.trim()}>{busy ? "Saving…" : "Open work order"}</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setErr(null); }}>Cancel</Button>
          </div>
        </div>
      ) : !importing && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setAdding(true)}>New work order</Button>
          {/* Scan it or type it — the same editor either way, so the fields mig
              0241 added (workshop, document number, advisor, per-line UOM and
              discount) are reachable without an OCR-able document. */}
          <Button variant="secondary" onClick={() => setImporting(true)}>
            <FileUp size={14} /> Workshop quotation or invoice
          </Button>
        </div>
      )}
    </div>
  );
}

/** Edit the facts of a breakdown case. Every field here is one the PATCH route
 *  has always accepted; the screen only ever wired the status dropdown. */
function BreakdownEdit({ b, onChanged }: { b: BreakdownView; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [faultType, setFaultType] = useState(b.faultType ?? "");
  const [severity, setSeverity] = useState(b.severity);
  const [stillDrivable, setStillDrivable] = useState(b.stillDrivable);
  const [description, setDescription] = useState(b.driverDescription ?? "");
  const [towingCompany, setTowingCompany] = useState(b.towingCompany ?? "");
  const [towingCost, setTowingCost] = useState(b.towingCostCenti != null ? (b.towingCostCenti / 100).toFixed(2) : "");
  const [workshop, setWorkshop] = useState(b.workshop ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const cost = towingCost.trim() === "" ? null : Number(towingCost);
      await api.patch(`/api/fleet-maintenance/breakdowns/${b.id}`, {
        faultType: faultType.trim() || null,
        severity,
        stillDrivable,
        driverDescription: description.trim() || null,
        towingCompany: towingCompany.trim() || null,
        towingCostCenti: cost != null && Number.isFinite(cost) ? Math.round(cost * 100) : null,
        workshop: workshop.trim() || null,
      });
      setOpen(false); onChanged();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="text-[10.5px] font-semibold text-primary hover:underline">Edit</button>;
  }
  return (
    <div className="mt-2 w-full rounded-lg border border-border bg-surface p-3">
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Fault" span>
          <input className={FIELD_CLS} value={faultType} onChange={(e) => setFaultType(e.target.value)} placeholder="e.g. Tyre burst, engine overheat" />
        </EditField>
        <EditField label="Severity">
          <select className={FIELD_CLS} value={severity} onChange={(e) => setSeverity(e.target.value as BreakdownView["severity"])}>
            <option value="MINOR">Minor</option>
            <option value="MAJOR">Major</option>
            <option value="CRITICAL">Critical (grounds lorry)</option>
          </select>
        </EditField>
        <div className="flex items-end pb-1.5">
          <label className="flex items-center gap-2 text-[11.5px] text-ink-secondary">
            <input type="checkbox" checked={stillDrivable} onChange={(e) => setStillDrivable(e.target.checked)} />
            Still drivable
          </label>
        </div>
        <EditField label="Towing company">
          <input className={FIELD_CLS} value={towingCompany} onChange={(e) => setTowingCompany(e.target.value)} />
        </EditField>
        <EditField label="Towing cost (RM)">
          <input className={FIELD_CLS} inputMode="decimal" value={towingCost} onChange={(e) => setTowingCost(e.target.value)} />
        </EditField>
        <EditField label="Workshop" span>
          <input className={FIELD_CLS} value={workshop} onChange={(e) => setWorkshop(e.target.value)} />
        </EditField>
        <EditField label="What the driver reported" span>
          <input className={FIELD_CLS} value={description} onChange={(e) => setDescription(e.target.value)} />
        </EditField>
      </div>
      {/* Severity is not cosmetic: CRITICAL + unresolved is what grounds the
          lorry, so changing it here can put a lorry back on the road. */}
      <p className="mt-2 text-[10.5px] text-ink-muted">
        A CRITICAL case that is not resolved grounds the lorry, so severity changes what dispatch can use.
      </p>
      {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="secondary" onClick={() => { setOpen(false); setErr(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

/** Edit a work order's HEADER — everything except its state and its lines.
 *
 *  The four money legs sit beside the lines and are added to them, so labour
 *  typed here is labour that does NOT ride a line. The route refuses a non-zero
 *  header labour on a work order whose lines already carry LABOUR, which is the
 *  invariant that stops the same cost being counted twice. */
function WorkOrderEdit({ wo, onSaved, onCancel }: { wo: WorkOrderView; onSaved: () => void; onCancel: () => void }) {
  const [problem, setProblem] = useState(wo.problem ?? "");
  const [diagnosis, setDiagnosis] = useState(wo.diagnosis ?? "");
  const [workshop, setWorkshop] = useState(wo.workshop ?? "");
  const [quotationNo, setQuotationNo] = useState(wo.quotationNo ?? "");
  const [invoiceNo, setInvoiceNo] = useState(wo.invoiceNo ?? "");
  const rm = (c: number | null | undefined) => (c == null || c === 0 ? "" : (c / 100).toFixed(2));
  const [labour, setLabour] = useState(rm(wo.labourCenti));
  const [outside, setOutside] = useState(rm(wo.outsideServiceCenti));
  const [towing, setTowing] = useState(rm(wo.towingCenti));
  const [tax, setTax] = useState(rm(wo.taxCenti));
  const [warranty, setWarranty] = useState(wo.warrantyUntil ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const centi = (v: string): number => {
    const n = Number(v.trim());
    return v.trim() === "" || !Number.isFinite(n) ? 0 : Math.round(n * 100);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/fleet-maintenance/work-orders/${wo.id}`, {
        problem: problem.trim() || null,
        diagnosis: diagnosis.trim() || null,
        workshop: workshop.trim() || null,
        quotationNo: quotationNo.trim() || null,
        invoiceNo: invoiceNo.trim() || null,
        labourCenti: centi(labour),
        outsideServiceCenti: centi(outside),
        towingCenti: centi(towing),
        taxCenti: centi(tax),
        warrantyUntil: warranty || null,
      });
      onSaved();
    } catch (e) { setErr(apiErrText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 rounded-lg border border-border bg-surface p-3">
      <div className="grid grid-cols-2 gap-3">
        <EditField label="What was done" span>
          <input className={FIELD_CLS} value={problem} onChange={(e) => setProblem(e.target.value)} />
        </EditField>
        <EditField label="Diagnosis" span>
          <input className={FIELD_CLS} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
        </EditField>
        <EditField label="Workshop">
          <input className={FIELD_CLS} value={workshop} onChange={(e) => setWorkshop(e.target.value)} />
        </EditField>
        <EditField label="Warranty until">
          <DateField fullWidth className={FIELD_CLS} value={warranty} onChange={(iso) => setWarranty(iso)}/>
        </EditField>
        <EditField label="Their quotation no">
          <input className={FIELD_CLS} value={quotationNo} onChange={(e) => setQuotationNo(e.target.value)} placeholder="e.g. WJO00403" />
        </EditField>
        <EditField label="Their invoice no">
          <input className={FIELD_CLS} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        </EditField>
        <EditField label="Labour (RM)">
          <input className={FIELD_CLS} inputMode="decimal" value={labour} onChange={(e) => setLabour(e.target.value)} />
        </EditField>
        <EditField label="Outside service (RM)">
          <input className={FIELD_CLS} inputMode="decimal" value={outside} onChange={(e) => setOutside(e.target.value)} />
        </EditField>
        <EditField label="Towing (RM)">
          <input className={FIELD_CLS} inputMode="decimal" value={towing} onChange={(e) => setTowing(e.target.value)} />
        </EditField>
        <EditField label="Tax (RM)">
          <input className={FIELD_CLS} inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
        </EditField>
      </div>
      <p className="mt-2 text-[10.5px] leading-snug text-ink-muted">
        These four amounts are added ON TOP of the lines above. If the workshop&rsquo;s labour is already a line, leave
        Labour at zero — the route refuses the double count rather than silently inflating the total.
      </p>
      {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const WO_TONE: Record<WorkOrderState, Tone> = {
  REPORTED: "info", DIAGNOSED: "info", QUOTED: "warn", APPROVED: "info", IN_REPAIR: "warn", WAITING_PARTS: "warn", COMPLETED: "ok", VERIFIED: "ok",
};

function WorkOrderCard({ wo, cause, onChanged }: { wo: WorkOrderView; cause?: BreakdownView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
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

  /* Closed, a work order has to answer: which one, how far along, what it was
     for, whose incident, and how much. Owner, 2026-08-03: "工单页面需要清晰指示
     它对应的是哪一个 Breakdown 编号，以及具体维修了什么东西". */
  const partCount = wo.parts?.length ?? 0;
  return (
    <RecordCard
      code={wo.woNo}
      badge={<Pill tone={WO_TONE[wo.status]}>{wo.statusLabel}</Pill>}
      title={wo.problem || "Work order"}
      subtitle={[
        cause ? `from ${cause.caseNo ?? "breakdown"}: ${cause.faultType || cause.driverDescription || "incident"}` : null,
        partCount ? `${partCount} line${partCount === 1 ? "" : "s"}` : null,
        wo.totalCenti ? money(wo.totalCenti) : null,
        wo.quotationNo ? `their ref ${wo.quotationNo}` : wo.invoiceNo ? `their invoice ${wo.invoiceNo}` : null,
      ].filter(Boolean).join(" · ")}
      when={wo.reportedAt ? fmtDateTime(wo.reportedAt) : null}
      defaultOpen={wo.open}
    >
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
          <span className="flex items-center gap-3">
            <button type="button" onClick={() => setAddingPart(true)} className="text-[10.5px] font-semibold text-primary hover:underline">+ Add part</button>
            {/* PATCH /work-orders/:id has always accepted the whole header —
                problem, diagnosis, workshop, their document numbers, advisor,
                and the four money legs. Nothing on screen sent any of it. */}
            <button type="button" onClick={() => setEditing((v) => !v)} className="text-[10.5px] font-semibold text-primary hover:underline">
              {editing ? "Close" : "Edit details"}
            </button>
          </span>
          <span className="text-[12px] font-semibold text-ink">Total {money(wo.totalCenti)}</span>
        </div>
      )}
      {editing && <WorkOrderEdit wo={wo} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />}
    </RecordCard>
  );
}

/** Tyre & component lifecycle — serial cards with derived km/cost, fit + remove +
 *  event logging. */
export function ComponentsSection({ vehicleId, currentKm, components, onChanged }: { vehicleId: string; currentKm: number | null; components: ComponentView[]; onChanged: () => void }) {
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
            <div className="col-span-2"><label className={FIELD_LABEL}>Warranty until</label><DateField fullWidth className={FIELD_CLS} value={warranty} onChange={(iso) => setWarranty(iso)} /></div>
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
    <RecordCard
      code={c.serial ? `SN ${c.serial}` : null}
      badge={c.underWarranty != null ? <Pill tone={c.underWarranty ? "ok" : "neutral"}>{c.underWarranty ? "Warranty" : "Expired"}</Pill> : undefined}
      title={[c.componentTypeLabel, c.position !== "NA" ? c.positionLabel : null].filter(Boolean).join(" · ")}
      subtitle={[
        [c.brand, c.model, c.size].filter(Boolean).join(" ") || null,
        c.kmUsed != null ? `${c.kmUsed.toLocaleString()} km used` : null,
        c.costPerKmCenti != null ? `${money(c.costPerKmCenti)}/km` : null,
        c.status === "ACTIVE" ? null : "removed",
      ].filter(Boolean).join(" · ")}
      when={c.fittedDate}
      /* A fitted component is the live one; a removed one is history. */
      defaultOpen={c.status === "ACTIVE"}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3">
        <Detail label="Fitted" value={c.fittedDate ? `${fmtDate(c.fittedDate)}${c.fittedKm != null ? ` @ ${c.fittedKm.toLocaleString()} km` : ""}` : "—"} />
        <Detail label="Removed" value={c.removedDate ? `${fmtDate(c.removedDate)}${c.removedKm != null ? ` @ ${c.removedKm.toLocaleString()} km` : ""}` : "still fitted"} />
        <Detail label="Km used" value={c.kmUsed != null ? c.kmUsed.toLocaleString() : "—"} />
        <Detail label="Cost / km" value={c.costPerKmCenti != null ? money(c.costPerKmCenti) : "—"} />
        <Detail label="Tread" value={c.treadDepth != null ? `${c.treadDepth} mm` : "—"} />
        <Detail label="Serial" value={c.serial ?? "—"} />
      </dl>
      {c.events.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">History</div>
          <div className="space-y-0.5">
            {c.events.slice(0, 5).map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-[10.5px] text-ink-muted">
                <span className="uppercase tracking-brand">{e.eventType}</span>
                <span>{e.eventDate}</span>
                {e.odometerKm != null && <span className="tabular-nums">{e.odometerKm.toLocaleString()} km</span>}
                {e.toPosition && <span>&rarr; {e.toPosition}</span>}
                {e.note && <span className="text-ink-secondary">{e.note}</span>}
              </div>
            ))}
          </div>
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
    </RecordCard>
  );
}

/* ── Compliance attachments (mig 0238) ──────────────────────────────────────
   The vault used to store a reference NUMBER and nothing else, and the drawer
   had no way to add anything - owner, 2026-08-01: "为什么我的 Compliance、Road Tax
   这些都是不能 Upload 的呢？". These two components are the missing half: a real
   renewal form, and the scans hanging off each renewal. */

const ATTACH_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic";

export function AttachmentStrip({ docId, files, onChanged }: {
  docId: string | null;
  files: ComplianceFile[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!docId) return null;

  const open = async (f: ComplianceFile) => {
    try {
      const url = await api.fetchBlobUrl(`/api/fleet-maintenance/compliance-attachments/${f.r2Key}`);
      window.open(url, "_blank", "noopener");
    } catch { /* the drawer stays usable; the file simply does not open */ }
  };

  const remove = async (f: ComplianceFile) => {
    setBusy(true);
    try {
      await api.del(`/api/fleet-maintenance/compliance-attachments/${f.id}`);
      onChanged();
    } finally { setBusy(false); }
  };

  if (files.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[10.5px]">
          <button type="button" onClick={() => void open(f)} className="text-primary hover:underline">
            {f.fileName || "document"}
          </button>
          <button type="button" disabled={busy} onClick={() => void remove(f)}
            className="text-ink-muted hover:text-err" aria-label="Remove attachment">
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function AddRenewalForm({ lorryId, docType, onSaved }: {
  lorryId: string;
  docType: DocType;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [cost, setCost] = useState("");
  const [owner, setOwner] = useState("");
  const [result, setResult] = useState<"" | "PASS" | "FAIL">("");
  const [reinspect, setReinspect] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setIssueDate(""); setExpiryDate(""); setDocumentRef(""); setCost("");
    setOwner(""); setResult(""); setReinspect(""); setFiles([]); setErr(null);
  };

  const save = async () => {
    if (!expiryDate) { setErr("An expiry date is what the reminders count down to - it is required."); return; }
    setBusy(true);
    setErr(null);
    try {
      /* Renewing APPENDS a row; the prior one survives as history (mig 0202). */
      const created = await api.post<{ id: string }>(
        `/api/fleet-maintenance/vehicles/${lorryId}/compliance`,
        {
          docType,
          issueDate: issueDate || null,
          expiryDate,
          documentRef: documentRef || null,
          costCenti: cost.trim() === "" ? null : Math.round(Number(cost) * 100),
          owner: owner || null,
          ...(docType === "PUSPAKOM" ? { result: result || null, reinspectionDeadline: reinspect || null } : {}),
        },
      );
      /* Files go up one at a time against the row that now exists. A failed
         upload leaves the renewal itself recorded - losing the dates because a
         scan failed would be the worse outcome. */
      for (const f of files) {
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        const qs = `?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(f.name)}`;
        await api.putBinary(
          `/api/fleet-maintenance/vehicles/${lorryId}/compliance/${created.id}/attachments${qs}`,
          f, f.type || "application/octet-stream",
        );
      }
      reset();
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the renewal.");
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary">
        Add renewal
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-surface p-2.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RenewalField label="Issue date"><DateField fullWidth value={issueDate} onChange={(iso) => setIssueDate(iso)} className={RENEWAL_FIELD_CLS}/></RenewalField>
        <RenewalField label="Expiry date *"><DateField fullWidth value={expiryDate} onChange={(iso) => setExpiryDate(iso)} className={RENEWAL_FIELD_CLS} /></RenewalField>
        <RenewalField label="Document no"><input type="text" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} className={RENEWAL_FIELD_CLS} /></RenewalField>
        <RenewalField label="Cost (RM)"><input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} className={RENEWAL_FIELD_CLS} /></RenewalField>
        <RenewalField label="Owner"><input type="text" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who renews it" className={RENEWAL_FIELD_CLS} /></RenewalField>
        {docType === "PUSPAKOM" && (
          <>
            <RenewalField label="Result">
              <select value={result} onChange={(e) => setResult(e.target.value as "" | "PASS" | "FAIL")} className={RENEWAL_FIELD_CLS}>
                <option value="">—</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option>
              </select>
            </RenewalField>
            {result === "FAIL" && (
              <RenewalField label="Reinspect by"><DateField fullWidth value={reinspect} onChange={(iso) => setReinspect(iso)} className={RENEWAL_FIELD_CLS} /></RenewalField>
            )}
          </>
        )}
      </div>

      <RenewalField label="Scans (PDF or image, max 15MB each)">
        <input type="file" multiple accept={ATTACH_ACCEPT}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="block w-full text-[11.5px] text-ink-secondary file:mr-2 file:rounded file:border file:border-border file:bg-surface-2 file:px-2 file:py-1 file:text-[11px]" />
      </RenewalField>
      {files.length > 0 && (
        <div className="text-[10.5px] text-ink-muted">{files.length} file(s) will be attached to this renewal.</div>
      )}

      {err && <div className="text-[11px] text-err">{err}</div>}

      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save renewal"}</Button>
        <Button variant="secondary" onClick={() => { reset(); setOpen(false); }} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

const RENEWAL_FIELD_CLS = "h-8 w-full rounded border border-border bg-surface px-2 text-[12px] text-ink focus:border-primary focus:outline-none";

function RenewalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

/* The box (mig 0209) as one label: dimensions when they are on file, otherwise
   the hand-entered capacity, otherwise nothing rather than "null m3". */
export function boxLabel(v: { lengthFt?: number | null; widthFt?: number | null; heightFt?: number | null; capacityM3?: number | null }): string | null {
  if (v.lengthFt && v.widthFt && v.heightFt) {
    const m3 = v.capacityM3 != null ? ` (${v.capacityM3} m3)` : "";
    return `${v.lengthFt} x ${v.widthFt} x ${v.heightFt} ft${m3}`;
  }
  return v.capacityM3 != null ? `${v.capacityM3} m3` : null;
}

/* Owner, 2026-08-01: an IN-HOUSE lorry must carry its road tax and the rest.
   This states the gap instead of enforcing it - a hard requirement would block
   editing the very rows that are incomplete, and the fleet has plenty of those
   today. An outsourced lorry is the carrier's paperwork, so it is not counted. */
const REQUIRED_FOR_INHOUSE: DocType[] = ["ROAD_TAX", "INSURANCE", "PUSPAKOM"];

export function MissingComplianceNote({ vehicle, compliance }: {
  vehicle: { isInternal?: boolean };
  compliance?: Record<DocType, { currentId: string | null; flatExpiry: string | null; history: DocView[] }>;
}) {
  if (vehicle.isInternal === false || !compliance) return null;
  const missing = REQUIRED_FOR_INHOUSE.filter((t) => {
    const g = compliance[t];
    return !g || (g.history.length === 0 && !g.flatExpiry);
  });
  if (missing.length === 0) return null;
  return (
    <div className="mt-2 rounded-md border border-warning-text/30 bg-warning-text/10 px-2.5 py-1.5 text-[11.5px] text-warning-text">
      In-house lorry with nothing on file for {missing.map((t) => DOC_LABEL[t]).join(", ")}. Add a renewal below.
    </div>
  );
}
