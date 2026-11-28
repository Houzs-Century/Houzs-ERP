import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { checkRateLimit } from "../middleware/rateLimit";
import { captureError } from "../services/errorTracking";


const app = new Hono<{ Bindings: Env }>();

const MAX_BODY_BYTES = 16 * 1024;
const MAX_STACK = 4096;
const MAX_MESSAGE = 500;
const MAX_ROUTE = 200;

const RL_MAX = 60;
const RL_WINDOW_SEC = 600;

const eventSchema = z.object({
  message: z.string().min(1).max(4000),
  stack: z.string().max(64 * 1024).optional(),
  route: z.string().max(2000).optional(),
  buildId: z.string().max(64).optional(),
  userAgent: z.string().max(500).optional(),
  occurredAt: z.string().max(40).optional(),
  count: z.number().int().min(1).max(1000).optional(),
});
const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(20),
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const ROWS_PER_STATEMENT = 7;
const COLUMNS = 13;

async function dedupHash(message: string, route: string, buildId: string): Promise<string> {
  const data = new TextEncoder().encode(`${message}\n${route}\n${buildId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeRoute(raw: string | undefined): string {
  const r = (raw ?? "").split("?")[0].split("#")[0];
  return r.slice(0, MAX_ROUTE);
}

app.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const limited = await checkRateLimit(c, "client_errors", String(user.id), RL_MAX, RL_WINDOW_SEC);
  if (limited) return limited;

  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return c.json({ error: "Invalid error report" }, 400);
  }

  const userId = Number(user.id) || 0;
  const companyId = c.get("companyId") ?? null;

  const nowIso = new Date().toISOString();
  const day = nowIso.slice(0, 10);

  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }

  type Row = {
    occurredAt: string;
    route: string;
    message: string;
    stack: string | null;
    buildId: string;
    userAgent: string | null;
    hash: string;
    count: number;
  };
  const rows = new Map<string, Row>();
  for (const ev of parsed.data.events) {
    const message = ev.message.slice(0, MAX_MESSAGE);
    const route = sanitizeRoute(ev.route);
    const buildId = (ev.buildId ?? "").slice(0, 64);
    const hash = await dedupHash(message, route, buildId);
    const n = ev.count ?? 1;
    const seen = rows.get(hash);
    if (seen) {
      seen.count += n;
      continue;
    }
    rows.set(hash, {
      occurredAt: ev.occurredAt && ISO_RE.test(ev.occurredAt) ? ev.occurredAt : nowIso,
      route,
      message,
      stack: ev.stack ? ev.stack.slice(0, MAX_STACK) : null,
      buildId,
      userAgent: ev.userAgent ? ev.userAgent.slice(0, 500) : null,
      hash,
      count: n,
    });
  }

  const all = [...rows.values()];
  const statements = [];
  for (let i = 0; i < all.length; i += ROWS_PER_STATEMENT) {
    const chunk = all.slice(i, i + ROWS_PER_STATEMENT);
    const values = chunk.map(() => `(${new Array(COLUMNS).fill("?").join(", ")})`).join(",\n         ");
    const binds = chunk.flatMap((r) => [
      r.occurredAt, day, userId, companyId, r.route, r.message, r.stack, r.buildId, r.userAgent, r.hash, r.count, nowIso, nowIso,
    ]);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO client_errors
           (occurred_at, day, user_id, company_id, route, message, stack, build_id, user_agent, dedup_hash, count, last_seen_at, created_at)
         VALUES ${values}
         ON CONFLICT (dedup_hash, day, user_id) DO UPDATE SET
           count = client_errors.count + excluded.count,
           last_seen_at = excluded.last_seen_at`,
      ).bind(...binds),
    );
  }
  if (statements.length === 1) await statements[0].run();
  else if (statements.length > 1) await c.env.DB.batch(statements);

  let stored = 0;
  for (const r of all) {
    stored += r.count;
    captureError(
      c.env,
      new Error(r.message),
      {
        source: "browser",
        route: r.route,
        requestId: c.get("requestId"),
        userId,
        companyId,
        release: r.buildId || undefined,
        stack: r.stack ?? undefined,
      },
      waitUntil,
    );
  }

  return c.json({ success: true, stored });
});

app.get("/summary", requirePermission("*"), async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await c.env.DB.prepare(
      `SELECT dedup_hash,
              MAX(message) AS message,
              MAX(route) AS route,
              MAX(build_id) AS build_id,
              SUM(count) AS n,
              COUNT(DISTINCT user_id) AS affected_users,
              MAX(last_seen_at) AS last_seen_at
         FROM client_errors
        WHERE last_seen_at >= ?
        GROUP BY dedup_hash
        ORDER BY n DESC
        LIMIT 50`,
    )
      .bind(cutoff)
      .all<{
        dedup_hash: string;
        message: string;
        route: string;
        build_id: string;
        n: number;
        affected_users: number;
        last_seen_at: string;
      }>();
    const data = (rows.results ?? []).map((r) => ({
      dedup_hash: r.dedup_hash,
      message: r.message,
      route: r.route,
      build_id: r.build_id,
      count: Number(r.n),
      affected_users: Number(r.affected_users),
      last_seen_at: r.last_seen_at,
    }));
    const totals = {
      errors: data.length,
      occurrences: data.reduce((s, r) => s + r.count, 0),
    };
    return c.json({ success: true, days, data, totals });
  } catch (e: any) {
    return c.json({ success: false, days, data: [], totals: { errors: 0, occurrences: 0 }, error: e?.message || "summary failed" });
  }
});

export default app;
