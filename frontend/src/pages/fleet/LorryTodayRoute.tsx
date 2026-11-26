// Where this lorry is now and its route on a chosen day (owner, 2026-10-15: clicking a
// lorry should show where it is and its whole route). The day is the `day` URL param
// (default today); a past day is history: no live position, no polling, with a playback
// bar over the day's fixes and the real delivery points (POD GPS) as orange pins.
//
// Three facts, three sources:
//   - where it is: the lorry's GPS tracker (Velocity, scm.lorry_positions, a fix
//     every 5 min); a lorry without a tracker falls back to the crew phone's fix
//     on today's run (scm.trip_locations).
//   - where it went: today's tracker fixes in order — the route actually driven,
//     with the km it adds up to.
//   - where it is meant to go: today's planned stops (GET /trips/day).
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMemo } from "react";
import { PlaybackBar, useDayPlayback } from "./DayPlayback";
import { FAR_FROM_ADDRESS_M, metresFromAddress, minutesOnSite } from "./drop-facts";
import { useFleetDay } from "../../vendor/scm/lib/fleet-day-queries";
import { useActiveTripLocations } from "../../vendor/scm/lib/trip-locations-queries";
import { useLorries, useLorryPositions, useLorryTrack, useLorryKmCost } from "../../vendor/scm/lib/lorries-queries";
import { ScheduleRouteMap, type RoutePoint } from "../../vendor/scm/components/ScheduleRouteMap";
import { DateField } from "../../vendor/scm/components/DateField";
import { fmtSen, fmtTime, todayMY } from "../../vendor/shared/format";
import { BTN_SEC, Tile } from "./FleetUi";
import { fmtDrive, fmtKm, useRoadFigures } from "../../vendor/scm/lib/lorry-routes-queries";
import { drivenPath, useLorryRoadTrack } from "../../vendor/scm/lib/lorry-road-track";

const MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? "";

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function LorryTodayRoute({ lorryId }: { lorryId: string }) {
  const today = todayMY();
  const [params, setParams] = useSearchParams();
  const asked = params.get("day");
  const date = asked && DAY_RE.test(asked) && asked <= today ? asked : today;
  const isToday = date === today;
  const setDay = (d: string) => setParams((p) => { const n = new URLSearchParams(p); if (d && d !== today) n.set("day", d); else n.delete("day"); return n; }, { replace: true });
  const day = useFleetDay({ date });
  const runs = useMemo(
    () => (day.data?.trips ?? []).filter((t) => t.lorry?.id === lorryId && String(t.status).toUpperCase() !== "CANCELLED"),
    [day.data, lorryId],
  );
  const live = isToday && runs.some((t) => String(t.status).toUpperCase() === "IN_PROGRESS");
  const positions = useLorryPositions(isToday);
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

  const position = !isToday ? null : tracker
    ? { lat: tracker.lat, lng: tracker.lng, at: tracker.recorded_at, source: "GPS tracker", street: tracker.street, speed: tracker.speed_kmh }
    : phoneFix
      ? { lat: phoneFix.lat, lng: phoneFix.lng, at: phoneFix.recordedAt, source: "driver phone", street: null, speed: null }
      : null;

  const stops = useMemo(() => runs.flatMap((t) => t.stops), [runs]);
  const points: RoutePoint[] = useMemo(() => stops
    .filter((s) => s.lat != null && s.lng != null)
    .map((s, i) => ({ ref: s.id, lat: s.lat as number, lng: s.lng as number, order: i + 1, label: s.customer_name ?? s.stop_type })), [stops]);
  const roadTrack = useLorryRoadTrack(lorryId, date);
  const fixes = useMemo(() => track?.fixes ?? [], [track]);
  const driven = useMemo(() => drivenPath(roadTrack.data, fixes), [roadTrack.data, fixes]);
  const playback = useDayPlayback(fixes, date);
  const playhead = playback.playhead;
  const drops = useMemo(() => {
    const stopById = new Map(stops.map((s) => [s.id, s]));
    return (track?.drops ?? []).map((d) => ({
      ...d,
      offBy: metresFromAddress(d, d.stopId ? stopById.get(d.stopId) ?? null : null),
      onSite: minutesOnSite(d, fixes),
    }));
  }, [track, stops, fixes]);
  const dropPoints: RoutePoint[] = useMemo(() => drops.flatMap((d, i) => d.lat != null && d.lng != null
    ? [{ ref: d.ref, lat: d.lat, lng: d.lng, order: i + 1, label: d.label }] : []), [drops]);
  const navigate = useNavigate();
  const lorries = useLorries();
  const dayWord = isToday ? "today" : date;
  const dayOf = isToday ? "today's" : date;

  const failed = [day.isError && `${dayOf} runs`, isToday && positions.isError && "the GPS position", trackQ.isError && `${dayOf} track`].filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-muted">Lorry
          <select value={lorryId} onChange={(e) => navigate(`/fleet-health/${encodeURIComponent(e.target.value)}${isToday ? "" : `?day=${date}`}`)}
            className="h-[34px] rounded-lg border border-[#d9d3c6] bg-surface px-2 text-[13px] font-normal text-ink">
            {!(lorries.data ?? []).some((l) => l.id === lorryId) && <option value={lorryId}>This lorry</option>}
            {(lorries.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.plate}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-muted">Day
          <DateField value={date} max={today} onChange={setDay} aria-label="Day" />
        </label>
        {!isToday && <button type="button" className={BTN_SEC} onClick={() => setDay(today)}>Today</button>}
      </div>
      {failed.length > 0 && (
        <p role="alert" className="rounded-[10px] bg-err-bg px-3 py-2.5 text-[13px] font-semibold text-err">Could not load {failed.join(", ")}. What shows below may be incomplete.</p>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {isToday && <Tile label="Now" value={position ? `${position.street ?? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`}` : "No position yet"}
          hint={position
            ? `${fmtTime(position.at)} · ${position.source}${position.speed != null ? ` · ${Math.round(position.speed)} km/h` : ""}`
            : "Shows once the GPS tracker reports, or the driver taps On the way"} />}
        <Tile label={`Driven ${dayWord}`} value={track ? `${track.km.toFixed(1)} km` : "No track yet"}
          hint={!isToday ? "straight line between GPS fixes" : kmCost?.cost_sen != null ? `running cost ${fmtSen(kmCost.cost_sen)}` : "set RM/km in Vehicle details to see the cost"} />
        <Tile label={isToday ? "Today's run" : "Run"} value={runs.length ? runs.map((t) => t.trip_no ?? "Run").join(", ") : isToday ? "No run today" : "No run that day"}
          hint={runs.length ? `${runs[0]?.driver?.name ?? "no driver"} · ${stops.length} stop${stops.length === 1 ? "" : "s"}` : "Runs are planned in Delivery Time Arrangement"} />
        <Tile label={`Google km · Google time ${dayWord}`} value={roadToday ? `${fmtKm(roadToday.distanceM)} · ${fmtDrive(roadToday.durationS)}` : road.isError ? "Could not load" : "Not worked out yet"}
          hint={roadMonth.d ? `this month ${fmtKm(roadMonth.m)} · ${fmtDrive(roadMonth.s)} over ${roadMonth.d} day${roadMonth.d === 1 ? "" : "s"}` : "from its warehouse and back, worked out on Last Mile"} />
      </div>

      {MAPS_KEY ? (
        <ScheduleRouteMap
          apiKey={MAPS_KEY}
          depot={runs[0]?.depot ?? null}
          stops={points}
          track={driven.path}
          drops={dropPoints}
          vehicle={playhead ? { lat: playhead.lat, lng: playhead.lng, label: `Playback ${fmtTime(playhead.recorded_at)}` } : position ? { lat: position.lat, lng: position.lng, label: "Lorry now" } : null}
        />
      ) : (
        <p className="rounded-xl border border-dashed border-[#d9d3c6] px-3 py-2.5 text-[13px] text-ink-muted">
          The map needs VITE_GOOGLE_MAPS_API_KEY. The facts and stop list still work.
        </p>
      )}
      {track?.dropsError && <p className="text-[12.5px] text-err">Drop points could not load: {track.dropsError}</p>}
      {fixes.length > 0 && <PlaybackBar p={playback} count={fixes.length} />}
      {MAPS_KEY && <p className="text-[12px] text-ink-muted">Grey line: where it drove {dayWord}{driven.byRoad ? ", along the roads" : ", joined straight between GPS fixes"}. Blue: planned stops. Orange: where it delivered.{isToday ? " Dark marker: where it is now." : ""}</p>}
      {drops.length > 0 && (
        <ol className="flex flex-col gap-2">
          {drops.map((d, i) => (
            <li key={d.ref} className="flex items-start gap-2.5 text-[13px]">
              <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-[#ea580c] text-[12px] font-bold text-white">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-ink">{d.label}</span>
                <span className="block text-[12px] text-ink-muted">
                  {d.lat == null && "Delivered, no GPS"}
                  {d.onSite != null && <span className="mr-2">{d.onSite} min on site</span>}
                  {d.offBy != null && <span className={d.offBy > FAR_FROM_ADDRESS_M ? "font-semibold text-err" : undefined}>{fmtKm(d.offBy)} from the address</span>}
                </span>
              </span>
              <span className="flex-none text-[12px] tabular-nums text-ink-muted">{fmtTime(d.at)}</span>
            </li>
          ))}
        </ol>
      )}

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
        <Link to={`/scm/fleet-day?date=${date}&trip=${runs[0]?.id ?? ""}`} className={BTN_SEC}>Open {isToday ? "today's" : "this day's"} run in Last Mile</Link>
      )}
    </div>
  );
}
