import { Hono } from "hono";
import { and, count, desc, gt, isNotNull, max, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { auth_failed_logins as t } from "../db/schema";
import { loginsVerdict } from "../services/failedLogins";

/* GET /api/admin/health/logins: failed sign-ins (DEV-35). Mounted inside
   systemHealth.ts, behind its requireItPages() gate. */
const app = new Hono<{ Bindings: Env }>();

const isRateLimited = sql`${t.reason} IN ('rate_limited', 'totp_rate_limited')`;
const in24h = sql`${t.created_at} > now() - interval '24 hours'`;

app.get("/logins", async (c) => {
  try {
    return c.json({ ok: true, ...(await failedLoginsSummary(c.env)) });
  } catch (e) {
    // Same as the other health routes: a DB failure reads as ok:false, not a 500.
    console.error("[health/logins]", e);
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

async function failedLoginsSummary(env: Env) {
  const db = getDb(env);
  const [totals, topEmails, topIps] = await Promise.all([
    db
      .select({
        failed_24h: sql<number>`count(*) FILTER (WHERE ${in24h})`.mapWith(Number),
        failed_7d: count(),
        rate_limited_24h: sql<number>`count(*) FILTER (WHERE ${in24h} AND ${isRateLimited})`.mapWith(Number),
        rate_limited_7d: sql<number>`count(*) FILTER (WHERE ${isRateLimited})`.mapWith(Number),
      })
      .from(t)
      .where(gt(t.created_at, sql`now() - interval '7 days'`)),
    db
      .select({
        email: t.email,
        user_id: max(t.user_id),
        failures: count(),
        last_attempt_at: max(t.created_at),
      })
      .from(t)
      .where(and(in24h, isNotNull(t.email)))
      .groupBy(t.email)
      .orderBy(desc(count()), desc(max(t.created_at)))
      .limit(10),
    db
      .select({ ip: t.ip, failures: count(), last_attempt_at: max(t.created_at) })
      .from(t)
      .where(and(in24h, isNotNull(t.ip)))
      .groupBy(t.ip)
      .orderBy(desc(count()), desc(max(t.created_at)))
      .limit(10),
  ]);
  const tot = totals[0] ?? { failed_24h: 0, failed_7d: 0, rate_limited_24h: 0, rate_limited_7d: 0 };
  return {
    verdict: loginsVerdict(tot.failed_24h, topEmails.map((r) => r.failures)),
    ...tot,
    top_emails_24h: topEmails,
    top_ips_24h: topIps,
  };
}

export default app;
