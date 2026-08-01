// ---------------------------------------------------------------------------
// Self-hosted client error reporter.
//
// DOWNSTREAM, ADDED 2026-07-22 — this module is UNCHANGED, but what happens to
// its events after they land is not. The backend endpoint it POSTs to
// (backend/src/routes/clientErrors.ts) now ALSO forwards each event to an
// error tracker, so a white screen can raise an alert in minutes instead of
// waiting for the 02:00 digest. That forward is inert until the owner sets the
// SENTRY_DSN Worker secret, and it carries the SAME sanitized fields the
// endpoint already stored — the privacy note below is still the complete list.
// The relay deliberately lives on the server, not here: sending from the
// browser would bake a DSN into a public bundle and hand the tracking service
// every staff member's real IP address. See docs/error-tracking-options.md.
//
// The original "no Sentry" ruling that produced this module is not overturned:
// the DSN decides who receives the events, and a self-hosted GlitchTip is the
// same one-secret change as a hosted Sentry.
//
// Every uncaught frontend error becomes a row in the backend's client_errors
// table (POST /api/client-errors) so IT hears about white-screens from the
// daily digest instead of from a user's complaint. Three capture paths feed it:
//   1. window "error"            -- uncaught synchronous errors
//   2. window "unhandledrejection" -- unawaited promise failures (the classic
//      "read {success,data} without unwrapping" class often dies here)
//   3. reportClientError()       -- called by ChunkReloadBoundary's
//      componentDidCatch for render crashes React catches before the window
//      ever sees them
//
// PRIME DIRECTIVE: reporting must NEVER change behaviour.
//   - Every entry point is wrapped so a reporter bug is swallowed, not thrown.
//   - An error raised INSIDE the reporter is dropped, never re-reported (the
//     `inReporter` latch) -- no feedback loops.
//   - The boundary still renders its fallback, the console still logs; this
//     module only ADDS a network side-channel.
//
// PRIVACY: an event carries message, stack (capped 4KB), route PATHNAME ONLY
// (never the query string -- reset/invite tokens and filter data live there),
// build id, userAgent, timestamp. No form values, no request bodies, no
// tokens. Identity is NOT sent -- the server stamps user/company from the
// session and ignores anything else.
//
// TRANSPORT: batch + debounce. Events queue and flush after 10s or at 10
// queued, POSTed with the same bearer + company header the app's fetch layer
// uses, keepalive:true so a tab close doesn't lose the batch. A flush failure
// drops the batch silently -- this is telemetry, not business data.
//
// STORM CONTROL (client side; the server dedups again on top):
//   - per-signature cap: the same message+route reports at most 10 times per
//     page load, so a render loop cannot chew bandwidth
//   - session cap: at most 100 events per page load, total
//
// PROD-BUILD ONLY: dev builds point their API at the deployed Worker (see
// api/client.ts baseUrl), so reporting from `vite dev` would pollute real
// telemetry with localhost experiments. Staging Pages builds are prod builds,
// so the pipeline is still exercised before production.
// ---------------------------------------------------------------------------

import { api, requestIdFromError, onRequestTelemetry } from "../api/client";
import { readAuthToken } from "./authToken";
import { companyHeader } from "./activeCompany";
import { correlatedFetch } from "./requestCorrelation";

declare const __BUILD_ID__: string;
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

const FLUSH_MS = 10_000;
const FLUSH_AT = 10; // queue length that triggers an immediate flush
const MAX_STACK = 4000; // server re-caps at 4096
const MAX_MESSAGE = 500;
const PER_SIGNATURE_CAP = 10;
const SESSION_CAP = 100;

interface ErrorEventPayload {
  message: string;
  stack?: string;
  route: string;
  buildId: string;
  userAgent: string;
  occurredAt: string;
}

const queue: ErrorEventPayload[] = [];
const signatureCounts = new Map<string, number>();
let sessionCount = 0;
let flushTimer: number | null = null;
let installed = false;
// Latch: true while reporter code is on the stack, so an error the reporter
// itself raises can never re-enter capture (the no-loop guarantee).
let inReporter = false;

// Benign browser noise with no fix on our side. Deliberately tiny -- every
// entry here is an error IT will never see, so it must be provably harmless.
const IGNORED = [
  /^ResizeObserver loop/i,
  // Cross-origin scripts surface as exactly this string with no stack; there
  // is nothing actionable in it.
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

  // Pathname only. location.pathname cannot carry a query string, but be
  // explicit so a future caller passing a full URL is still safe.
  const route = window.location.pathname.split("?")[0].split("#")[0];

  const sig = `${msg}|${route}`;
  const n = signatureCounts.get(sig) ?? 0;
  if (n >= PER_SIGNATURE_CAP) return;
  signatureCounts.set(sig, n + 1);
  sessionCount++;

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

function flush(): void {
  if (queue.length === 0) return;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const token = readAuthToken();
  if (!token) {
    // No session -> the endpoint would 401. Drop rather than hold: a login
    // screen's errors are not worth a growing in-memory queue.
    queue.length = 0;
    return;
  }
  const events = queue.splice(0, queue.length);
  try {
    // Raw fetch on purpose, NOT api.post(): the app client retries, fires 401
    // logout + 403 toast listeners, and invalidates SWR caches -- all behaviour
    // changes a crash reporter must never cause. keepalive lets the batch
    // survive a tab close / the reload the user is about to click.
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
      // Server unreachable / 4xx / 5xx: drop. Telemetry loss is acceptable;
      // retry loops against a down backend are not.
    });
  } catch {
    // Even building the request must never throw into app code.
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
    // A reporter bug is dropped, never surfaced.
  } finally {
    inReporter = false;
  }
}

/* ── Request telemetry ────────────────────────────────────────────────────
   The window-level capture above only sees errors that reach the window: a
   crash, or a rejection nobody caught. It is blind to the two failures staff
   actually describe — "it's slow" and "it failed to load" — because the app
   HANDLES those: a slow request still resolves, and a failed one is turned
   into a toast. So System Health could only ever show crashes.

   These feed the SAME batched pipeline, which means they inherit its caps.
   That is the whole reason the messages below are built the way they are.

   SIGNATURE STABILITY IS LOAD-BEARING, NOT COSMETIC. enqueue() rate-limits on
   `message|route`, so a message carrying a raw duration ("- 923ms") or a raw
   id ("/api/assr/1435") is unique every single time, PER_SIGNATURE_CAP never
   bites, and SESSION_CAP is the only thing left between a cold connection pool
   and 100 reports per user. Bucket the duration, collapse the id. */

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

/** Three buckets, so one endpoint can produce at most three signatures. */
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
    // A reporter bug is dropped, never surfaced.
  } finally {
    inReporter = false;
  }
}

/** A request that completed, but slowly. This is what "卡" actually is here —
 *  main-thread blocking measured 0ms on every route, so the wait is the API. */
export function reportSlowRequest(method: string, path: string, ms: number): void {
  reportRequest(`slow ${slowBucket(ms)}`, method, path);
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

  /* Subscribe to the request layer. Never unsubscribed — install is
     idempotent and lives for the page's lifetime, same as the listeners
     below. */
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
      // Non-capture listener: resource load failures (img/script tags) do not
      // bubble to window, so only real script errors arrive here.
      const err = ev.error ?? ev.message;
      enqueue(toMessage(err), formatReportedStack(ev.error));
    } catch {
      // dropped
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
      // dropped
    } finally {
      inReporter = false;
    }
  });

  // Last-chance flush when the page is going away (covers the user smashing
  // reload on a white screen -- exactly the moment we most need the report).
  window.addEventListener("pagehide", () => {
    try {
      flush();
    } catch {
      // dropped
    }
  });
  document.addEventListener("visibilitychange", () => {
    try {
      if (document.visibilityState === "hidden") flush();
    } catch {
      // dropped
    }
  });
}
