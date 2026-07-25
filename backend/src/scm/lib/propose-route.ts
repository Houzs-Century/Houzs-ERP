// ---------------------------------------------------------------------------
// propose-route.ts — the "Propose times + route" SEQUENCER. PURE, unit-tested.
//
// Given a depot, a set of delivery stops (each with a SERVICE DURATION and an
// optional delivery TIME WINDOW from scm.delivery_residence_rules), and a
// point-to-point TRAVEL matrix (from Google Distance Matrix via maps.ts), work
// out a sensible visit order and the per-stop arrival / start / finish clock
// times. This is the smart version of Phase 2's simple date proposal.
//
// The rules, exactly:
//  - EARLIEST is a HARD constraint: a stop is NEVER serviced before its earliest
//    delivery time. If the lorry arrives early it WAITS (waitMinutes) until the
//    window opens — a condo with an 10:00 earliest is never serviced at 09:30.
//  - LATEST is the closing bound: the sequencer prefers an order where every stop
//    can BEGIN service at or before its latest time. When no remaining stop can,
//    it still emits the least-late one and flags windowViolated so the dispatcher
//    sees the conflict rather than a silently impossible plan.
//  - SERVICE DURATION is summed into the clock: finish = startService + service,
//    and the next leg departs at finish. Ten 90-minute stops cannot fit a 2-hour
//    afternoon, and the emitted finish times show that.
//  - TRAVEL time orders the rest: among feasible candidates the nearest (earliest
//    achievable start) is chosen — a greedy nearest-neighbour under time windows.
//
// Everything is minutes-from-midnight for clock maths; travel/distance come in
// as the matrices maps.ts returns (seconds / metres). Index 0 of the matrices is
// the DEPOT; indices 1..N are stops in the INPUT order.
// ---------------------------------------------------------------------------

export interface ProposeStopInput {
  ref: string;
  /** Minutes to unload + carry up at this stop (residence rule). */
  serviceMinutes: number;
  /** Delivery window open, minutes from midnight; null = no lower bound. */
  earliestMin: number | null;
  /** Delivery window close, minutes from midnight; null = no upper bound. */
  latestMin: number | null;
}

export interface ProposedStop {
  ref: string;
  /** 1-based position in the proposed sequence. */
  order: number;
  /** Drive minutes on the leg that ARRIVES at this stop. */
  travelMinutes: number;
  /** Drive metres on that arriving leg. */
  distanceMetres: number;
  /** Clock minute the lorry arrives (before any wait). */
  arrivalMin: number;
  /** Minutes waited for the window to open (0 when not early). */
  waitMinutes: number;
  /** Clock minute service begins (= max(arrival, earliest)). */
  startServiceMin: number;
  /** Clock minute service finishes (= startService + service). */
  finishMin: number;
  serviceMinutes: number;
  earliestMin: number | null;
  latestMin: number | null;
  /** True when service could not begin at or before latestMin. */
  windowViolated: boolean;
}

export interface ProposeRouteResult {
  ok: boolean;
  reason?: string;
  sequence: ProposedStop[];
  /** Depart clock minute used (the trip leaves the depot). */
  departMin: number;
  /** Σ travel minutes over every leg, INCLUDING the return to the depot. */
  totalTravelMinutes: number;
  /** Σ distance metres over every leg, including the return to the depot. */
  totalDistanceMetres: number;
  /** Clock minute the lorry is back at the depot (last finish + return leg). */
  returnMin: number;
  /** How many stops could not meet their latest bound. */
  windowViolations: number;
}

function secToMin(sec: number): number {
  return Math.round((Number(sec) || 0) / 60);
}

/**
 * Sequence the stops. PURE — no I/O, fully deterministic, so the whole rule set
 * is unit-testable against a mocked matrix + residence rules.
 */
export function proposeRoute(input: {
  departMin: number;
  stops: ProposeStopInput[];
  /** (N+1)x(N+1) drive seconds; index 0 = depot, 1..N = stops in input order. */
  travelSeconds: number[][];
  /** (N+1)x(N+1) drive metres; same indexing. */
  distanceMetres: number[][];
}): ProposeRouteResult {
  const { departMin, stops, travelSeconds, distanceMetres } = input;
  const n = stops.length;

  if (n === 0) {
    return { ok: false, reason: 'no stops', sequence: [], departMin,
      totalTravelMinutes: 0, totalDistanceMetres: 0, returnMin: departMin, windowViolations: 0 };
  }

  // Matrix index of each stop: input order i -> matrix index i+1 (depot is 0).
  const remaining = new Set<number>(stops.map((_, i) => i));
  const sequence: ProposedStop[] = [];

  let clock = departMin;
  let currentMatrixIdx = 0; // start at the depot
  let totalTravelMin = 0;
  let totalDistanceM = 0;
  let windowViolations = 0;

  while (remaining.size > 0) {
    let best: {
      stopIdx: number; travelMin: number; distM: number;
      arrival: number; start: number; feasible: boolean;
    } | null = null;

    for (const stopIdx of remaining) {
      const s = stops[stopIdx];
      const matrixIdx = stopIdx + 1;
      const travelMin = secToMin(travelSeconds[currentMatrixIdx]?.[matrixIdx] ?? 0);
      const distM = Number(distanceMetres[currentMatrixIdx]?.[matrixIdx] ?? 0) || 0;
      const arrival = clock + travelMin;
      // EARLIEST is hard: never start before the window opens — wait instead.
      const start = s.earliestMin != null ? Math.max(arrival, s.earliestMin) : arrival;
      const feasible = s.latestMin == null || start <= s.latestMin;

      if (best === null) {
        best = { stopIdx, travelMin, distM, arrival, start, feasible };
        continue;
      }
      // Prefer a feasible candidate over an infeasible one; within the same
      // feasibility class serve the EARLIER-CLOSING window first (earliest-
      // deadline-first, so a tight window is front-loaded before it closes),
      // tie-broken by the earliest achievable start — which, when deadlines are
      // equal or absent, degrades to plain nearest-neighbour on travel time.
      let better: boolean;
      if (best.feasible !== feasible) {
        better = feasible;
      } else {
        const dl = deadlineOf(s);
        const bestDl = deadlineOf(stops[best.stopIdx]);
        if (dl !== bestDl) better = dl < bestDl;
        else if (start !== best.start) better = start < best.start;
        else better = false;
      }
      if (better) best = { stopIdx, travelMin, distM, arrival, start, feasible };
    }

    const chosen = best!;
    const s = stops[chosen.stopIdx];
    const finish = chosen.start + Math.max(0, s.serviceMinutes);
    const violated = s.latestMin != null && chosen.start > s.latestMin;
    if (violated) windowViolations += 1;

    sequence.push({
      ref: s.ref,
      order: sequence.length + 1,
      travelMinutes: chosen.travelMin,
      distanceMetres: chosen.distM,
      arrivalMin: chosen.arrival,
      waitMinutes: Math.max(0, chosen.start - chosen.arrival),
      startServiceMin: chosen.start,
      finishMin: finish,
      serviceMinutes: Math.max(0, s.serviceMinutes),
      earliestMin: s.earliestMin,
      latestMin: s.latestMin,
      windowViolated: violated,
    });

    totalTravelMin += chosen.travelMin;
    totalDistanceM += chosen.distM;
    clock = finish;
    currentMatrixIdx = chosen.stopIdx + 1;
    remaining.delete(chosen.stopIdx);
  }

  // Return leg to the depot (from the last stop). Counted in totals; no stop
  // arrives on it. A round trip is the delivery reality (the lorry comes home).
  const backTravelMin = secToMin(travelSeconds[currentMatrixIdx]?.[0] ?? 0);
  const backDistM = Number(distanceMetres[currentMatrixIdx]?.[0] ?? 0) || 0;
  totalTravelMin += backTravelMin;
  totalDistanceM += backDistM;

  return {
    ok: true,
    sequence,
    departMin,
    totalTravelMinutes: totalTravelMin,
    totalDistanceMetres: totalDistanceM,
    returnMin: clock + backTravelMin,
    windowViolations,
  };
}

/** A stop's effective closing deadline for tie-breaking (no bound = +infinity). */
function deadlineOf(s: ProposeStopInput): number {
  return s.latestMin == null ? Number.POSITIVE_INFINITY : s.latestMin;
}

// ── Clock helpers (shared shape with the frontend recompute) ────────────────

/** "HH:MM" (24h) -> minutes from midnight, or null. PURE. */
export function timeToMinutes(hhmm: string | null | undefined): number | null {
  if (hhmm == null || hhmm === '') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

/** minutes from midnight -> "HH:MM" (24h), clamped to a single day. PURE. */
export function minutesToTime(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min)) return null;
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
