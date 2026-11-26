
export interface ProposeStopInput {
  ref: string;
  serviceMinutes: number;
  earliestMin: number | null;
  latestMin: number | null;
}

export interface ProposedStop {
  ref: string;
  order: number;
  travelMinutes: number;
  distanceMetres: number;
  arrivalMin: number;
  waitMinutes: number;
  startServiceMin: number;
  finishMin: number;
  serviceMinutes: number;
  earliestMin: number | null;
  latestMin: number | null;
  windowViolated: boolean;
}

export interface ProposeRouteResult {
  ok: boolean;
  reason?: string;
  sequence: ProposedStop[];
  departMin: number;
  totalTravelMinutes: number;
  totalDistanceMetres: number;
  returnMin: number;
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
  travelSeconds: number[][];
  distanceMetres: number[][];
}): ProposeRouteResult {
  const { departMin, stops, travelSeconds, distanceMetres } = input;
  const n = stops.length;

  if (n === 0) {
    return { ok: false, reason: 'no stops', sequence: [], departMin,
      totalTravelMinutes: 0, totalDistanceMetres: 0, returnMin: departMin, windowViolations: 0 };
  }

  const remaining = new Set<number>(stops.map((_, i) => i));
  const sequence: ProposedStop[] = [];

  let clock = departMin;
  let currentMatrixIdx = 0;
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
      const start = s.earliestMin != null ? Math.max(arrival, s.earliestMin) : arrival;
      const feasible = s.latestMin == null || start <= s.latestMin;

      if (best === null) {
        best = { stopIdx, travelMin, distM, arrival, start, feasible };
        continue;
      }
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

function deadlineOf(s: ProposeStopInput): number {
  return s.latestMin == null ? Number.POSITIVE_INFINITY : s.latestMin;
}


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
