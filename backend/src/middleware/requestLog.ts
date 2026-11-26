import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { dbTotals, stepTimingEntries, withStepTiming, type StepMark } from "../lib/step-timing";


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
  const id = normalizeRequestId(c.req.header("X-Request-Id"));
  c.header("X-Request-Id", id);
  c.set("requestId", id);
  const t0 = Date.now();
  const marks: StepMark[] = [];
  await withStepTiming(marks, () => next());
  const ms = Date.now() - t0;
  const db = dbTotals(marks);
  try {
    c.res.headers.set("Server-Timing", [`app;dur=${ms}`, ...stepTimingEntries(marks)].join(", "));
  } catch {
  }
  const path = new URL(c.req.url).pathname;
  if (path === "/health") return;
  const uid = c.get("user")?.id ?? "-";
  console.log(`[req] ${c.req.method} ${path} ${c.res.status} ${ms}ms id=${id} user=${uid}`);

  try {
    const route = c.req.routePath || path;
    const status = c.res.status;
    const companyId = c.get("companyId");
    c.env.ERP_METRICS?.writeDataPoint?.({
      indexes: [`req|${route}|${status}`],
      blobs: ["req", route, String(status), id, c.req.method, companyId == null ? "" : String(companyId)],
      doubles: [ms, db.ms, db.n],
    });
  } catch {
  }
};
