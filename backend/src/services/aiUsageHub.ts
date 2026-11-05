// ---------------------------------------------------------------------------
// aiUsageHub.ts — daily AI cost summary sent to the Houzs IT Hub.
//
// The hub reads Anthropic's real cost per workspace; it cannot see which feature
// or company spent it. This sends what only this system knows: the last 7 UTC
// days of ai_usage_events, priced with costUsd, per day x company x feature. The
// hub uses the amounts only as SHARES of the real cost, so prices that drift from
// Anthropic's do not change any total there. Days are UTC to line up with
// Anthropic's daily cost buckets; every day is sent, empty ones too, because the
// hub replaces each day it receives.
//
// One report covers every company, each row carrying its company code; it goes
// out with ONE company's hub key, named by IT_HUB_AI_USAGE_COMPANY (the company
// whose Anthropic workspace this system's key belongs to). Unset address, company
// or key => nothing is sent. Run from the daily 02:00 UTC cron.
// ---------------------------------------------------------------------------
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { costUsd, type TokenCounts } from "./aiUsage";

const DAYS = 7;
const HUB_TIMEOUT_MS = 20_000;
const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;

/** One grouped row of ai_usage_events (UTC day, company, feature, model). */
export interface HubAggRow extends TokenCounts {
  day: string;
  companyCode: string | null;
  feature: string;
  model: string;
  calls: number;
}

export interface HubUsageReport {
  vendor: "Anthropic";
  days: { day: string; rows: { company: string | null; module: string; usd: number; calls: number }[] }[];
}

/** The `count` UTC days ending with `now`'s, oldest first. */
export function lastUtcDays(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Pure: price each row and add models together per day, company and feature. */
export function buildHubUsageReport(days: string[], rows: HubAggRow[]): HubUsageReport {
  const byDay = new Map(days.map((d) => [d, new Map<string, { company: string | null; module: string; usd: number; calls: number }>()]));
  for (const r of rows) {
    const day = byDay.get(r.day);
    if (!day) continue;
    const key = `${r.companyCode ?? ""}|${r.feature}`;
    const cur = day.get(key) ?? { company: r.companyCode, module: r.feature, usd: 0, calls: 0 };
    cur.usd += costUsd(r.model, r);
    cur.calls += r.calls;
    day.set(key, cur);
  }
  return {
    vendor: "Anthropic",
    days: days.map((day) => ({
      day,
      rows: [...byDay.get(day)!.values()].map((r) => ({ ...r, usd: Math.round(r.usd * 1e6) / 1e6 })),
    })),
  };
}

const num = (v: unknown) => Number(v) || 0;

/** Send the summary. Returns null when this environment is not set up to send. */
export async function sendAiUsageToHub(env: Env, now: Date): Promise<{ days: number; rows: number } | null> {
  const base = (env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");
  const company = (env.IT_HUB_AI_USAGE_COMPANY ?? "").trim().toUpperCase();
  const secret = COMPANY_CODE.test(company) ? (env as unknown as Record<string, unknown>)[`IT_HUB_API_KEY_${company}`] : undefined;
  const key = typeof secret === "string" ? secret.trim() : "";
  if (!base || !key) return null;

  const days = lastUtcDays(now, DAYS);
  // company-scope: IT-wide by design, like the AI Usage report; the output is per company.
  const rows = await getDb(env).execute<Record<string, unknown>>(sql`
    SELECT to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           co.code AS company_code, e.feature, e.model,
           count(*) AS calls,
           coalesce(sum(e.input_tokens), 0) AS input_tokens,
           coalesce(sum(e.output_tokens), 0) AS output_tokens,
           coalesce(sum(e.cache_read_tokens), 0) AS cache_read_tokens,
           coalesce(sum(e.cache_write_tokens), 0) AS cache_write_tokens
      FROM public.ai_usage_events e
      LEFT JOIN public.companies co ON co.id = e.company_id
     WHERE e.created_at >= ${`${days[0]}T00:00:00Z`}::timestamptz
     GROUP BY 1, 2, 3, 4`);

  const report = buildHubUsageReport(
    days,
    [...rows].map((r) => ({
      day: String(r.day),
      companyCode: (r.company_code as string | null) ?? null,
      feature: String(r.feature),
      model: String(r.model),
      calls: num(r.calls),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cacheReadTokens: num(r.cache_read_tokens),
      cacheWriteTokens: num(r.cache_write_tokens),
    })),
  );
  const res = await fetch(`${base}/api/v1/sys/ai-usage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hub answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { days: report.days.length, rows: report.days.reduce((a, d) => a + d.rows.length, 0) };
}
