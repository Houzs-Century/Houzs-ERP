
import { hashKey, partialMatchKey, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";

const CHANNEL = "houzs-scm-data-sync";

/** keys absent = a legacy or unscoped write: the receiver re-reads everything. */
export type WriteMessage = { t: "changed"; keys?: QueryKey[] };

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

function post(msg: WriteMessage): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage(msg);
  } catch {
    try { ch.postMessage({ t: "changed" }); } catch { }
  }
}

/** Tell other tabs that something was written here, without saying what. */
export function broadcastDataChanged(): void {
  post({ t: "changed" });
}


const SETTLE_GRACE_MS = 50;

type Collector = { keys: Map<string, QueryKey>; all: boolean };

/** Collects what this tab's mutations invalidate and broadcasts it. */
export function createWriteBroadcaster(qc: QueryClient, send: (msg: WriteMessage) => void) {
  let open = 0;
  let current: Collector = { keys: new Map(), all: false };
  let applyingRemote = false;
  const opened = new WeakSet<object>();

  const original = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = ((filters?: Parameters<QueryClient["invalidateQueries"]>[0], options?: Parameters<QueryClient["invalidateQueries"]>[1]) => {
    if (open > 0 && !applyingRemote) {
      const key = filters?.queryKey;
      if (!key || filters.predicate) current.all = true;
      else current.keys.set(hashKey(key), key);
    }
    return original(filters, options);
  }) as QueryClient["invalidateQueries"];

  const flush = () => {
    const c = current;
    current = { keys: new Map(), all: false };
    send(c.all || c.keys.size === 0 ? { t: "changed" } : { t: "changed", keys: [...c.keys.values()] });
  };

  return {
    succeeded(m: object) {
      opened.add(m);
      open += 1;
    },
    settled(m: object) {
      if (!opened.has(m)) return;
      opened.delete(m);
      setTimeout(() => {
        open -= 1;
        if (open === 0) flush();
      }, SETTLE_GRACE_MS);
    },
    remote<T>(fn: () => T): T {
      applyingRemote = true;
      try { return fn(); } finally { applyingRemote = false; }
    },
  };
}

let broadcaster: ReturnType<typeof createWriteBroadcaster> | null = null;

/** Global MutationCache hooks (lib/queryClient.ts). Before install: unscoped. */
export function mutationSucceeded(m: object): void {
  if (broadcaster) broadcaster.succeeded(m);
  else broadcastDataChanged();
}
export function mutationSettled(m: object): void {
  broadcaster?.settled(m);
}


export type CrossTabClaim = {
  owns: (q: Query) => boolean;
  refresh: () => void;
};

const claims = new Set<CrossTabClaim>();

/** A screen takes over the cross-tab refresh of some queries; returns the release. */
export function claimCrossTabRefresh(claim: CrossTabClaim): () => void {
  claims.add(claim);
  return () => { claims.delete(claim); };
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function readKeys(data: unknown): QueryKey[] | "all" | null {
  if ((data as { t?: unknown } | null)?.t !== "changed") return null;
  const keys = (data as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => Array.isArray(k) && k.length > 0)) return "all";
  return keys as QueryKey[];
}

/** Listen for other tabs' writes and invalidate so open lists/details refetch.
    Call once at startup with the app's QueryClient. */
export function installCrossTabSync(qc: QueryClient): void {
  broadcaster = createWriteBroadcaster(qc, post);
  const ch = getChannel();
  if (ch) listenForWrites(qc, ch, broadcaster.remote);
}

/** The listener itself, on a given channel; returns the uninstaller. */
export function listenForWrites(
  qc: QueryClient,
  ch: BroadcastChannel,
  remote: <T>(fn: () => T) => T = (fn) => fn(),
): () => void {
  let missedAll = false;
  const missedKeys = new Map<string, QueryKey>();
  const missedClaims = new Set<CrossTabClaim>();
  const notOwned = (q: Query) => ![...claims].some((c) => c.owns(q));

  const apply = (keys: QueryKey[], refetchType: "active" | "none") => {
    const due = new Set<CrossTabClaim>();
    const covered = (q: Query) => keys.some((k) => partialMatchKey(q.queryKey, k));
    for (const q of qc.getQueryCache().findAll({ predicate: covered })) {
      for (const c of claims) if (c.owns(q)) due.add(c);
    }
    if (keys.length > 0) {
      void remote(() => qc.invalidateQueries({ predicate: (q) => covered(q) && notOwned(q), refetchType }));
    }
    return due;
  };

  ch.onmessage = (e: MessageEvent) => {
    const keys = readKeys(e.data);
    if (keys === null) return;
    const hidden = isHidden();
    if (keys === "all") {
      if (hidden) missedAll = true;
      void remote(() => qc.invalidateQueries({ refetchType: hidden ? "none" : "active" }));
      return;
    }
    if (hidden) {
      for (const k of keys) missedKeys.set(hashKey(k), k);
      for (const c of apply(keys, "none")) missedClaims.add(c);
      return;
    }
    for (const c of apply(keys, "active")) c.refresh();
  };

  const onVisible = () => {
    if (isHidden()) return;
    if (missedAll) {
      void remote(() => qc.invalidateQueries({ refetchType: "active" }));
    } else if (missedKeys.size > 0 || missedClaims.size > 0) {
      const due = apply([...missedKeys.values()], "active");
      for (const c of missedClaims) if (claims.has(c)) due.add(c);
      for (const c of due) c.refresh();
    }
    missedAll = false;
    missedKeys.clear();
    missedClaims.clear();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    ch.onmessage = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
