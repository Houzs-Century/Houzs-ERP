// A lorry's driven path for one day, along the roads (owner 2026-11-10). The server
// joins the tracker's 5-min fixes by road where Google can, straight where it cannot.
import { useQueries, useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type MapPoint = { lat: number; lng: number };
export type LorryRoadTrack = { date: string; path: MapPoint[]; chunks: number; roadChunks: number };

const POLL_MS = 5 * 60_000;
const road = (lorryId: string, date: string) => ({
  queryKey: ['lorries', 'track-road', lorryId, date],
  queryFn: () => authedFetch<LorryRoadTrack>(`/lorries/${encodeURIComponent(lorryId)}/track/road?date=${date}`),
  refetchInterval: POLL_MS,
});

export function useLorryRoadTrack(lorryId: string, date: string) {
  return useQuery({ ...road(lorryId, date), enabled: !!lorryId });
}

export function useLorryRoadTracks(lorryIds: readonly string[], date: string) {
  return useQueries({ queries: lorryIds.map((id) => road(id, date)) });
}

/** The road path when the server sent one, else the fixes joined straight. PURE. */
export function drivenPath(roadTrack: LorryRoadTrack | undefined, fixes: readonly MapPoint[]): { path: MapPoint[]; byRoad: boolean } {
  if (roadTrack && roadTrack.path.length >= 2) return { path: roadTrack.path, byRoad: roadTrack.roadChunks > 0 };
  return { path: fixes.map(({ lat, lng }) => ({ lat, lng })), byRoad: false };
}
