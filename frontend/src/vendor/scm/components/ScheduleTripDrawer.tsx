// ----------------------------------------------------------------------------
// ScheduleTripDrawer — Phase 2 of the TMS. A right-side, drag-RESIZABLE drawer
// opened from the Delivery Planning board's multiselect bar ("Schedule"). The
// dispatcher reviews the selected orders as an ordered stop sequence, assigns a
// trip date + driver + lorry, and clicks Apply — WITHOUT leaving the board.
//
// Reuses the existing schedule path only: PATCH /delivery-planning/so/:id/schedule
// via useScheduleDelivery (find-or-creates the trip + a DELIVERY stop). No new
// schedule endpoint, no new trip logic. The per-order result is surfaced honestly
// (WIRED / NOT_REQUESTED / FAILED) — REPORT, don't REPAIR.
//
// "Propose dates" is a first-cut, DISPLAY-ONLY suggestion (each order's own
// effective delivery date); nothing is written until Apply. "Propose times +
// route" and the map are Phase 3 — that button renders DISABLED with a Phase 3
// affordance here.
//
// Desktop only (the mobile delivery surface is a read-only driver run-sheet).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { CalendarClock, MapPinned, ExternalLink } from "lucide-react";
import { ResizableDrawer } from "../../../components/ResizableDrawer";
import { Button } from "../../../components/Button";
import { fmtDateOrDash } from "@2990s/shared";
import { useDrivers } from "../lib/drivers-queries";
import { useLorries } from "../lib/lorries-queries";
import { useScheduleDelivery, type PlanningOrder } from "../lib/delivery-planning-queries";
import { useNotify } from "./NotifyDialog";

/* One order's effective delivery date — amended wins over the customer's
   original (the same rule derivePlanningState uses), null-safe. Sliced to the
   YYYY-MM-DD a <input type="date"> wants. */
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
  const sched = useScheduleDelivery();

  const activeDrivers = useMemo(() => drivers.filter((d) => d.active), [drivers]);
  const activeLorries = useMemo(() => lorries.filter((l) => l.active), [lorries]);

  /* Per-order proposed date (the scheduleDate that gets applied). Keyed by SO
     doc_no; starts blank so nothing is assumed until the dispatcher proposes or
     types a date. */
  const [dates, setDates] = useState<Record<string, string>>({});
  const [tripDate, setTripDate] = useState("");
  const [driverId, setDriverId] = useState("");
  const [lorryId, setLorryId] = useState("");
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<Record<string, ApplyResult>>({});

  /* Propose dates — first-cut suggestion: fill each stop with its OWN effective
     delivery date (amended ?? customer). Where absent, left blank for the
     dispatcher. DISPLAY ONLY — nothing is written until Apply. */
  const proposeDates = () => {
    const next: Record<string, string> = {};
    for (const o of orders) next[o.so_doc_no] = effectiveDateOf(o);
    setDates(next);
  };

  /* A single trip date applied to EVERY stop — the natural "one lorry-day trip"
     case. Overwrites each per-stop date so they land on one find-or-created trip. */
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

  const apply = async () => {
    if (applying || orders.length === 0) return;
    setApplying(true);
    const out: Record<string, ApplyResult> = {};
    const LIMIT = 4;
    try {
      for (let i = 0; i < orders.length; i += LIMIT) {
        const batch = orders.slice(i, i + LIMIT);
        await Promise.all(
          batch.map(async (o) => {
            const docNo = o.so_doc_no;
            const date = dateFor(docNo);
            try {
              const res = await sched.mutateAsync({
                type: "so",
                id: docNo,
                /* Only send what the dispatcher set — never null out an existing
                   assignment with a field they left untouched. */
                ...(date ? { scheduleDate: date } : {}),
                ...(driverId ? { driverId, driverNameOptimistic: driverName } : {}),
                ...(lorryId ? { lorryId, lorryPlateOptimistic: lorryPlate } : {}),
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
            <Button variant="primary" onClick={() => void apply()} disabled={applying || orders.length === 0}>
              {applying ? "Applying…" : `Apply to ${orders.length}`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5 px-5 py-5">
        {/* Two distinct proposal actions (the approved mockup). */}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={proposeDates} icon={<CalendarClock size={15} strokeWidth={1.75} />}>
            Propose dates
          </Button>
          <button
            type="button"
            disabled
            title="Smart time + route proposals arrive in Phase 3"
            className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-md border border-border bg-surface-dim px-4 text-[13px] font-semibold tracking-wide text-ink-muted opacity-70"
          >
            <MapPinned size={15} strokeWidth={1.75} />
            Propose times + route
            <span className="ml-1 rounded-full bg-border px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-ink-muted">
              Phase 3
            </span>
          </button>
        </div>

        {/* Trip assignment — one lorry-day: date + driver + lorry, applied to all. */}
        <div className="rounded-lg border border-border bg-surface-dim/50 p-4">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-muted">Trip assignment</div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Trip date</span>
              <input
                type="date"
                value={tripDate}
                onChange={(e) => setAllDates(e.target.value)}
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
                {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary">Lorry</span>
              <select
                value={lorryId}
                onChange={(e) => setLorryId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-primary focus:outline-none"
              >
                <option value="">Unassigned</option>
                {activeLorries.map((l) => <option key={l.id} value={l.id}>{l.plate}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-2 text-[11px] text-ink-muted">
            Setting a trip date fills every stop below. A lorry is what puts the orders on a trip; without one, Apply only saves the date.
          </div>
        </div>

        {/* Ordered stop sequence. */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">
              Stops ({orders.length})
            </div>
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
                  <li
                    key={o.so_doc_no}
                    className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3"
                  >
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
                        <input
                          type="date"
                          value={dateFor(o.so_doc_no)}
                          onChange={(e) => setDates((p) => ({ ...p, [o.so_doc_no]: e.target.value }))}
                          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] text-ink focus:border-primary focus:outline-none"
                        />
                        <span className="text-[11px] text-ink-muted">
                          {dateFor(o.so_doc_no)
                            ? ""
                            : `was ${fmtDateOrDash(o.effective_delivery_date ?? o.customer_delivery_date)}`}
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
      </div>
    </ResizableDrawer>
  );
}
