// ----------------------------------------------------------------------------
// propose-schedule-queries.ts — the frontend side of the Phase 3 "Propose times
// + route" smart scheduler. One mutation hits POST /trips/propose-schedule
// (which geocodes cache-first + makes ONE Distance Matrix call), and a PURE
// forward-pass recomputes the per-stop times when the dispatcher drags the
// sequence into a new order — WITHOUT another Google call. The travel matrix the
// backend returns is reused for every reorder, so a drag costs nothing.
// ----------------------------------------------------------------------------

import { useMutation } from "@tanstack/react-query";
import { authedFetch } from "./authed-fetch";

/** One stop as the backend geocoded it (input order = matrix index i+1). */
export type ProposeStop = {
  ref: string;                 // SO doc_no
  debtorName: string | null;
  address: string;
  buildingType: string | null;
  lat: number;
  lng: number;
  serviceMinutes: number;
  earliestTime: string | null; // HH:MM
  latestTime: string | null;   // HH:MM
};

/** One stop in the proposed (or recomputed) sequence, with clock times. */
export type ProposedStop = {
  ref: string;
  order: number;
  travelMinutes: number;
  distanceMetres: number;
  arrivalTime: string | null;      // HH:MM
  waitMinutes: number;
  startServiceTime: string | null; // HH:MM
  finishTime: string | null;       // HH:MM
  serviceMinutes: number;
  earliestTime: string | null;
  latestTime: string | null;
  windowViolated: boolean;
};

export type ProposedRoute = {
  sequence: ProposedStop[];
  totalTravelMinutes: number;
  totalDistanceMetres: number;
  returnTime: string | null;
  windowViolations: number;
};

export type ProposeScheduleResponse = {
  configured: boolean;
  ok: boolean;
  reason?: string;
  departTime: string;              // HH:MM
  depot: { warehouseId: string | null; address: string; lat: number; lng: number } | null;
  stops: ProposeStop[];            // geocoded, input order
  ungeocoded: Array<{ ref: string; debtorName: string | null; address: string; reason: string }>;
  travelSeconds: number[][];       // (K+1)x(K+1), index 0 = depot
  distanceMetres: number[][];
  proposed: ProposedRoute | null;
};

export type ProposeScheduleVars = {
  soDocNos: string[];
  depotWarehouseId?: string | null;
  departTime?: string;             // HH:MM
};

export function useProposeSchedule() {
  return useMutation<ProposeScheduleResponse, Error, ProposeScheduleVars>({
    mutationFn: (vars) =>
      authedFetch<ProposeScheduleResponse>(`/trips/propose-schedule`, {
        method: "POST",
        body: JSON.stringify(vars),
      }),
  });
}

// ── Pure clock helpers (mirror backend propose-route.ts) ────────────────────

/** "HH:MM" -> minutes from midnight, or null. PURE. */
export function timeToMinutes(hhmm: string | null | undefined): number | null {
  if (hhmm == null || hhmm === "") return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

/** minutes from midnight -> "HH:MM", clamped to one day. PURE. */
export function minutesToTime(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min)) return null;
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Recompute per-stop times for a GIVEN order (after a drag). PURE — no Google
 * call: it reuses the backend's returned travel matrix. The ORDER is fixed by
 * the caller (the drag result); this only re-runs the forward clock pass
 * (arrival / wait / start / finish), the EARLIEST-is-hard wait, and the totals
 * incl. the return leg — the same maths the backend proposer uses.
 *
 * matrixIndexOf maps a stop ref to its column in travelSeconds (input order i ->
 * i+1; depot is 0).
 */
export function recomputeSequenceTimes(
  orderedRefs: string[],
  stopByRef: Map<string, ProposeStop>,
  matrixIndexOf: Map<string, number>,
  travelSeconds: number[][],
  distanceMetres: number[][],
  departMin: number,
): ProposedRoute {
  const secToMin = (s: number) => Math.round((Number(s) || 0) / 60);
  let clock = departMin;
  let currentIdx = 0; // depot
  let totalTravel = 0;
  let totalDistance = 0;
  let windowViolations = 0;
  const sequence: ProposedStop[] = [];

  orderedRefs.forEach((ref, i) => {
    const s = stopByRef.get(ref);
    const mIdx = matrixIndexOf.get(ref) ?? 0;
    const service = Math.max(0, s?.serviceMinutes ?? 0);
    const earliestMin = timeToMinutes(s?.earliestTime ?? null);
    const latestMin = timeToMinutes(s?.latestTime ?? null);
    const travelMin = secToMin(travelSeconds[currentIdx]?.[mIdx] ?? 0);
    const distM = Number(distanceMetres[currentIdx]?.[mIdx] ?? 0) || 0;
    const arrival = clock + travelMin;
    const start = earliestMin != null ? Math.max(arrival, earliestMin) : arrival;
    const finish = start + service;
    const violated = latestMin != null && start > latestMin;
    if (violated) windowViolations += 1;

    sequence.push({
      ref,
      order: i + 1,
      travelMinutes: travelMin,
      distanceMetres: distM,
      arrivalTime: minutesToTime(arrival),
      waitMinutes: Math.max(0, start - arrival),
      startServiceTime: minutesToTime(start),
      finishTime: minutesToTime(finish),
      serviceMinutes: service,
      earliestTime: s?.earliestTime ?? null,
      latestTime: s?.latestTime ?? null,
      windowViolated: violated,
    });

    totalTravel += travelMin;
    totalDistance += distM;
    clock = finish;
    currentIdx = mIdx;
  });

  const back = secToMin(travelSeconds[currentIdx]?.[0] ?? 0);
  totalTravel += back;
  totalDistance += Number(distanceMetres[currentIdx]?.[0] ?? 0) || 0;

  return {
    sequence,
    totalTravelMinutes: totalTravel,
    totalDistanceMetres: totalDistance,
    returnTime: minutesToTime(clock + back),
    windowViolations,
  };
}
