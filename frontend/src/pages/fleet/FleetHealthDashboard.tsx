// Fleet Health, the dashboard (route /fleet-health), in the approved design of
// 2026-11-07: summary tiles, three charts, the compliance reminders, then every
// in-house lorry with a side view drawn to its own box size.
//
// All derived state (status, reminder levels, KPIs) comes from the backend
// (services/fleet-status.ts); this page only renders it. Moved out of
// FleetHealth.tsx, which sits at its size ceiling; the record sections stay there.
import { useMemo, useState, useRef, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { FleetHealthCharts } from "../FleetHealthCharts";
import { NewInHouseLorry } from "./NewInHouseLorry";
import { LorrySide } from "../scm-v2/fleet/Lorry3D";
import { LorryLiveMap } from "../scm-v2/LorryLiveMap";
import { lorryBox } from "./fleetHealthModel";
import { CARD, KpiTile, PlateBadge, Segmented, TONE_DOT } from "./FleetUi";
import {
  DOC_LABEL, DOC_TYPES, STATUS_TONE, Pill, VehicleDrawer, NextServiceCell, fmtDays, fmtDowntime, money, openProblem, statusLabel,
  type DashboardPayload, type DocView, type VehicleRow, type VehicleStatus,
} from "../FleetHealth";

/** A compact expiry cell: the date + a days-remaining sub-line in its tone. */
function ExpiryCell({ doc }: { doc: DocView | undefined }) {
  if (!doc) return <span className="text-[12px] text-ink-muted">Not on file</span>;
  const toneText = doc.tone === "crit" ? "text-err" : doc.tone === "warn" ? "text-warning-text" : "text-ink-muted";
  return (
    <div className="text-[12.5px]">
      <div className="text-ink">{fmtDate(doc.expiryDate)}</div>
      <div className={cn("text-[11px] font-medium", toneText)}>
        {doc.result === "FAIL" ? "FAILED · " : ""}
        {fmtDays(doc.daysRemaining)}
      </div>
    </div>
  );
}

const REMINDERS_SHOWN = 8;

export function FleetHealth() {
  const [params, setParams] = useSearchParams();
  const region = params.get("region") ?? "ALL";
  const statusFilter = params.get("status") ?? "ALL";
  /* Owner 2026-11-08: the Lorry Live Map moved here (and into Coverage & Fleet) from the sidebar. */
  const view = params.get("view") === "map" ? "map" : "health";
  const [openId, setOpenId] = useState<string | null>(null);
  const [allReminders, setAllReminders] = useState(false);
  const navigate = useNavigate();

  /* Sales Order's interaction, which the owner asked for by name: "单击：弹出一个
     shortcut，让我简单看一个简介; 双击：点进去看细节".

     A double click fires click, click, dblclick — so opening the drawer on the
     first click would flash it open and then navigate away underneath it. The
     peek is held for one double-click interval and cancelled if the second
     click lands. 250ms is under the platform default (500ms) on purpose. */
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
  const expiryValue = (d: VehicleRow["compliance"]["ROAD_TAX"]) => d?.expiryDate ?? null;
  const boardColumns: Column<VehicleRow>[] = [
    {
      key: "lorry", label: "Lorry", getValue: (v) => v.plate,
      render: (v) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="w-[72px] flex-none"><LorrySide box={lorryBox(v)} /></span>
          <span className="flex min-w-0 flex-col gap-0.5">
            {/* A REAL anchor, so Cmd/Ctrl-click and middle-click open the record in
                a new tab (owner 2026-08-03). stopPropagation so the plate does not
                ALSO fire the row's peek. */}
            <Link
              to={`/fleet-health/${v.id}`}
              onClick={(e) => { e.stopPropagation(); cancelPeek(); }}
              className="text-[14px] font-bold text-primary-ink underline decoration-primary/30 underline-offset-[3px] hover:text-primary"
            >
              {v.plate}
            </Link>
            <span className="truncate text-[12px] text-ink-muted">{[v.driverName ?? "No driver", v.region].filter(Boolean).join(" · ")}</span>
          </span>
        </span>
      ),
    },
    { key: "status", label: "Status", getValue: (v) => v.statusLabel, render: (v) => <Pill tone={STATUS_TONE[v.status]}>{v.statusLabel}</Pill> },
    {
      key: "mileage", label: "Mileage", align: "right", getValue: (v) => v.mileageKm, exportFormat: "number",
      render: (v) => (
        <span className="tabular-nums text-ink">
          {v.mileageKm != null ? v.mileageKm.toLocaleString() : "—"}
          <span className="ml-1 text-[11px] text-ink-muted">km</span>
          {v.mileageFlagged && <span className="block text-[11px] font-semibold text-warning-text" title="Abnormal jump, review">flagged</span>}
        </span>
      ),
    },
    { key: "nextService", label: "Next service", render: (v) => <NextServiceCell v={v} /> },
    { key: "puspakom", label: "PUSPAKOM", getValue: (v) => expiryValue(v.compliance.PUSPAKOM), exportFormat: "date", render: (v) => <ExpiryCell doc={v.compliance.PUSPAKOM} /> },
    { key: "insurance", label: "Insurance", getValue: (v) => expiryValue(v.compliance.INSURANCE), exportFormat: "date", render: (v) => <ExpiryCell doc={v.compliance.INSURANCE} /> },
    { key: "roadTax", label: "Road tax", getValue: (v) => expiryValue(v.compliance.ROAD_TAX), exportFormat: "date", render: (v) => <ExpiryCell doc={v.compliance.ROAD_TAX} /> },
    {
      key: "problem", label: "Open problem", getValue: (v) => openProblem(v) ?? "",
      render: (v) => (
        <span className="text-[12.5px] text-ink-secondary">
          {openProblem(v) ?? <span className="text-ink-muted">—</span>}
          {(v.openWorkOrders ?? 0) > 0 && <span className="ml-1.5 text-[11px] text-ink-muted">{v.openWorkOrders} WO</span>}
        </span>
      ),
    },
    {
      key: "downtime", label: "Downtime", align: "right", getValue: (v) => v.downtimeHours,
      render: (v) => (v.downtimeHours != null
        ? <span className="font-semibold tabular-nums text-err">{fmtDowntime(v.downtimeHours)}</span>
        : <span className="text-ink-muted">—</span>),
    },
  ];

  const [addingLorry, setAddingLorry] = useState(false);
  const dash = useQuery<DashboardPayload>("/api/fleet-maintenance/dashboard", () => api.get("/api/fleet-maintenance/dashboard"));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "ALL" || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const toggleStatus = (status: string) => setParam("status", statusFilter === status ? "ALL" : status);

  const all = dash.data?.vehicles ?? [];
  // Lorries that cannot go out (fleet-status canDispatch: only AVAILABLE / SERVICE_DUE can).
  const grounded = all.filter((v) => v.status !== "AVAILABLE" && v.status !== "SERVICE_DUE");
  const regionOptions = useMemo(() => {
    const present = [...new Set(all.map((v) => v.region).filter((r): r is string => !!r))].sort();
    return ["ALL", ...present].map((r) => ({ value: r, label: r === "ALL" ? "All" : r }));
  }, [all]);

  const visible = useMemo(
    () => all.filter((v) => (region === "ALL" || v.region === region) && (statusFilter === "ALL" || v.status === statusFilter)),
    [all, region, statusFilter],
  );

  // The reminders: every actionable current document, most-urgent first. Derived
  // from the same payload the KPIs use, so it can never disagree with the board.
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
  const shownReminders = allReminders ? reminders : reminders.slice(0, REMINDERS_SHOWN);

  const kpis = dash.data?.kpis;
  const statusCounts = dash.data?.statusCounts ?? {};
  const pending = dash.loading && !dash.data;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px] font-semibold uppercase tracking-[.08em] text-primary">Operations · Fleet</div>
          <h1 className="text-[22px] font-bold tracking-[-.01em] text-ink sm:text-[28px]">Fleet Health</h1>
          <p className="text-[13px] text-ink-muted">Which lorries can go out today, and what needs renewing or repairing.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => dash.reload()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[color:var(--hz-dk-warning-bg,#ebe7dd)] px-4 text-[14px] font-semibold text-ink hover:bg-[color:var(--hz-dk-warning-bg,#e0dbcf)]">
            <RefreshCw size={14} className={dash.loading ? "animate-spin" : undefined} /> Refresh
          </button>
          <button type="button" onClick={() => setAddingLorry(true)} className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[14px] font-semibold text-white hover:bg-primary/90">New lorry</button>
        </div>
      </header>
      {addingLorry && <NewInHouseLorry onClose={() => setAddingLorry(false)} onCreated={() => dash.reload()} />}

      <div>
        <Segmented label="View" value={view} options={[{ value: "health", label: "Health" }, { value: "map", label: "Live map" }]}
          onChange={(v) => setParam("view", v === "map" ? "map" : "ALL")} />
      </div>

      {view === "map" ? <LorryLiveMap embedded /> : <>

      {dash.error && dash.data && (
        <p role="alert" className="rounded-xl border border-err/30 bg-err-bg px-4 py-3 text-[13px] font-semibold text-err">Could not refresh the fleet: {dash.error}. Showing what was loaded before.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-semibold text-ink-secondary">Warehouse</span>
        <Segmented label="Warehouse" value={region} options={regionOptions} onChange={(r) => setParam("region", r)} />
        <span className="ml-auto text-[13px] text-ink-muted">{visible.length} {visible.length === 1 ? "lorry" : "lorries"}</span>
      </div>

      {/* Four tiles (owner, 2026-10-16: the eight small tiles read as clutter).
          The first names which lorry cannot go out and why. */}
      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Cannot dispatch"
          value={pending ? "…" : `${kpis?.cantDispatch ?? 0} of ${kpis?.fleetSize ?? 0}`}
          sub={grounded.length ? grounded.slice(0, 3).map((v) => `${v.plate} · ${v.statusLabel}`).join(", ") + (grounded.length > 3 ? ` +${grounded.length - 3}` : "") : "Every lorry can go out"}
          tone={kpis?.cantDispatch ? "crit" : "neutral"}
          onClick={() => toggleStatus("COMPLIANCE_BLOCKED")} active={statusFilter === "COMPLIANCE_BLOCKED"}
        />
        <KpiTile
          label="Documents"
          value={pending ? "…" : kpis?.expiredDocs ? `${kpis.expiredDocs} expired` : "None expired"}
          sub={`Due in 30 days ${kpis?.expiring30 ?? 0} · 60 days ${kpis?.expiring60 ?? 0} · 90 days ${kpis?.expiring90 ?? 0}`}
          tone={kpis?.expiredDocs ? "crit" : kpis?.expiring30 ? "warn" : "neutral"}
        />
        <KpiTile
          label="Breakdowns & service"
          value={pending ? "…" : `${kpis?.activeBreakdowns ?? 0} breakdown${kpis?.activeBreakdowns === 1 ? "" : "s"}`}
          sub={`${kpis?.openWorkOrders ?? 0} open work order${kpis?.openWorkOrders === 1 ? "" : "s"} · service due ${kpis?.serviceDue ?? 0}${kpis?.serviceOverdue ? ` (${kpis.serviceOverdue} overdue)` : ""}`}
          tone={kpis?.activeBreakdowns ? "crit" : kpis?.serviceOverdue ? "warn" : "neutral"}
          onClick={() => toggleStatus("BREAKDOWN")} active={statusFilter === "BREAKDOWN"}
        />
        <KpiTile
          label="Repairs this month"
          value={pending ? "…" : kpis?.repairSpendThisMonthSen != null ? money(kpis.repairSpendThisMonthSen) : "—"}
          sub={kpis?.costliestVehicle ? `Costliest ${kpis.costliestVehicle} ${money(kpis.costliestVehicleSen ?? 0)}` : "No repairs logged"}
        />
      </section>

      <FleetHealthCharts vehicles={all} kpis={kpis ?? null} onOpen={openRecord} />

      {reminders.length > 0 && (
        <section className={cn(CARD, "overflow-hidden")}>
          <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pb-2.5 pt-4">
            <h2 className="text-[15px] font-bold text-ink">Compliance reminders</h2>
            <span className="text-[12.5px] text-ink-muted">An expired document grounds the lorry</span>
          </div>
          {shownReminders.map(({ v, doc }) => (
            <button
              key={`${v.id}-${doc.docType}`}
              type="button"
              onClick={() => setOpenId(v.id)}
              className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-border/60 px-5 py-[11px] text-left text-[13.5px] text-ink hover:bg-surface-2 md:grid md:grid-cols-[104px_minmax(0,1fr)_minmax(90px,180px)_120px_150px]"
            >
              <span className="flex"><PlateBadge plate={v.plate} /></span>
              <span className="min-w-[160px] flex-1 font-semibold md:min-w-0">{DOC_LABEL[doc.docType]}</span>
              <span className="w-[110px] text-ink-muted md:w-auto">{v.region ?? "No warehouse"}</span>
              <span className="w-[110px] tabular-nums text-ink-muted md:w-auto">{doc.expiryDate ? fmtDate(doc.expiryDate) : "No expiry"}</span>
              <span className="md:justify-self-end"><Pill tone={doc.tone}>{doc.result === "FAIL" ? "FAILED" : fmtDays(doc.daysRemaining)}</Pill></span>
            </button>
          ))}
          {reminders.length > REMINDERS_SHOWN && (
            <button type="button" onClick={() => setAllReminders((s) => !s)} aria-expanded={allReminders}
              className="w-full border-t border-border/60 px-5 py-2.5 text-left text-[13px] font-semibold text-primary hover:bg-surface-2">
              {allReminders ? "Show fewer" : `Show all ${reminders.length}`}
            </button>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div role="group" aria-label="Status" className="flex flex-wrap gap-1.5">
          {[["ALL", all.length] as const, ...Object.entries(statusCounts).sort()].map(([status, count]) => {
            const on = statusFilter === status;
            const tone = status === "ALL" ? null : STATUS_TONE[status as VehicleStatus];
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                onClick={() => setParam("status", status)}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors",
                  on ? "border-primary bg-primary-soft font-semibold text-primary-ink" : "border-border bg-surface text-ink-secondary hover:border-primary/40",
                )}
              >
                {tone && <span className={cn("h-2.5 w-2.5 rounded-full", TONE_DOT[tone])} />}
                {status === "ALL" ? "All" : statusLabel(status)} <b className="tabular-nums">{count}</b>
              </button>
            );
          })}
        </div>
        {/* A failed load is not an empty fleet: say so instead of "No lorries". */}
        {dash.error && !dash.data ? (
          <div role="alert" className={cn(CARD, "flex flex-wrap items-center justify-between gap-3 border-err/30 px-5 py-6")}>
            <span className="text-[14px] font-semibold text-err">Could not load the fleet: {dash.error}</span>
            <button type="button" onClick={() => dash.reload()} className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[14px] font-semibold text-white">Try again</button>
          </div>
        ) : (
        <div className={cn(CARD, "overflow-hidden")}>
          <DataTable<VehicleRow>
            tableId="fleet-health-board"
            exportName="fleet-health"
            exportXlsx
            columns={boardColumns}
            rows={dash.loading && !dash.data ? null : visible}
            loading={dash.loading && !dash.data}
            emptyLabel="No lorries in this view. Add one with New lorry."
            getRowKey={(v) => v.id}
            onRowClick={(v) => peek(v.id)}
            onRowDoubleClick={(v) => openRecord(v.id)}
          />
        </div>
        )}
      </section>

      </>}

      <VehicleDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => dash.reload()} />
    </div>
  );
}

export default FleetHealth;
