
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, MapPinned, ExternalLink, GripVertical, AlertTriangle } from "lucide-react";
import { ResizableDrawer } from "../../../components/ResizableDrawer";
import { Button } from "../../../components/Button";
import { fmtDateOrDash } from "../../../../../shared/src/vendor/shared/format";
import { useDrivers } from "../lib/drivers-queries";
import { useLorries } from "../lib/lorries-queries";
import { useWarehouses } from "../lib/inventory-queries";
import { useDriverLeave } from "../lib/delivery-zones-queries";
import { findCrewLeave, crewLeaveLabel } from "../../shared/crew-leave";
import { useScheduleDelivery, type PlanningOrder } from "../lib/delivery-planning-queries";
import {
  useProposeSchedule,
  recomputeSequenceTimes,
  timeToMinutes,
  type ProposeScheduleResponse,
  type ProposeStop,
  type ProposedRoute,
} from "../lib/propose-schedule-queries";
import { ScheduleRouteMap, type RoutePoint } from "./ScheduleRouteMap";
import { useNotify } from "./NotifyDialog";
import { DateField } from "./DateField";
import { warehouseLabel } from "../lib/warehouse-label";

function effectiveDateOf(o: PlanningOrder): string {
  const iso = o.effective_delivery_date ?? o.amended_delivery_date ?? o.customer_delivery_date ?? "";
  return iso ? iso.slice(0, 10) : "";
}

type ApplyState = "WIRED" | "NOT_REQUESTED" | "FAILED";
type ApplyResult = { state: ApplyState; detail: string };

const RESULT_TONE: Record<ApplyState, string> = {
  WIRED: "bg-synced/10 text-synced border-synced/30",
  NOT_REQUESTED: "bg-surface-dim text-ink-muted border-border",
  FAILED: "bg-err/10 text-err border-err/40",
};
const RESULT_LABEL: Record<ApplyState, string> = {
  WIRED: "Wired",
  NOT_REQUESTED: "No trip",
  FAILED: "Failed",
};

const MAPS_BROWSER_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? "";

function fmtMins(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}
function fmtKm(metres: number): string {
  return `${(Math.max(0, metres) / 1000).toFixed(1)} km`;
}

export function ScheduleTripDrawer({
  orders,
  onClose,
  onOpenTrips,
}: {
  orders: PlanningOrder[];
  onClose: () => void;
  onOpenTrips: () => void;
}) {
  const notify = useNotify();
  const { data: drivers = [] } = useDrivers();
  const { data: lorries = [] } = useLorries();
  const { data: warehouses = [] } = useWarehouses();
  const sched = useScheduleDelivery();
  const propose = useProposeSchedule();

  const { data: crewLeave = [] } = useDriverLeave();
  const activeLorries = useMemo(() => lorries.filter((l) => l.active), [lorries]);
  const activeWarehouses = useMemo(() => warehouses.filter((w) => w.is_active), [warehouses]);

  const [dates, setDates] = useState<Record<string, string>>({});
  const [tripDate, setTripDate] = useState("");
  const [driverId, setDriverId] = useState("");
  const [lorryId, setLorryId] = useState("");

  const activeDrivers = useMemo(
    () => drivers.filter((d) => d.active).map((d) => ({
      ...d, leaveNote: crewLeaveLabel(findCrewLeave(crewLeave, 'driver', d.id, tripDate)),
    })),
    [drivers, crewLeave, tripDate],
  );
  const pickedDriverLeaveNote = useMemo(
    () => crewLeaveLabel(findCrewLeave(crewLeave, 'driver', driverId, tripDate)),
    [crewLeave, driverId, tripDate],
  );
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<Record<string, ApplyResult>>({});

  const [depotWarehouseId, setDepotWarehouseId] = useState("");
  const [departTime, setDepartTime] = useState("09:00");
  const [proposal, setProposal] = useState<ProposeScheduleResponse | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [route, setRoute] = useState<ProposedRoute | null>(null);
  const [dragRef, setDragRef] = useState<string | null>(null);

  useEffect(() => {
    if (!depotWarehouseId && activeWarehouses.length > 0) setDepotWarehouseId(activeWarehouses[0].id);
  }, [activeWarehouses, depotWarehouseId]);

  const regionLorries = useMemo(() => {
    if (!depotWarehouseId) return activeLorries;
    return activeLorries.filter((l) => {
      const wid = l.warehouse_id ?? l.warehouseId ?? null;
      return wid == null || wid === depotWarehouseId;
    });
  }, [activeLorries, depotWarehouseId]);
  useEffect(() => {
    if (lorryId && !regionLorries.some((l) => l.id === lorryId)) setLorryId("");
  }, [lorryId, regionLorries]);

  const stopByRef = useMemo(() => {
    const m = new Map<string, ProposeStop>();
    for (const s of proposal?.stops ?? []) m.set(s.ref, s);
    return m;
  }, [proposal]);

  const matrixIndexOf = useMemo(() => {
    const m = new Map<string, number>();
    (proposal?.stops ?? []).forEach((s, i) => m.set(s.ref, i + 1));
    return m;
  }, [proposal]);

  const departMin = timeToMinutes(proposal?.departTime ?? departTime) ?? 9 * 60;

  const proposeDates = () => {
    const next: Record<string, string> = {};
    for (const o of orders) next[o.so_doc_no] = effectiveDateOf(o);
    setDates(next);
  };

  const proposeTimes = async () => {
    try {
      const res = await propose.mutateAsync({
        soDocNos: orders.map((o) => o.so_doc_no),
        depotWarehouseId: depotWarehouseId || null,
        departTime,
      });
      setProposal(res);
      if (res.ok && res.proposed) {
        setOrder(res.proposed.sequence.map((s) => s.ref));
        setRoute(res.proposed);
      } else {
        setOrder([]);
        setRoute(null);
        notify({
          title: res.configured ? "Could not propose a route" : "Smart scheduling not configured",
          body: res.reason || "No route could be proposed.",
          tone: "error",
        });
      }
    } catch (e) {
      notify({ title: "Propose failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    }
  };

  const reorder = (fromRef: string, toRef: string) => {
    if (fromRef === toRef) return;
    const next = [...order];
    const from = next.indexOf(fromRef);
    const to = next.indexOf(toRef);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    setOrder(next);
    if (proposal) {
      setRoute(
        recomputeSequenceTimes(next, stopByRef, matrixIndexOf, proposal.travelSeconds, proposal.distanceMetres, departMin),
      );
    }
  };

  const setAllDates = (value: string) => {
    setTripDate(value);
    if (!value) return;
    const next: Record<string, string> = {};
    for (const o of orders) next[o.so_doc_no] = value;
    setDates(next);
  };

  const dateFor = (docNo: string): string => dates[docNo] ?? "";

  const driverName = driverId ? (activeDrivers.find((d) => d.id === driverId)?.name ?? null) : null;
  const lorryPlate = lorryId ? (activeLorries.find((l) => l.id === lorryId)?.plate ?? null) : null;

  const hasRoute = !!(proposal?.ok && route);

  const applyOrder: PlanningOrder[] = useMemo(() => {
    if (!hasRoute) return orders;
    const byDoc = new Map(orders.map((o) => [o.so_doc_no, o]));
    const seq = order.map((ref) => byDoc.get(ref)).filter((o): o is PlanningOrder => !!o);
    const seen = new Set(order);
    for (const o of orders) if (!seen.has(o.so_doc_no)) seq.push(o);
    return seq;
  }, [hasRoute, order, orders]);

  const routeExtraFor = (ref: string): { stopNo: number; etaOffsetS: number; legDistanceM: number; legDurationS: number } | null => {
    if (!route) return null;
    const st = route.sequence.find((s) => s.ref === ref);
    if (!st) return null;
    const arrMin = timeToMinutes(st.arrivalTime);
    const etaOffsetS = arrMin != null ? Math.max(0, (arrMin - departMin) * 60) : 0;
    return {
      stopNo: st.order,
      etaOffsetS,
      legDistanceM: Math.round(st.distanceMetres),
      legDurationS: Math.round(st.travelMinutes * 60),
    };
  };

  const apply = async () => {
    if (applying || applyOrder.length === 0) return;
    setApplying(true);
    const out: Record<string, ApplyResult> = {};
    const LIMIT = 4;
    try {
      for (let i = 0; i < applyOrder.length; i += LIMIT) {
        const batch = applyOrder.slice(i, i + LIMIT);
        await Promise.all(
          batch.map(async (o) => {
            const docNo = o.so_doc_no;
            const date = dateFor(docNo);
            const extra = routeExtraFor(docNo);
            try {
              const res = await sched.mutateAsync({
                type: "so",
                id: docNo,
                ...(date ? { scheduleDate: date } : {}),
                ...(driverId ? { driverId, driverNameOptimistic: driverName } : {}),
                ...(lorryId ? { lorryId, lorryPlateOptimistic: lorryPlate } : {}),
                ...(depotWarehouseId ? { warehouseId: depotWarehouseId } : {}),
                ...(extra ? { stopNo: extra.stopNo, etaOffsetS: extra.etaOffsetS, legDistanceM: extra.legDistanceM, legDurationS: extra.legDurationS } : {}),
              });
              if (res?.tripWiring?.failed) {
                out[docNo] = { state: "FAILED", detail: res.tripWiring.reason || "Trip wiring failed." };
              } else if (lorryId) {
                out[docNo] = { state: "WIRED", detail: res?.trip?.trip_no ? `On ${res.trip.trip_no}` : "Scheduled onto a trip." };
              } else {
                out[docNo] = { state: "NOT_REQUESTED", detail: "Date saved — no lorry assigned, so no trip." };
              }
            } catch (e) {
              out[docNo] = { state: "FAILED", detail: e instanceof Error ? e.message : "Something went wrong." };
            }
          }),
        );
      }
    } finally {
      setResults(out);
      setApplying(false);
    }

    const wired = Object.values(out).filter((r) => r.state === "WIRED").length;
    const noTrip = Object.values(out).filter((r) => r.state === "NOT_REQUESTED").length;
    const failed = Object.values(out).filter((r) => r.state === "FAILED").length;
    const parts: string[] = [];
    if (wired > 0) parts.push(`${wired} wired onto a trip`);
    if (noTrip > 0) parts.push(`${noTrip} date-only (no lorry)`);
    if (failed > 0) parts.push(`${failed} failed`);
    notify({
      title: failed > 0 ? "Applied with errors" : "Schedule applied",
      body: parts.join(" · ") || "Nothing to apply.",
      tone: failed > 0 ? "error" : "info",
    });
  };

  const countLabel = `${orders.length} order${orders.length === 1 ? "" : "s"} selected`;

  const mapStops: RoutePoint[] = useMemo(() => {
    if (!route) return [];
    return route.sequence
      .map((st): RoutePoint | null => {
        const s = stopByRef.get(st.ref);
        if (!s) return null;
        return { ref: st.ref, lat: s.lat, lng: s.lng, order: st.order, label: s.debtorName || st.ref, violated: st.windowViolated };
      })
      .filter((p): p is RoutePoint => p !== null);
  }, [route, stopByRef]);

  return (
    <ResizableDrawer
      onClose={onClose}
      storageKey="panel-dp-schedule-drawer.v1"
      ariaLabel="Schedule trip"
      title="Schedule trip"
      subtitle={countLabel}
      headerActions={
        <button
          type="button"
          onClick={onOpenTrips}
          title="Open the full Trips page"
          className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
        >
          Open in Trips <ExternalLink size={12} />
        </button>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11.5px] text-ink-muted">
            Apply schedules each stop onto its lorry-day trip (find-or-create). Results are shown per stop.
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={() => void apply()} disabled={applying || applyOrder.length === 0}>
              {applying ? "Applying…" : `Apply to ${applyOrder.length}`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5 px-5 py-5">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={proposeDates} icon={<CalendarClock size={15} strokeWidth={1.75} />}>
            Propose dates
          </Button>
          <Button
            variant="secondary"
            onClick={() => void proposeTimes()}
            disabled={propose.isPending || orders.length === 0}
            icon={<MapPinned size={15} strokeWidth={1.75} />}
          >
            {propose.isPending ? "Proposing…" : "Propose times + route"}
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-surface-dim/50 p-4">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-muted">Trip assignment</div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Trip date</span>
              <DateField
                fullWidth
                value={tripDate}
                onChange={(iso) => setAllDates(iso)}
                className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-primary focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Driver</span>
              <select
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-primary focus:outline-none"
              >
                <option value="">Unassigned</option>
                {activeDrivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.leaveNote ? `${d.name} · ${d.leaveNote}` : d.name}</option>
                ))}
              </select>
              {pickedDriverLeaveNote && (
                <span className="mt-1 block text-[11px] text-warning-text">{pickedDriverLeaveNote}</span>
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Lorry</span>
              <select
                value={lorryId}
                onChange={(e) => setLorryId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-primary focus:outline-none"
              >
                <option value="">Unassigned</option>
                {regionLorries.map((l) => <option key={l.id} value={l.id}>{l.plate}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <label className="col-span-2 block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Depot (route origin)</span>
              <select
                value={depotWarehouseId}
                onChange={(e) => setDepotWarehouseId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-primary focus:outline-none"
              >
                <option value="">None</option>
                {activeWarehouses.map((w) => <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Depart</span>
              <input
                type="time"
                value={departTime}
                onChange={(e) => setDepartTime(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-primary focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-2 text-[11px] text-ink-muted">
            Setting a trip date fills every stop below. A lorry is what puts the orders on a trip; without one, Apply only saves the date.
          </div>
        </div>

        {hasRoute && route && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">Proposed route</div>
              <div className="text-[11.5px] text-ink-secondary">
                {fmtMins(route.totalTravelMinutes)} drive · {fmtKm(route.totalDistanceMetres)} · back by {route.returnTime ?? "—"}
              </div>
            </div>

            {MAPS_BROWSER_KEY ? (
              <ScheduleRouteMap
                apiKey={MAPS_BROWSER_KEY}
                depot={proposal?.depot ? { lat: proposal.depot.lat, lng: proposal.depot.lng } : null}
                stops={mapStops}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-surface-dim px-4 py-3 text-[12px] text-ink-muted">
                Map key not configured. Set <span className="font-mono">VITE_GOOGLE_MAPS_API_KEY</span> (a referrer-restricted
                browser key) to render the interactive map. The proposed sequence + times below are unaffected.
              </div>
            )}

            {route.windowViolations > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  {route.windowViolations} stop{route.windowViolations === 1 ? "" : "s"} cannot meet the delivery window with
                  this order/depart time. Reorder, move a stop to another trip, or change the depart time.
                </span>
              </div>
            )}

            <ol className="space-y-2">
              {route.sequence.map((st) => {
                const s = stopByRef.get(st.ref);
                const r = results[st.ref];
                return (
                  <li
                    key={st.ref}
                    draggable
                    onDragStart={() => setDragRef(st.ref)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragRef) reorder(dragRef, st.ref); setDragRef(null); }}
                    onDragEnd={() => setDragRef(null)}
                    className={`flex items-start gap-2.5 rounded-lg border bg-surface p-3 ${st.windowViolated ? "border-err/50" : "border-border"} ${dragRef === st.ref ? "opacity-50" : ""}`}
                  >
                    <span className="mt-1 cursor-grab text-ink-muted active:cursor-grabbing" title="Drag to reorder">
                      <GripVertical size={15} />
                    </span>
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11.5px] font-bold text-primary-ink">
                      {st.order}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-bold text-ink">{s?.debtorName || "—"}</span>
                        {s?.buildingType && (
                          <span className="shrink-0 rounded-full border border-border bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                            {s.buildingType}
                          </span>
                        )}
                        {r && (
                          <span className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${RESULT_TONE[r.state]}`} title={r.detail}>
                            {RESULT_LABEL[r.state]}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{st.ref}</div>
                      <div className="mt-1 line-clamp-1 text-[12px] text-ink-secondary">{s?.address || "—"}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px]">
                        <span className="text-ink">
                          Arrive <span className="font-semibold">{st.arrivalTime ?? "—"}</span>
                          {st.waitMinutes > 0 && <span className="text-ink-muted"> (wait {fmtMins(st.waitMinutes)})</span>}
                        </span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-ink">Finish <span className="font-semibold">{st.finishTime ?? "—"}</span></span>
                        <span className="text-ink-muted">· {fmtMins(st.serviceMinutes)} on site</span>
                        {(st.earliestTime || st.latestTime) && (
                          <span className={st.windowViolated ? "text-err font-semibold" : "text-ink-muted"}>
                            · window {st.earliestTime ?? "—"}–{st.latestTime ?? "—"}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {proposal && proposal.ungeocoded.length > 0 && (
              <div className="rounded-lg border border-warning-text/30 bg-warning-bg px-3 py-2 text-[11.5px] text-warning-text">
                <span className="font-semibold">Not placed on the map ({proposal.ungeocoded.length}):</span>{" "}
                {proposal.ungeocoded.map((u) => `${u.debtorName || u.ref} (${u.reason})`).join("; ")}. They still schedule on Apply.
              </div>
            )}
          </div>
        )}

        {!hasRoute && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">Stops ({orders.length})</div>
            </div>
            {orders.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-ink-muted">
                No orders selected.
              </div>
            ) : (
              <ol className="space-y-2">
                {orders.map((o, i) => {
                  const r = results[o.so_doc_no];
                  return (
                    <li key={o.so_doc_no} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11.5px] font-bold text-primary-ink">
                        {i + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-bold text-ink">{o.debtor_name || "—"}</span>
                          {o.region && (
                            <span className="shrink-0 rounded-full border border-border bg-surface-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                              {o.region}
                            </span>
                          )}
                          {r && (
                            <span className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${RESULT_TONE[r.state]}`} title={r.detail}>
                              {RESULT_LABEL[r.state]}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{o.so_doc_no}</div>
                        <div className="mt-1 line-clamp-2 text-[12px] text-ink-secondary">
                          {o.address || "No delivery address on file"}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-ink-secondary">Delivery date</span>
                          <DateField
                            fullWidth
                            value={dateFor(o.so_doc_no)}
                            onChange={(iso) => setDates((p) => ({ ...p, [o.so_doc_no]: iso }))}
                            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] text-ink focus:border-primary focus:outline-none"
                          />
                          <span className="text-[11px] text-ink-muted">
                            {dateFor(o.so_doc_no) ? "" : `was ${fmtDateOrDash(o.effective_delivery_date ?? o.customer_delivery_date)}`}
                          </span>
                        </div>
                        {r && r.state !== "NOT_REQUESTED" && (
                          <div className={`mt-1.5 text-[11px] ${r.state === "FAILED" ? "text-err" : "text-ink-muted"}`}>
                            {r.detail}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
      </div>
    </ResizableDrawer>
  );
}
