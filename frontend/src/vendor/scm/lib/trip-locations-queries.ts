
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { hasBackgroundLocation, startBackgroundWatch } from './native-location';
import type { TripRow } from './trips-queries';

export const DRIVER_POST_MS = 25_000;
export const DISPATCH_POLL_MS = 15_000;

export type TripLocation = {
  tripId: string;
  driverId: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
  receivedAt: string;
};


export function useTripLatestLocations(tripId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['trip-locations', 'latest', tripId ?? ''],
    queryFn: () => authedFetch<{ locations: TripLocation[] }>(`/trips/${tripId}/locations/latest`),
    enabled: !!tripId && enabled,
    staleTime: DISPATCH_POLL_MS,
    refetchInterval: enabled ? DISPATCH_POLL_MS : false,
  });
}

export function useActiveTripLocations(enabled = true) {
  return useQuery({
    queryKey: ['trip-locations', 'active'],
    queryFn: () => authedFetch<{ locations: TripLocation[] }>(`/trips/active/locations`),
    enabled,
    staleTime: DISPATCH_POLL_MS,
    refetchInterval: enabled ? DISPATCH_POLL_MS : false,
  });
}


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

export function usePostTripLocation() {
  return useMutation({
    /* silent-mutation-ok: the only consumer is useTripLocationCapture below, and
       BOTH of its .mutate call sites (the web watchPosition path and the native
       background-watch path) pass a per-call onError that puts the message into
       CaptureState.lastError. Deliberately NOT writeFailed: this fires every
       ~25s per driver, so a dialog per refused ping would bury the driver in
       modals while they are on the road. */
    mutationFn: (p: { tripId: string; lat: number; lng: number; accuracy?: number | null; recorded_at?: string; simulated?: boolean }) =>
      authedFetch<{ ok: boolean; accepted?: boolean; reason?: string }>(`/trips/${p.tripId}/location`, {
        method: 'POST',
        body: JSON.stringify({ lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, recorded_at: p.recorded_at, simulated: p.simulated }),
      }),
  });
}

export type CaptureStatus =
  | 'off'
  | 'requesting'
  | 'tracking'
  | 'denied'
  | 'unavailable'
  | 'error';

export type CaptureState = {
  status: CaptureStatus;
  lastSentAt: number | null;
  lastError: string | null;
};

export function useTripLocationCapture(opts: { tripId: string | null; enabled: boolean; postMs?: number }): CaptureState {
  const { tripId, enabled } = opts;
  const postMs = opts.postMs ?? DRIVER_POST_MS;
  const post = usePostTripLocation();

  const [state, setState] = useState<CaptureState>({ status: 'off', lastSentAt: null, lastError: null });

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
        onError: (e) => setState((s) => ({ ...s, lastError: e instanceof Error ? e.message : 'post failed' })),
      },
    );
  }, [postMs]);

  useEffect(() => {
    if (!enabled || !tripId) { setState({ status: 'off', lastSentAt: null, lastError: null }); return; }

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
          if (err.code === 1) {
            setState({ status: 'denied', lastSentAt: null, lastError: err.message });
            stop();
          } else {
            setState((s) => ({ ...s, status: 'error', lastError: err.message }));
          }
        },
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
      );
      interval = setInterval(() => sendLatest(tripId), postMs);
    };

    const stop = () => {
      if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (interval != null) { clearInterval(interval); interval = null; }
    };

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
  }, [tripId, enabled, postMs, sendLatest]);

  return state;
}
