import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ActiveMember, PresenceResponse } from "../types";

/* 60s, was 30s (perf 2026-07-19). Presence rides on EVERY page — prod showed
   GET /api/presence up to ~495ms and 3 requests inside one owner session
   window (initial + two 30s ticks). Halving the cadence halves that standing
   tax app-wide. The backend's ACTIVE_WINDOW_SECONDS is 120, so a user still
   survives one missed beat before dropping off the "online" list. */
const HEARTBEAT_MS = 60_000;

/* Minimum spacing between ticks from ANY trigger (interval / visibility /
   consumer churn). Interval ticks are 60s apart so this never suppresses
   them; it collapses the duplicate bursts — e.g. rapid tab switches, or the
   AuthContext handing out a new `user` object identity (every /auth/me
   resolve does) which used to restart the whole poller with an immediate
   extra GET + heartbeat POST. Half the poll interval keeps the worst-case
   heartbeat gap ~90s, still inside the backend's 120s window. */
const MIN_TICK_GAP_MS = 30_000;

/**
 * Tracks who else is currently using the workspace via a 60-second heartbeat.
 * The browser pings POST /api/presence/heartbeat to mark itself "alive", and
 * polls GET /api/presence on the same cadence to fetch the current active list.
 * The heartbeat only fires while the tab is visible.
 *
 * SINGLETON: usePresence is mounted by more than one component at once
 * (PresenceIndicator in the top bar + PresencePanel in the sidebar). Previously
 * each mount ran its own poll, so every page fired 2+ GET /api/presence AND
 * 2+ POST heartbeat. This module-level singleton runs ONE poll + heartbeat and
 * fans the result out to all consumers, so N mounts cost one request per tick.
 *
 * Never re-polls on window focus for fresh data (MIN_TICK_GAP_MS), and the
 * idle-stop is DEFERRED: a same-commit unmount+remount of every consumer (a
 * layout swap, or effects re-running) no longer kills and restarts the poller
 * — a restart's ensureStarted() fired an immediate extra tick each time.
 */

let sharedMembers: ActiveMember[] = [];
let sharedAway: ActiveMember[] = [];
let sharedLoading = true;
let poller: number | undefined;
let started = false;
let stopTimer: number | undefined;
let lastTickAt = 0;
/* Whether the app currently has a signed-in user. Kept OUTSIDE listeners so
   the deferred stop can tell "consumers still mounted but session expired"
   (401 → user null, no reload) apart from "consumers still mounted and
   signed in" — the former must stop polling even though listeners remain. */
let authed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

async function fetchActive(): Promise<void> {
  try {
    const res = await api.get<PresenceResponse>("/api/presence");
    sharedMembers = res.active;
    // Optional on the wire: a backend from before the who's-online popover
    // (deploy skew) sends no away tier.
    sharedAway = res.away ?? [];
  } catch {
    // Network blip or 401 — keep the last known list, don't clear.
  } finally {
    sharedLoading = false;
    emit();
  }
}

async function beat(): Promise<void> {
  try {
    // Pathname only (no query/hash): enough for the popover's deep link,
    // and keeps filter noise / tokens out of the presence table.
    await api.post("/api/presence/heartbeat", {
      path: window.location.pathname,
    });
  } catch {
    // ignore — next interval will retry
  }
}

async function tick(): Promise<void> {
  // Collapse duplicate triggers: anything asking again within the gap is
  // serving data that is still fresh enough (staleTime, in query terms).
  const now = Date.now();
  if (now - lastTickAt < MIN_TICK_GAP_MS) return;
  lastTickAt = now;
  // Only beat when the tab is visible — invisible tabs shouldn't count.
  if (document.visibilityState === "visible") await beat();
  await fetchActive();
}

function onVisibility(): void {
  // Re-tick when the tab becomes visible so a returning user re-appears
  // without waiting a full interval — but only once the last tick is stale
  // (MIN_TICK_GAP_MS), so window-focus flicking never burns requests.
  if (document.visibilityState === "visible") void tick();
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  void tick();
  poller = window.setInterval(() => void tick(), HEARTBEAT_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

function stopIfIdle(): void {
  // Deferred: consumers unmount+remount inside one React commit (all cleanups
  // run before all setups). Stopping synchronously here made every such cycle
  // clear the interval, then ensureStarted() re-ticked — one spurious
  // GET + POST per cycle. Waiting a beat lets a surviving consumer keep the
  // poller running untouched.
  if (stopTimer !== undefined) return;
  stopTimer = window.setTimeout(() => {
    stopTimer = undefined;
    if (listeners.size > 0 && authed) return;
    started = false;
    if (poller) window.clearInterval(poller);
    poller = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
    // A REAL stop ends the session's cadence — the next start (e.g. signing
    // back in after a 401 expiry) must tick immediately, not sit out the gap.
    lastTickAt = 0;
  }, 1_000);
}

export function usePresence(): {
  members: ActiveMember[];
  away: ActiveMember[];
  loading: boolean;
} {
  const { user } = useAuth();
  const [, force] = useState(0);

  /* Depend on WHETHER a user is signed in, not the user object itself —
     AuthContext mints a new `user` identity on every /auth/me resolve, and
     re-running this effect for each one tore the singleton down and back up
     (extra requests, see stopIfIdle). */
  const isAuthed = !!user;

  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    authed = isAuthed;
    if (isAuthed) ensureStarted();
    else stopIfIdle();
    return () => {
      listeners.delete(l);
      stopIfIdle();
    };
  }, [isAuthed]);

  return { members: sharedMembers, away: sharedAway, loading: sharedLoading };
}
