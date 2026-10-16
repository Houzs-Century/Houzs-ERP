// Where this lorry is now and its route today (owner, 2026-10-15: clicking a
// lorry should show where it is and its whole route).
//
// Three facts, three sources:
//   - where it is: the lorry's GPS tracker (Velocity, scm.lorry_positions, a fix
//     every 5 min); a lorry without a tracker falls back to the crew phone's fix
//     on today's run (scm.trip_locations).
//   - where it went: today's tracker fixes in order — the route actually driven,
//     with the km it adds up to.
//   - where it is meant to go: today's planned stops (GET /trips/day).
import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useFleetDay } from "../../vendor/scm/lib/fleet-day-queries";
import { useActiveTripLocations } from "../../vendor/scm/lib/trip-locations-queries";
import { useLorryPositions, useLorryTrack, useLorryKmCost } from "../../vendor/scm/lib/lorries-queries";
import { ScheduleRouteMap, type RoutePoint } from "../../vendor/scm/components/ScheduleRouteMap";
import { fmtSen, fmtTime, todayMY } from "../../vendor/shared/format";

const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? "";

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

export function LorryTodayRoute({ lorryId }: { lorryId: string }) {
  const date = todayMY();
  const day = useFleetDay({ date });
  const runs = useMemo(
    () => (day.data?.trips ?? []).filter((t) => t.lorry?.id === lorryId && String(t.status).toUpperCase() !== "CANCELLED"),
    [day.data, lorryId],
  );
  const live = runs.some((t) => String(t.status).toUpperCase() === "IN_PROGRESS");
  const tracker = (useLorryPositions().data ?? []).find((p) => p.lorry_id === lorryId) ?? null;
  const track = useLorryTrack(lorryId, date).data;
  const kmCost = (useLorryKmCost().data ?? []).find((k) => k.lorry_id === lorryId) ?? null;
  const phones = useActiveTripLocations(live && !tracker);
  const phoneFix = useMemo(() => {
    const ids = new Set(runs.map((t) => t.id));
    return (phones.data?.locations ?? [])
      .filter((l) => ids.has(l.tripId))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .at(0) ?? null;
  }, [phones.data, runs]);

  const position = tracker
    ? { lat: tracker.lat, lng: tracker.lng, at: tracker.recorded_at, source: "GPS tracker", street: tracker.street, speed: tracker.speed_kmh }
    : phoneFix
      ? { lat: phoneFix.lat, lng: phoneFix.lng, at: phoneFix.recordedAt, source: "driver phone", street: null, speed: null }
      : null;

  const stops = runs.flatMap((t) => t.stops);
  const points: RoutePoint[] = stops
    .filter((s) => s.lat != null && s.lng != null)
    .map((s, i) => ({ ref: s.id, lat: s.lat as number, lng: s.lng as number, order: i + 1, label: s.customer_name ?? s.stop_type }));
  const driven = (track?.fixes ?? []).map((f) => ({ lat: f.lat, lng: f.lng }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Fact label="Now" value={position ? `${position.street ?? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`}` : "No position yet"}
          hint={position
            ? `${fmtTime(position.at)} · ${position.source}${position.speed != null ? ` · ${Math.round(position.speed)} km/h` : ""}`
            : "Shows once the GPS tracker reports, or the driver taps On the way"} />
        <Fact label="Driven today" value={track ? `${track.km.toFixed(1)} km` : "—"}
          hint={kmCost?.cost_sen != null ? `running cost ${fmtSen(kmCost.cost_sen)}` : "set RM/km in Vehicle details to see the cost"} />
        <Fact label="Today's run" value={runs.length ? runs.map((t) => t.trip_no ?? "Run").join(", ") : "No run today"}
          hint={runs.length ? `${runs[0]?.driver?.name ?? "no driver"} · ${stops.length} stop${stops.length === 1 ? "" : "s"}` : "Runs are planned in Delivery Time Arrangement"} />
      </div>

      {MAPS_KEY ? (
        <ScheduleRouteMap
          apiKey={MAPS_KEY}
          depot={runs[0]?.depot ?? null}
          stops={points}
          track={driven}
          vehicle={position ? { lat: position.lat, lng: position.lng, label: "Lorry now" } : null}
        />
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-[11.5px] text-ink-muted">
          The map needs VITE_GOOGLE_MAPS_API_KEY. The facts and stop list still work.
        </p>
      )}
      {MAPS_KEY && <p className="text-[10.5px] text-ink-muted">Grey line: where it drove today. Blue: today&apos;s planned stops. Dark marker: where it is now.</p>}

      {stops.length > 0 && (
        <ol className="divide-y divide-border rounded-md border border-border">
          {stops.map((s, i) => (
            <li key={s.id} className="flex items-start gap-3 px-3 py-2 text-[12px]">
              <span className="w-5 flex-none text-right font-semibold tabular-nums text-ink-muted">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="text-ink">{s.customer_name ?? s.stop_type}</span>
                {s.address && <span className="block truncate text-[11px] text-ink-muted">{s.address}</span>}
              </span>
              <span className="flex-none text-right text-[11px] tabular-nums text-ink-muted">
                {hm(s.earliest_time) || hm(s.latest_time) ? `${hm(s.earliest_time) ?? ""}–${hm(s.latest_time) ?? ""}` : ""}
                {!s.geocoded && <span className="block">not on map</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {runs.length > 0 && (
        <Link to={`/scm/fleet-day?date=${date}&trip=${runs[0]?.id ?? ""}`} className="inline-block text-[11.5px] text-primary hover:underline">Open today&apos;s run in Last Mile</Link>
      )}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">{value}</div>
      {hint && <div className="text-[10.5px] text-ink-muted">{hint}</div>}
    </div>
  );
}
