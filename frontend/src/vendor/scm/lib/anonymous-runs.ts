// ----------------------------------------------------------------------------
// anonymous-runs — the Time page's view of a sequence proposal, with the crew
// dimension REMOVED (owner's final division, 2026-08-08: Delivery Time
// Arrangement = 排单 — "在送货当天，决定那一个区要先送哪一张单" — sequencing
// only; the intelligent driver + lorry assignment lives on Last Mile
// Delivery).
//
// The sequence-assign engine inherently packs into lorry-sized runs — capacity
// is REAL and keeping it is why the engine stays (zero backend change). What
// is NOT the Time page's business is the vehicle's NAME or its crew. This pure
// fold turns the engine's trips into anonymous "Run 1 / Run 2" groups per
// date: every identity field (plate, lorryId, driver/helper ids + names) is
// dropped from the output shape. The ONE vehicle reference that survives is
// `vehicleSlotId` — an opaque uuid kept strictly as Apply plumbing, because a
// trip_stops row needs a trip and a trip keys on (lorry, date); it is never
// rendered, and Last Mile's "Propose crew" is where a name is put to the slot.
//
// Pinned by anonymous-runs.test.ts, including "the output contains no lorry
// identity".
// ----------------------------------------------------------------------------
import type { AssignedTrip } from './delivery-zones-queries';

export type AnonymousRunStop = {
  ref: string;
  order: number;
  debtorName: string | null;
  buildingType: string | null;
  arrivalTime: string | null;
  finishTime: string | null;
  earliestTime: string | null;
  latestTime: string | null;
  windowViolated: boolean;
  /* Route metrics for Apply (persisted onto the stop) — facts about the
     sequence, not about any vehicle's identity. Null on an unrouted run. */
  etaOffsetS: number | null;
  legDistanceM: number | null;
  legDurationS: number | null;
};

export type AnonymousRun = {
  key: string;
  date: string;
  /** The packer's zone group — 'KLANG_VALLEY' (mixed) or a dedicated far zone. */
  group: string;
  /** 1-based run number WITHIN its date — the run's whole public identity. */
  runNo: number;
  stops: AnonymousRunStop[];
  sets: number;
  revenueSen: number;
  overCapacity: boolean;
  windowViolations: number;
  returnTime: string | null;
  totalDistanceMetres: number | null;
  routeReason: string | null;
  ungeocoded: string[];
  /** Opaque vehicle-slot uuid — Apply plumbing ONLY (a stop needs a trip and a
   *  trip keys on (lorry, date)). Never rendered; named by Last Mile. */
  vehicleSlotId: string;
};

/** Fold the engine's crewed trips into anonymous per-date runs. Runs number
 *  1..n within each date (zone A->Z, then engine order, so the numbering is
 *  deterministic); the stop rows use the computed sequence when there is one,
 *  else the packed order. All crew/vehicle identity is dropped. */
export function foldToAnonymousRuns(trips: AssignedTrip[]): AnonymousRun[] {
  const ordered = [...trips].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.group.localeCompare(b.group) || a.key.localeCompare(b.key)),
  );
  const nextNoByDate = new Map<string, number>();
  return ordered.map((t) => {
    const runNo = (nextNoByDate.get(t.date) ?? 0) + 1;
    nextNoByDate.set(t.date, runNo);
    const seq = t.sequence;
    const stops: AnonymousRunStop[] = seq
      ? seq.sequence.map((s) => {
          const info = t.stops.find((st) => st.ref === s.ref);
          return {
            ref: s.ref, order: s.order,
            debtorName: info?.debtorName ?? null,
            buildingType: info?.buildingType ?? null,
            arrivalTime: s.arrivalTime, finishTime: s.finishTime,
            earliestTime: s.earliestTime, latestTime: s.latestTime,
            windowViolated: s.windowViolated,
            etaOffsetS: s.etaOffsetS, legDistanceM: s.legDistanceM, legDurationS: s.legDurationS,
          };
        })
      : t.stops.map((s, i) => ({
          ref: s.ref, order: i + 1,
          debtorName: s.debtorName, buildingType: s.buildingType,
          arrivalTime: null, finishTime: null,
          earliestTime: s.earliestTime, latestTime: s.latestTime,
          windowViolated: false,
          etaOffsetS: null, legDistanceM: null, legDurationS: null,
        }));
    return {
      key: t.key,
      date: t.date,
      group: t.group,
      runNo,
      stops,
      sets: t.sets,
      revenueSen: t.revenueSen,
      overCapacity: t.overCeiling,
      windowViolations: seq?.windowViolations ?? 0,
      returnTime: seq?.returnTime ?? null,
      totalDistanceMetres: seq?.totalDistanceMetres ?? null,
      routeReason: t.routeReason,
      ungeocoded: t.ungeocoded,
      vehicleSlotId: t.lorryId,
    };
  });
}

/** The identity fields the Time page must never carry — used by the pin test
 *  and kept beside the fold so the list cannot drift from it. */
export const FORBIDDEN_IDENTITY_KEYS = [
  'plate', 'lorryId', 'driverId', 'driverName', 'helperId', 'helperName',
] as const;

/* ── The estimated delivery WINDOW (owner addendum 2026-08-08: "看 Google API
   预计多少时间,再加上我们给送货的 buffer 和 installation time,就会知道下一单
   几点到几点"). The engine already folds INSTALLATION time into each stop's
   clock — finishTime = arrival + the residence-rule service duration
   (scm.delivery_residence_rules per building type, 90-min default) — so the
   estimated window is arrival → finish PLUS a delivery/unload buffer. No
   unload-buffer config exists anywhere in the repo, so it is this one
   documented constant (owner-tunable here; promote it to per-company config if
   he ever wants it per region). Display-only: what persists is still the
   stop's etaOffsetS. */
export const DELIVERY_UNLOAD_BUFFER_MIN = 15;

/** "HH:MM" + minutes → "HH:MM" (day-wrapped — a late run past midnight shows
 *  00:xx rather than 24:xx). null in → null out, never a guessed clock. */
export function addMinutesToClock(hhmm: string | null, minutes: number): string | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const total = ((Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The stop's estimated delivery window, "09:40–10:25", or null when the run
 *  has no computed route (no geocoded depot / no maps key) — the caller shows
 *  a dash and the page says WHY loudly, never a fabricated range. */
export function estWindowOf(
  stop: Pick<AnonymousRunStop, 'arrivalTime' | 'finishTime'>,
  bufferMin: number = DELIVERY_UNLOAD_BUFFER_MIN,
): string | null {
  if (!stop.arrivalTime || !stop.finishTime) return null;
  const end = addMinutesToClock(stop.finishTime, bufferMin);
  return end ? `${stop.arrivalTime}–${end}` : null;
}
