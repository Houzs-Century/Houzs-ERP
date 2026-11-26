
import {
  proposeRoute,
  minutesToTime,
  type ProposeStopInput,
} from './propose-route';

export interface SequenceStopInput {
  ref: string;
  serviceMinutes: number;
  earliestMin: number | null;
  latestMin: number | null;
}

export interface SequencedStop {
  ref: string;
  order: number;
  travelMinutes: number;
  distanceMetres: number;
  arrivalTime: string | null;
  waitMinutes: number;
  startServiceTime: string | null;
  finishTime: string | null;
  serviceMinutes: number;
  earliestTime: string | null;
  latestTime: string | null;
  windowViolated: boolean;
  etaOffsetS: number;
  legDistanceM: number;
  legDurationS: number;
}

export interface SequenceProposal {
  departTime: string | null;
  sequence: SequencedStop[];
  totalTravelMinutes: number;
  totalDistanceMetres: number;
  returnTime: string | null;
  windowViolations: number;
}

/**
 * Sequence one trip's stops and shape the proposal. PURE. `departMin` is minutes
 * from midnight; the matrices are (N+1)x(N+1) with index 0 = depot, 1..N = stops
 * in input order (exactly what maps.ts / propose-route.ts expect).
 */
export function buildSequenceProposal(input: {
  departMin: number;
  stops: SequenceStopInput[];
  travelSeconds: number[][];
  distanceMetres: number[][];
}): SequenceProposal {
  const { departMin, stops, travelSeconds, distanceMetres } = input;

  const stopInputs: ProposeStopInput[] = stops.map((s) => ({
    ref: s.ref,
    serviceMinutes: s.serviceMinutes,
    earliestMin: s.earliestMin,
    latestMin: s.latestMin,
  }));

  const route = proposeRoute({ departMin, stops: stopInputs, travelSeconds, distanceMetres });

  const sequence: SequencedStop[] = route.sequence.map((st) => ({
    ref: st.ref,
    order: st.order,
    travelMinutes: st.travelMinutes,
    distanceMetres: st.distanceMetres,
    arrivalTime: minutesToTime(st.arrivalMin),
    waitMinutes: st.waitMinutes,
    startServiceTime: minutesToTime(st.startServiceMin),
    finishTime: minutesToTime(st.finishMin),
    serviceMinutes: st.serviceMinutes,
    earliestTime: minutesToTime(st.earliestMin),
    latestTime: minutesToTime(st.latestMin),
    windowViolated: st.windowViolated,
    etaOffsetS: Math.max(0, Math.round((st.arrivalMin - departMin) * 60)),
    legDistanceM: Math.max(0, Math.round(st.distanceMetres)),
    legDurationS: Math.max(0, Math.round(st.travelMinutes * 60)),
  }));

  return {
    departTime: minutesToTime(departMin),
    sequence,
    totalTravelMinutes: route.totalTravelMinutes,
    totalDistanceMetres: route.totalDistanceMetres,
    returnTime: minutesToTime(route.returnMin),
    windowViolations: route.windowViolations,
  };
}
