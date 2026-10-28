import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { resolveTrackToken, type TrackedCase } from "../services/caseTracking";

// Portal tracking middleware. A valid bearer token resolves to exactly
// one case (scoped by assr_id), which the downstream routes read via
// `c.get("trackedCase")`. No cross-case access is possible from a
// single token, which is the entire point of this auth model.
//
// Deliberately does NOT honour DASHBOARD_API_KEY — the service key
// must never grant portal access under any circumstance.

declare module "hono" {
  interface ContextVariableMap {
    trackedCase: TrackedCase;
  }
}

export const caseTrack: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "This tracking link is no longer valid. Please request a new one." }, 401);

  const tc = await resolveTrackToken(c.env, token);
  if (!tc) return c.json({ error: "This tracking link is no longer valid. Please request a new one." }, 401);

  c.set("trackedCase", tc);
  await next();
};
