import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ActiveMember, PresenceResponse } from "../types";

const HEARTBEAT_MS = 60_000;

const MIN_TICK_GAP_MS = 30_000;


let sharedMembers: ActiveMember[] = [];
let sharedAway: ActiveMember[] = [];
let sharedLoading = true;
let poller: number | undefined;
let started = false;
let stopTimer: number | undefined;
let lastTickAt = 0;
let authed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

async function fetchActive(): Promise<void> {
  try {
    const res = await api.get<PresenceResponse>("/api/presence");
    sharedMembers = res.active;
    sharedAway = res.away ?? [];
  } catch {
  } finally {
    sharedLoading = false;
    emit();
  }
}

async function beat(): Promise<void> {
  try {
    await api.post("/api/presence/heartbeat", {
      path: window.location.pathname,
    });
  } catch {
    // silent-write-ok: a presence heartbeat. The next interval retries and
    // nothing on screen claims it landed.
  }
}

async function tick(): Promise<void> {
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastTickAt < MIN_TICK_GAP_MS) return;
  lastTickAt = now;
  await beat();
  await fetchActive();
}

function onVisibility(): void {
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
  if (stopTimer !== undefined) return;
  stopTimer = window.setTimeout(() => {
    stopTimer = undefined;
    if (listeners.size > 0 && authed) return;
    started = false;
    if (poller) window.clearInterval(poller);
    poller = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
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
