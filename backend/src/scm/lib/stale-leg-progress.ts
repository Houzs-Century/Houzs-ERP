
export type StaleLegProgressReset = {
  match: { source_type: string; source_id: string; leg: string };
  excludeTripId: string;
  set: {
    departed_at: null; departed_by: null;
    arrived_at: null; arrived_by: null;
    completed_at: null; completed_by: null;
    pod_photo_keys: string[]; pod_notes: null;
    pod_lat: null; pod_lng: null; pod_accuracy_m: null; pod_located_at: null;
    trip_id: string;
  };
};

export function staleLegProgressReset(
  sourceType: 'assr' | 'dp',
  sourceId: number | string,
  leg: string,
  newTripId: string,
): StaleLegProgressReset {
  return {
    match: { source_type: sourceType, source_id: String(sourceId), leg },
    excludeTripId: newTripId,
    set: {
      departed_at: null, departed_by: null,
      arrived_at: null, arrived_by: null,
      completed_at: null, completed_by: null,
      pod_photo_keys: [], pod_notes: null,
      pod_lat: null, pod_lng: null, pod_accuracy_m: null, pod_located_at: null,
      trip_id: newTripId,
    },
  };
}
