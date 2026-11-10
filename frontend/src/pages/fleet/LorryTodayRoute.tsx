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
import { BTN_SEC, Tile } from "./FleetUi";
import { fmtDrive, fmtKm, useRoadFigures } from "../../vendor/scm/lib/lorry-routes-queries";
import { drivenPath, useLorryRoadTrack } from "../../vendor/scm/lib/lorry-road-track";

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
  const positions = useLorryPositions();
  const tracker = (positions.data ?? []).find((p) => p.lorry_id === lorryId) ?? null;
  const trackQ = useLorryTrack(lorryId, date);
  const track = trackQ.data;
  const kmCost = (useLorryKmCost().data ?? []).find((k) => k.lorry_id === lorryId) ?? null;
  /* The run by road, home and back, as Last Mile worked it out (owner 2026-11-08). */
  const road = useRoadFigures(`${date.slice(0, 7)}-01`, date, lorryId);
  const roadToday = (road.data ?? []).find((r) => r.date === date) ?? null;
  const roadMonth = (road.data ?? []).reduce((a, r) => ({ m: a.m + r.distanceM, s: a.s + r.durationS, d: a.d + 1 }), { m: 0, s: 0, d: 0 });
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
  const roadTrack = useLorryRoadTrack(lorryId, date);
  const driven = drivenPath(roadTrack.data, track?.fixes ?? []);

  /* A failed read used to look exactly like "no run today / no position yet". */
  const failed = [day.isError && "today's runs", positions.isError && "the GPS position", trackQ.isError && "today's track"].filter(Boolean);
  return (
    <div className="space-y-3">
      {failed.length > 0 && (
        <p role="alert" className="rounded-[10px] bg-err-bg px-3 py-2.5 text-[13px] font-semibold text-err">Could not load {failed.join(", ")}. What shows below may be incomplete.</p>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Now" value={position ? `${position.street ?? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`}` : "No position yet"}
          hint={position
            ? `${fmtTime(position.at)} · ${position.source}${position.speed != null ? ` · ${Math.round(position.speed)} km/h` : ""}`
            : "Shows once the GPS tracker reports, or the driver taps On the way"} />
        <Tile label="Driven today" value={track ? `${track.km.toFixed(1)} km` : "No track yet"}
          hint={kmCost?.cost_sen != null ? `running cost ${fmtSen(kmCost.cost_sen)}` : "set RM/km in Vehicle details to see the cost"} />
        <Tile label="Today's run" value={runs.length ? runs.map((t) => t.trip_no ?? "Run").join(", ") : "No run today"}
          hint={runs.length ? `${runs[0]?.driver?.name ?? "no driver"} · ${stops.length} stop${stops.length === 1 ? "" : "s"}` : "Runs are planned in Delivery Time Arrangement"} />
        <Tile label="Google km · Google time today" value={roadToday ? `${fmtKm(roadToday.distanceM)} · ${fmtDrive(roadToday.durationS)}` : road.isError ? "Could not load" : "Not worked out yet"}
          hint={roadMonth.d ? `this month ${fmtKm(roadMonth.m)} · ${fmtDrive(roadMonth.s)} over ${roadMonth.d} day${roadMonth.d === 1 ? "" : "s"}` : "from its warehouse and back, worked out on Last Mile"} />
      </div>

      {MAPS_KEY ? (
        <ScheduleRouteMap
          apiKey={MAPS_KEY}
          depot={runs[0]?.depot ?? null}
          stops={points}
          track={driven.path}
          vehicle={position ? { lat: position.lat, lng: position.lng, label: "Lorry now" } : null}
        />
      ) : (
        <p className="rounded-xl border border-dashed border-[#d9d3c6] px-3 py-2.5 text-[13px] text-ink-muted">
          The map needs VITE_GOOGLE_MAPS_API_KEY. The facts and stop list still work.
        </p>
      )}
      {MAPS_KEY && <p className="text-[12px] text-ink-muted">Grey line: where it drove today{driven.byRoad ? ", along the roads" : ", joined straight between GPS fixes"}. Blue: today&apos;s planned stops. Dark marker: where it is now.</p>}

      {stops.length > 0 && (
        <ol className="flex flex-col gap-2">
          {stops.map((s, i) => (
            <li key={s.id} className="flex items-start gap-2.5 text-[13px]">
              <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-[#2c6aa0] text-[12px] font-bold text-white">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-ink">{s.customer_name ?? s.stop_type}</span>
                {s.address && <span className="block truncate text-[12.5px] text-ink-muted">{s.address}</span>}
              </span>
              <span className="flex-none text-right text-[12px] tabular-nums text-ink-muted">
                {hm(s.earliest_time) || hm(s.latest_time) ? `${hm(s.earliest_time) ?? ""}–${hm(s.latest_time) ?? ""}` : ""}
                {!s.geocoded && <span className="block">not on map</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {runs.length > 0 && (
        <Link to={`/scm/fleet-day?date=${date}&trip=${runs[0]?.id ?? ""}`} className={BTN_SEC}>Open today&apos;s run in Last Mile</Link>
      )}
    </div>
  );
}
