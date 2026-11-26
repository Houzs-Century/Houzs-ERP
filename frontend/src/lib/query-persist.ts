
import type { QueryClient } from "@tanstack/react-query";
import { authSessionFingerprint, subscribeAuthTokenChange } from "./authToken";
import {
  getActiveCompanyId,
  hasStoredCompanySelection,
  subscribeActiveCompany,
} from "./activeCompany";
import { BUILD_ID } from "./buildId";

const NS_PREFIX = "houzs-rq-snapshot:";
const BUILD_PREFIX = `${NS_PREFIX}${BUILD_ID}:`;
const MAX_BYTES = 1_500_000;
const DEBOUNCE_MS = 1200;
const IDLE_TIMEOUT_MS = 5000;

function activeCompany(): string {
  return String(getActiveCompanyId() ?? 0);
}

function companyBucketIsTrustworthy(): boolean {
  if (getActiveCompanyId() !== null) return true;
  return !hasStoredCompanySelection();
}
function sessionFp(): string {
  return authSessionFingerprint();
}

function sessionPrefix(): string {
  return `${BUILD_PREFIX}${sessionFp()}:`;
}

function snapKey(): string {
  return `${sessionPrefix()}${activeCompany()}`;
}

/** Drop every snapshot this module owns, across all builds/sessions/companies. */
export function clearQuerySnapshots(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
  }
}

const LIST_ENTITIES = new Set([
  "mfg-sales-orders",
  "mfg-purchase-orders",
  "mfg-delivery-orders",
  "sales-invoices",
  "grns",
]);
/* The V2 list screens read through these, keyed [entity, page, pageSize, …]
   with a numeric page, so the LIST_ENTITIES test below never matched them and
   no list was painted from a snapshot (HC-0002, 2026-10-22). Only the first
   page is kept: it is what a cold open shows, and a snapshot that grew past
   MAX_BYTES would be skipped whole. */
const PAGED_LIST_ENTITIES = new Set([
  "mfg-sales-orders-paged",
  "mfg-purchase-orders-paged",
  "mfg-delivery-orders-paged",
  "sales-invoices-paged",
  "grns-paged",
]);
const SUBRESOURCE = new Set([
  "debtors",
  "deliverable-so-lines",
  "outstanding-po-items",
  "outstanding-so-items",
  "payments",
  "detail",
]);

function isListKey(key: readonly unknown[]): boolean {
  if (key.length < 2) return false;
  const entity = key[0];
  const second = key[1];
  if (typeof entity === "string" && PAGED_LIST_ENTITIES.has(entity)) {
    return second === 0 && !key.some((seg) => typeof seg === "string" && SUBRESOURCE.has(seg));
  }
  if (typeof entity !== "string" || !LIST_ENTITIES.has(entity)) return false;
  if (typeof second !== "string") return false;
  if (key.some((seg) => typeof seg === "string" && SUBRESOURCE.has(seg))) return false;
  return true;
}

function save(qc: QueryClient, company: string, session: string): void {
  if (!session || sessionFp() !== session || activeCompany() !== company) return;
  try {
    const out: Record<string, unknown> = {};
    for (const q of qc.getQueryCache().getAll()) {
      if (q.state.status !== "success" || q.state.data == null) continue;
      if (!isListKey(q.queryKey as readonly unknown[])) continue;
      out[JSON.stringify(q.queryKey)] = q.state.data;
    }
    const json = JSON.stringify(out);
    if (json.length > MAX_BYTES) return;
    localStorage.setItem(`${BUILD_PREFIX}${session}:${company}`, json);
  } catch {
  }
}

function hydrate(qc: QueryClient): void {
  if (!sessionFp()) {
    clearQuerySnapshots();
    return;
  }
  try {
    const keep = sessionPrefix();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS_PREFIX) && !k.startsWith(keep)) localStorage.removeItem(k);
    }
    const raw = localStorage.getItem(snapKey());
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [keyStr, data] of Object.entries(obj)) {
      let key: unknown[];
      try {
        key = JSON.parse(keyStr) as unknown[];
      } catch {
        continue;
      }
      if (!Array.isArray(key) || !isListKey(key)) continue;
      qc.setQueryData(key, data, { updatedAt: 1 });
    }
  } catch {
  }
}

let disposeInstalledPersist: (() => void) | undefined;

/** Wire persistence: hydrate now (before first render) + save on cache changes. */
export function installQueryPersist(qc: QueryClient): () => void {
  disposeInstalledPersist?.();
  if (typeof window === "undefined" || !("localStorage" in window)) return () => {};
  let hydrated = false;
  if (companyBucketIsTrustworthy()) {
    hydrate(qc);
    hydrated = true;
  }
  let installedCompany = activeCompany();
  let installedSession = sessionFp();
  let awaitingCompany = getActiveCompanyId() === null;
  let disposed = false;
  let timer: number | undefined;
  let idleHandle: number | undefined;
  let idleFallback: number | undefined;
  const runSave = () => {
    idleHandle = undefined;
    idleFallback = undefined;
    save(qc, installedCompany, installedSession);
  };
  const scheduleIdleSave = () => {
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(runSave, { timeout: IDLE_TIMEOUT_MS });
    } else {
      idleFallback = window.setTimeout(runSave, 0);
    }
  };
  const schedule = () => {
    if (disposed) return;
    if (timer !== undefined || idleHandle !== undefined || idleFallback !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      scheduleIdleSave();
    }, DEBOUNCE_MS);
  };
  const unsubscribeCache = qc.getQueryCache().subscribe(schedule);
  const flush = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    if (idleHandle !== undefined && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleHandle);
    }
    if (idleFallback !== undefined) window.clearTimeout(idleFallback);
    timer = undefined;
    idleHandle = undefined;
    idleFallback = undefined;
    save(qc, installedCompany, installedSession);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") flush();
  };
  window.addEventListener("pagehide", flush);
  window.addEventListener("visibilitychange", onVisibilityChange);

  const unsubscribeAuth = subscribeAuthTokenChange(() => {
    cancelPending();
    qc.removeQueries({
      predicate: (query) => isListKey(query.queryKey as readonly unknown[]),
    });
    installedSession = sessionFp();
    installedCompany = activeCompany();
    awaitingCompany = getActiveCompanyId() === null;
    hydrated = hydrated && !awaitingCompany;
    if (!installedSession) clearQuerySnapshots();
  });

  const unsubscribeCompany = subscribeActiveCompany(() => {
    if (!awaitingCompany) return;
    if (getActiveCompanyId() === null) return;
    awaitingCompany = false;
    cancelPending();
    installedCompany = activeCompany();
    if (!hydrated) {
      hydrate(qc);
      hydrated = true;
    }
  });

  function cancelPending(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    if (idleHandle !== undefined && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleHandle);
    }
    if (idleFallback !== undefined) window.clearTimeout(idleFallback);
    timer = undefined;
    idleHandle = undefined;
    idleFallback = undefined;
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelPending();
    unsubscribeCache();
    unsubscribeAuth();
    unsubscribeCompany();
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("visibilitychange", onVisibilityChange);
    if (disposeInstalledPersist === dispose) disposeInstalledPersist = undefined;
  };
  disposeInstalledPersist = dispose;
  return dispose;
}
