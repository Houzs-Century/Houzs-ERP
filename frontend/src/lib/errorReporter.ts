
import { api, requestIdFromError, onRequestTelemetry } from "../api/client";
import { readAuthToken } from "./authToken";
import { companyHeader } from "./activeCompany";
import { correlatedFetch } from "./requestCorrelation";
import { BUILD_ID } from "./buildId";


const FLUSH_MS = 60_000;
const FLUSH_AT = 10;
const MAX_STACK = 4000;
const MAX_MESSAGE = 500;
const PER_SIGNATURE_CAP = 10;
const SESSION_CAP = 100;
const SLOW_FLUSH_MS = 10 * 60_000;
const SLOW_SUMMARY_CAP = 10;
const SLOW_DISTINCT_CAP = 50;
const SERVER_COUNT_MAX = 1000;

interface ErrorEventPayload {
  message: string;
  stack?: string;
  route: string;
  buildId: string;
  userAgent: string;
  occurredAt: string;
  count?: number;
}

const queue: ErrorEventPayload[] = [];
const signatureCounts = new Map<string, number>();
let sessionCount = 0;
let flushTimer: number | null = null;
const slowCounts = new Map<string, number>();
let slowTimer: number | null = null;
let installed = false;
let inReporter = false;

const IGNORED = [
  /^ResizeObserver loop/i,
  /^Script error\.?$/i,
];

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err).slice(0, MAX_MESSAGE);
  } catch {
    return String(err);
  }
}

export function formatReportedStack(err: unknown): string | undefined {
  const requestId = requestIdFromError(err);
  const stack = err instanceof Error && err.stack ? err.stack : "";
  if (!requestId) return stack ? stack.slice(0, MAX_STACK) : undefined;
  const suffix = `\nRequest-Id: ${requestId}`;
  return `${stack.slice(0, Math.max(0, MAX_STACK - suffix.length))}${suffix}`.trim();
}

function enqueue(message: string, stack: string | undefined): void {
  const msg = (message || "").trim().slice(0, MAX_MESSAGE);
  if (!msg) return;
  if (IGNORED.some((re) => re.test(msg))) return;
  if (sessionCount >= SESSION_CAP) return;

  const route = window.location.pathname.split("?")[0].split("#")[0];

  const sig = `${msg}|${route}`;
  const n = signatureCounts.get(sig) ?? 0;
  if (n >= PER_SIGNATURE_CAP) return;
  signatureCounts.set(sig, n + 1);
  sessionCount++;

  const queued = queue.find((q) => q.message === msg && q.route === route);
  if (queued) {
    queued.count = (queued.count ?? 1) + 1;
    return;
  }

  queue.push({
    message: msg,
    stack,
    route,
    buildId: BUILD_ID,
    userAgent: navigator.userAgent.slice(0, 400),
    occurredAt: new Date().toISOString(),
  });

  if (queue.length >= FLUSH_AT) {
    flush();
  } else if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_MS);
  }
}

function takeSlowSummary(): ErrorEventPayload[] {
  if (slowTimer !== null) {
    window.clearTimeout(slowTimer);
    slowTimer = null;
  }
  if (slowCounts.size === 0) return [];
  const now = new Date().toISOString();
  const events = [...slowCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SLOW_SUMMARY_CAP)
    .map(([message, n]) => ({
      message,
      route: "",
      buildId: BUILD_ID,
      userAgent: navigator.userAgent.slice(0, 400),
      occurredAt: now,
      count: Math.min(n, SERVER_COUNT_MAX),
    }));
  slowCounts.clear();
  return events;
}

function flush(withSlow = false): void {
  if (queue.length === 0 && !(withSlow && slowCounts.size > 0)) return;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const token = readAuthToken();
  if (!token) {
    queue.length = 0;
    takeSlowSummary();
    return;
  }
  const events = [...queue.splice(0, queue.length), ...takeSlowSummary()];
  try {
    void correlatedFetch(`${api.baseUrl}/api/client-errors`, {
      method: "POST",
      keepalive: true,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...companyHeader(),
      },
      body: JSON.stringify({ events }),
    }).catch(() => {
    });
  } catch {
  }
}

/**
 * Report an error that was already caught elsewhere (the React error
 * boundary). Safe to call from anywhere: never throws, never loops, no-ops in
 * dev builds and before install.
 */
export function reportClientError(err: unknown, context?: string): void {
  if (!installed || inReporter) return;
  inReporter = true;
  try {
    const base = toMessage(err);
    enqueue(context ? `[${context}] ${base}` : base, formatReportedStack(err));
  } catch {
  } finally {
    inReporter = false;
  }
}


/** Collapse the varying segments of an API path: `/api/assr/1435` and
 *  `/api/scm/grns/<uuid>` both become one signature. */
export function normalizeApiPath(path: string): string {
  return path
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

function slowBucket(ms: number): string {
  if (ms >= 5000) return "5s+";
  if (ms >= 2000) return "2s+";
  return "800ms+";
}

function reportRequest(label: string, method: string, path: string): void {
  if (!installed || inReporter) return;
  inReporter = true;
  try {
    enqueue(`[${label}] ${method} ${normalizeApiPath(path)}`, undefined);
  } catch {
  } finally {
    inReporter = false;
  }
}

/** A request that completed, but slowly. This is what "卡" actually is here —
 *  main-thread blocking measured 0ms on every route, so the wait is the API. */
export function reportSlowRequest(method: string, path: string, ms: number): void {
  if (!installed || inReporter) return;
  inReporter = true;
  try {
    const msg = `[slow ${slowBucket(ms)}] ${method} ${normalizeApiPath(path)}`.slice(0, MAX_MESSAGE);
    if (!slowCounts.has(msg) && slowCounts.size >= SLOW_DISTINCT_CAP) return;
    slowCounts.set(msg, (slowCounts.get(msg) ?? 0) + 1);
    if (slowTimer === null) {
      slowTimer = window.setTimeout(() => {
        slowTimer = null;
        flush(true);
      }, SLOW_FLUSH_MS);
    }
  } catch {
  } finally {
    inReporter = false;
  }
}

/** A request the browser gave up on. It never resolves, so reportSlowRequest
 *  never sees it — and it is the slowest kind there is (HC-0167). */
export function reportTimedOutRequest(method: string, path: string): void {
  reportRequest("timeout", method, path);
}

/** 5xx only. A 4xx is a decision the app already handles (the same reasoning
 *  queryClient's retry policy rests on); a 5xx is the server breaking, and it
 *  is what a user sees as "failed to load". */
export function reportServerFailure(method: string, path: string, status: number): void {
  reportRequest(`api ${status}`, method, path);
}

/** 403 kept SEPARATE from the 5xx bucket on purpose. One 403 is a correct
 *  denial and not a fault; a PATTERN of them is a misconfigured permission or
 *  scope, which is invisible today because the app turns it into a toast and
 *  moves on. Labelling it lets System Health answer "is this RBAC, or is the
 *  server broken" instead of leaving both looking like "it doesn't work". */
export function reportAccessDenied(method: string, path: string): void {
  reportRequest("rbac 403", method, path);
}

/**
 * Install the window-level capture (error + unhandledrejection). Call once at
 * boot, before React renders, so even a crash during the first render is
 * captured. Idempotent; no-ops on dev builds.
 */
export function installGlobalErrorReporting(): void {
  if (installed || !import.meta.env.PROD) return;
  installed = true;

  onRequestTelemetry((event) => {
    if (event.kind === "slow") reportSlowRequest(event.method, event.path, event.ms);
    else if (event.kind === "server-error")
      reportServerFailure(event.method, event.path, event.status);
    else reportAccessDenied(event.method, event.path);
  });

  window.addEventListener("error", (event: Event) => {
    if (inReporter) return;
    inReporter = true;
    try {
      const ev = event as globalThis.ErrorEvent;
      const err = ev.error ?? ev.message;
      enqueue(toMessage(err), formatReportedStack(ev.error));
    } catch {
    } finally {
      inReporter = false;
    }
  });

  window.addEventListener("unhandledrejection", (event: Event) => {
    if (inReporter) return;
    inReporter = true;
    try {
      const reason = (event as PromiseRejectionEvent).reason;
      enqueue(toMessage(reason), formatReportedStack(reason));
    } catch {
    } finally {
      inReporter = false;
    }
  });

  window.addEventListener("pagehide", () => {
    try {
      flush();
    } catch {
    }
  });
  document.addEventListener("visibilitychange", () => {
    try {
      if (document.visibilityState === "hidden") flush();
    } catch {
    }
  });
}
