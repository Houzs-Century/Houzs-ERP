// ----------------------------------------------------------------------------
// trip-locations-queries.ts — TMS Phase 4 LIVE GPS tracking, the ONE shared
// logic layer for both surfaces (repo rule: desktop and mobile are one product).
//
//   DRIVER CAPTURE (mobile)     → useMyActiveTrip + useTripLocationCapture:
//        watchPosition while the driver's trip is IN_PROGRESS, POST every ~25s.
//   DISPATCHER READ (desktop)   → useTripLatestLocations / useActiveTripLocations:
//        POLL the latest position per driver (no websockets — polling is this
//        repo's realtime mechanism).
//
// Same pattern as the sibling vendor query libs: TanStack Query + authedFetch,
// rows snake_case as the API emits them.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { hasBackgroundLocation, startBackgroundWatch } from './native-location';
import type { TripRow } from './trips-queries';

/* Polling cadence. The driver posts every DRIVER_POST_MS (~25s, inside the
   20-30s Phase-4 window); the dispatcher map polls DISPATCH_POLL_MS. Kept a
   touch under the post cadence so a fresh ping is on-screen within one cycle.
   Matches the trips list staleTime (15s) — the module's standard polling beat. */
export const DRIVER_POST_MS = 25_000;
export const DISPATCH_POLL_MS = 15_000;

/* One driver's latest position, as GET …/locations/latest emits it (camelCase —
   shaped by the backend's latestPerDriver, not raw pg columns). */
export type TripLocation = {
  tripId: string;
  driverId: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
  receivedAt: string;
};

/* ── DISPATCHER READS ──────────────────────────────────────────────────────*/

/* Latest position per driver on ONE trip. Polls only while `enabled` (the
   dispatcher has an IN_PROGRESS trip open) so a closed drawer bills nothing. */
export function useTripLatestLocations(tripId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['trip-locations', 'latest', tripId ?? ''],
    queryFn: () => authedFetch<{ locations: TripLocation[] }>(`/trips/${tripId}/locations/latest`),
    enabled: !!tripId && enabled,
    staleTime: DISPATCH_POLL_MS,
    refetchInterval: enabled ? DISPATCH_POLL_MS : false,
  });
}

/* Latest position per driver across EVERY active trip — the board-level overview
   map. Polls only while `enabled`. */
export function useActiveTripLocations(enabled = true) {
  return useQuery({
    queryKey: ['trip-locations', 'active'],
    queryFn: () => authedFetch<{ locations: TripLocation[] }>(`/trips/active/locations`),
    enabled,
    staleTime: DISPATCH_POLL_MS,
    refetchInterval: enabled ? DISPATCH_POLL_MS : false,
  });
}

/* ── DRIVER CAPTURE ────────────────────────────────────────────────────────*/

/* The driver's own ACTIVE (IN_PROGRESS) trip, or null. The trips list is already
   row-scoped to a Driver/Helper's own trips on the backend, so this returns only
   trips the caller is crewed on. First IN_PROGRESS trip wins (a driver runs one
   lorry-day at a time). Cheap poll so a trip started by the dispatcher becomes
   trackable without a manual refresh. */
export function useMyActiveTrip() {
  const q = useQuery({
    queryKey: ['scm-trips', '', '', 'IN_PROGRESS'],
    queryFn: () => authedFetch<{ trips: TripRow[] }>(`/trips?status=IN_PROGRESS`),
    staleTime: DISPATCH_POLL_MS,
    refetchInterval: DISPATCH_POLL_MS,
  });
  const activeTrip = (q.data?.trips ?? []).find((t) => String(t.status).toUpperCase() === 'IN_PROGRESS') ?? null;
  return { ...q, activeTrip };
}

/* POST one GPS ping to a trip. The backend range-validates, rate-caps and only
   accepts for an IN_PROGRESS trip; a rejected ping resolves with accepted:false
   rather than throwing, so a single bad fix never breaks the capture loop. */
export function usePostTripLocation() {
  return useMutation({
    mutationFn: (p: { tripId: string; lat: number; lng: number; accuracy?: number | null; recorded_at?: string; simulated?: boolean }) =>
      authedFetch<{ ok: boolean; accepted?: boolean; reason?: string }>(`/trips/${p.tripId}/location`, {
        method: 'POST',
        /* `simulated` only ever arrives from the native watcher — a browser has
           no way to tell a mock-location app from a real fix. See mig 0250. */
        body: JSON.stringify({ lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, recorded_at: p.recorded_at, simulated: p.simulated }),
      }),
  });
}

export type CaptureStatus =
  | 'off'          // not enabled / no active trip — NOT tracking (the privacy default)
  | 'requesting'   // asked the browser for permission, waiting
  | 'tracking'     // permission granted, pings flowing
  | 'denied'       // user declined geolocation
  | 'unavailable'  // no Geolocation API in this browser
  | 'error';       // a position error other than denial (timeout / signal lost)

export type CaptureState = {
  status: CaptureStatus;
  lastSentAt: number | null;   // epoch ms of the last ACCEPTED post
  lastError: string | null;
};

/* useTripLocationCapture — the shared driver-capture engine. While `enabled` and
   a `tripId` is present, watch the device position and POST it every
   DRIVER_POST_MS. Degrades gracefully: denial → status 'denied' (no crash, no
   retry storm), no API → 'unavailable'. STOPS when the trip is absent, capture
   is disabled, or the page is backgrounded/hidden (Page Visibility) — so there
   is NO background or persistent tracking, only an open active-delivery page.
   Presentation is the caller's; this hook is surface-agnostic (mobile today,
   reusable on any driver view). */
export function useTripLocationCapture(opts: { tripId: string | null; enabled: boolean; postMs?: number }): CaptureState {
  const { tripId, enabled } = opts;
  const postMs = opts.postMs ?? DRIVER_POST_MS;
  const post = usePostTripLocation();

  const [state, setState] = useState<CaptureState>({ status: 'off', lastSentAt: null, lastError: null });

  // Refs so the effect body reads the latest without re-subscribing the watch.
  const latestFix = useRef<GeolocationPosition | null>(null);
  const lastPostAt = useRef<number>(0);
  const postRef = useRef(post);
  postRef.current = post;

  const sendLatest = useCallback((tid: string) => {
    const fix = latestFix.current;
    if (!fix) return;
    const now = Date.now();
    if (now - lastPostAt.current < postMs) return;
    lastPostAt.current = now;
    postRef.current.mutate(
      {
        tripId: tid,
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        accuracy: Number.isFinite(fix.coords.accuracy) ? fix.coords.accuracy : null,
        recorded_at: new Date(fix.timestamp || now).toISOString(),
      },
      {
        onSuccess: (r) => {
          if (r?.accepted) setState((s) => ({ ...s, status: 'tracking', lastSentAt: Date.now(), lastError: null }));
        },
        // A failed post is not fatal — the next tick retries. Surface the reason.
        onError: (e) => setState((s) => ({ ...s, lastError: e instanceof Error ? e.message : 'post failed' })),
      },
    );
  }, [postMs]);

  useEffect(() => {
    // Not tracking: enabled off, no trip, or SSR/no-API. Report and bail.
    if (!enabled || !tripId) { setState({ status: 'off', lastSentAt: null, lastError: null }); return; }

    /* NATIVE PATH (the app). The web branch below stops on Page Visibility,
       which is correct for a browser tab and is exactly the hole this replaces:
       a driver who pockets their phone vanishes from the map. The native
       watcher keeps running with the screen locked, so there is NO visibility
       listener here and no interval heartbeat — the plugin's distanceFilter
       decides when a fix is worth sending, which is also what keeps the battery
       cost low enough that drivers leave it on.

       Everything downstream is unchanged: the same mutation, the same endpoint,
       the same accepted/rejected handling. Only the source of the fix differs. */
    if (hasBackgroundLocation()) {
      setState((st) => ({ ...st, status: 'requesting' }));
      const handle = startBackgroundWatch({
        distanceFilterM: 30,
        onError: (message) => setState((st) => ({ ...st, status: 'error', lastError: message })),
        onFix: (fix) => {
          postRef.current.mutate(
            {
              tripId,
              lat: fix.latitude,
              lng: fix.longitude,
              accuracy: Number.isFinite(fix.accuracy) ? fix.accuracy : null,
              recorded_at: new Date(fix.time ?? Date.now()).toISOString(),
              /* A mock-location app reports a perfect fix from anywhere. The
                 plugin can tell; a browser cannot. Recorded rather than
                 rejected — refusing it silently would leave a gap that looks
                 like lost signal, and the point is to be able to SEE it. */
              simulated: fix.simulated === true,
            },
            {
              onSuccess: (r) => {
                if (r?.accepted) setState((st) => ({ ...st, status: 'tracking', lastSentAt: Date.now(), lastError: null }));
              },
              onError: (e) => setState((st) => ({ ...st, lastError: e instanceof Error ? e.message : 'post failed' })),
            },
          );
        },
      });
      return () => handle.stop();
    }

    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setState({ status: 'unavailable', lastSentAt: null, lastError: null });
      return;
    }

    let watchId: number | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const start = () => {
      if (stopped || watchId != null) return;
      setState((s) => ({ ...s, status: s.status === 'tracking' ? 'tracking' : 'requesting' }));
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          latestFix.current = pos;
          setState((s) => ({ ...s, status: 'tracking', lastError: null }));
          sendLatest(tripId);
        },
        (err) => {
          // 1 = PERMISSION_DENIED — stop for good, no retry storm.
          if (err.code === 1) {
            setState({ status: 'denied', lastSentAt: null, lastError: err.message });
            stop();
          } else {
            setState((s) => ({ ...s, status: 'error', lastError: err.message }));
          }
        },
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
      );
      // Steady heartbeat: watchPosition may stay quiet when the driver is parked,
      // but a stopped lorry is still a valid "last seen" — repost the last fix.
      interval = setInterval(() => sendLatest(tripId), postMs);
    };

    const stop = () => {
      if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (interval != null) { clearInterval(interval); interval = null; }
    };

    // Page Visibility: only track while the page is actually open in front. A
    // backgrounded tab must not keep reporting a driver's location.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else if (!stopped) start();
    };

    if (typeof document === 'undefined' || document.visibilityState === 'visible') start();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
    // sendLatest is stable per postMs; tripId/enabled drive re-subscription.
  }, [tripId, enabled, postMs, sendLatest]);

  return state;
}
