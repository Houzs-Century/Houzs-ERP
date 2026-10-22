import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { stepTimingEntries, withStepTiming, type StepMark } from "../lib/step-timing";

// One structured access-log line per request + a request id echoed back in the
// `X-Request-Id` header. Turns `wrangler tail` into a greppable log and lets a
// user quote the id when reporting an issue. Complements the slow-query log
// (d1-compat) already shipped. Cheap; mount outermost so it times the whole
// chain and sees the final status + (for authed routes) the resolved user.
//
// Error AGGREGATION is deliberately not done here — it belongs in `onError`,
// which is the only place that sees the thrown error itself rather than just
// the status this middleware records. That SENTRY_DSN-gated hook now exists:
// index.ts calls services/errorTracking.ts from onError, and it is inert until
// the secret is set. This middleware stays what it always was — one access-log
// line and the request id that the error report quotes back.

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

function requestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function normalizeRequestId(candidate: string | undefined): string {
  const value = candidate?.trim();
  return value && SAFE_REQUEST_ID.test(value) ? value : requestId();
}

export const requestLog: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Never put an arbitrary caller-controlled value into logs or Analytics
  // Engine indexes. Besides cardinality abuse, whitespace/control characters
  // can forge log lines and make an incident trail ambiguous.
  const id = normalizeRequestId(c.req.header("X-Request-Id"));
  c.header("X-Request-Id", id);
  c.set("requestId", id);
  const t0 = Date.now();
  const marks: StepMark[] = [];
  await withStepTiming(marks, () => next());
  const ms = Date.now() - t0;
  // Worker time vs. the browser's wait, plus each timed() step (lib/step-timing.ts).
  try {
    c.res.headers.set("Server-Timing", [`app;dur=${ms}`, ...stepTimingEntries(marks)].join(", "));
  } catch {
    /* an immutable passthrough response keeps its own headers */
  }
  const path = new URL(c.req.url).pathname;
  if (path === "/health") return; // skip keep-alive noise
  const uid = c.get("user")?.id ?? "-";
  console.log(`[req] ${c.req.method} ${path} ${c.res.status} ${ms}ms id=${id} user=${uid}`);

  // Analytics Engine timing point for System Health (phase 2). Guarded so it's
  // a no-op when the binding is absent. Route uses the matched Hono pattern
  // (e.g. /api/users/:id) to keep AE index cardinality low; falls back to the
  // raw path. blob/double layout MUST match the read SQL in routes/systemHealth
  // (blob1=kind, blob2=route, blob3=status, blob4=reqId, blob5=method;
  // double1=dur_ms, double2=db_ms, double3=db_count).
  try {
    const route = c.req.routePath || path;
    const status = c.res.status;
    c.env.ERP_METRICS?.writeDataPoint?.({
      indexes: [`req|${route}|${status}`],
      blobs: ["req", route, String(status), id, c.req.method, ""],
      doubles: [ms, 0, 0],
    });
  } catch {
    /* never let observability break a request */
  }
};
