// ---------------------------------------------------------------------------
// aiUsage.ts — one row per Anthropic call into public.ai_usage_events, and the
// monthly cost report the IT "AI Usage" page reads (routes/aiUsage.ts).
//
// Recording is fire-and-forget by contract: nothing here may throw into a call
// site or change what it returns. Each site wraps its fetch:
// `await recordAi(tag, fetch(...))`. The body is read from a clone, so the
// caller's own read is untouched; a fetch that throws is recorded and rethrown.
// docs/modules/ai-usage.md lists the feature names.
// ---------------------------------------------------------------------------
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { resolveDatabaseUrl } from "../db/pg";
import { activeCompanyId, type CompanyScopeCtx } from "../scm/lib/companyScope";
import { USD_TO_MYR_EST, mytDate, mytMonth, mytMonthRangeUtc, taskFamily } from "./agent-console";

// ── Prices ───────────────────────────────────────────────────────────────────
// USD per million tokens, from Anthropic's public price list (claude.com/pricing)
// as of 2026-10. UPDATE THIS when any call site changes model; a model missing
// here is priced as DEFAULT_PRICE_MODEL. cacheWrite is the 5-minute TTL price.
// scan_so and cache_warm write their catalog prefix with the 1-hour TTL, which
// Anthropic bills at 2x input ($6), so their cache-write cost reads LOW here.
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }
export const AI_PRICES_USD_PER_MTOK: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const DEFAULT_PRICE_MODEL = "claude-sonnet-4-6";

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Anthropic reports input, cache-read and cache-write tokens as DISJOINT
 *  counts (input_tokens excludes both cache kinds), so each is priced once. */
export function costUsd(model: string, t: TokenCounts): number {
  const p = AI_PRICES_USD_PER_MTOK[model] ?? AI_PRICES_USD_PER_MTOK[DEFAULT_PRICE_MODEL];
  return (
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * p.cacheRead +
      t.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

export function usdToRm(usd: number): number {
  return usd * USD_TO_MYR_EST;
}

/** The feature name an agent family's calls are recorded under. Used by both the
 *  live recorder and the agent_runs back-fill so the two never split a family. */
export function agentFeature(family: string): string {
  return `agent:${family.toLowerCase()}`;
}

// ── Recorder ─────────────────────────────────────────────────────────────────

export interface AiUsageTag {
  env: Env;
  feature: string;
  model: string;
  companyId: number | null;
  userId: number | null;
  /** The request's waitUntil (waitUntilOf(c)); null means the write is awaited
   *  by whoever awaits the record call. */
  waitUntil: ((p: Promise<unknown>) => void) | null;
}

/** Hono's executionCtx getter THROWS when there is no ExecutionContext (tests,
 *  some internal calls), so read it defensively. */
export function waitUntilOf(c: { readonly executionCtx: { waitUntil(p: Promise<unknown>): void } }): AiUsageTag["waitUntil"] {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return null;
  }
}

/** Tag for a call made inside a request, native or /api/scm: the active company
 *  and the real Houzs user. In /api/scm `user` is one shared system staff row,
 *  so `houzsUser` wins there. */
export function requestAiTag(
  c: CompanyScopeCtx & { env: Env; readonly executionCtx: { waitUntil(p: Promise<unknown>): void } },
  feature: string,
  model: string,
): AiUsageTag {
  const idOf = (key: string): number | null => {
    const v = (c.get(key) as { id?: unknown } | undefined)?.id;
    return typeof v === "number" ? v : null;
  };
  return {
    env: c.env,
    feature,
    model,
    companyId: activeCompanyId(c) ?? null,
    userId: idOf("houzsUser") ?? idOf("user"),
    waitUntil: waitUntilOf(c),
  };
}

/** One public.ai_usage_events row, as written (id and created_at are defaults). */
export interface AiUsageRow {
  feature: string;
  company_id: number | null;
  user_id: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ok: boolean;
  error: string | null;
  http_status: number | null;
}

const ERROR_MAX = 500;

/** Pure: what one call writes. `body` is the raw response text, an already
 *  parsed object, or the thrown error when `httpStatus` is null. */
export function aiUsageRow(
  tag: Pick<AiUsageTag, "feature" | "model" | "companyId" | "userId">,
  httpStatus: number | null,
  body: unknown,
): AiUsageRow {
  let json: Record<string, unknown> | null = null;
  if (typeof body === "string") {
    try {
      const v: unknown = JSON.parse(body);
      if (v && typeof v === "object") json = v as Record<string, unknown>;
    } catch {
      /* not JSON: recorded as the error text below */
    }
  } else if (body && typeof body === "object" && !(body instanceof Error)) {
    json = body as Record<string, unknown>;
  }
  const apiError = json?.error as { type?: string; message?: string } | undefined;
  const ok = httpStatus !== null && httpStatus >= 200 && httpStatus < 300 && json !== null && !apiError;
  const usage = (json?.usage ?? {}) as Record<string, unknown>;
  const n = (k: string) => Math.max(0, Math.round(Number(usage[k]) || 0));

  let error: string | null = null;
  if (!ok) {
    if (apiError) error = `${apiError.type ?? "error"}: ${apiError.message ?? ""}`;
    else if (body instanceof Error) error = `${body.name}: ${body.message}`;
    else if (typeof body === "string" && body.trim()) error = body.trim();
    else error = httpStatus === null ? "request failed" : `HTTP ${httpStatus}`;
    error = error.slice(0, ERROR_MAX);
  }

  return {
    feature: tag.feature,
    company_id: tag.companyId,
    user_id: tag.userId,
    model: typeof json?.model === "string" ? json.model : tag.model,
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_read_tokens: n("cache_read_input_tokens"),
    cache_write_tokens: n("cache_creation_input_tokens"),
    ok,
    error,
    http_status: httpStatus,
  };
}

async function insertRow(env: Env, row: AiUsageRow): Promise<void> {
  // No Postgres configured (vitest pins DATABASE_URL to ""): nothing to record to.
  if (!resolveDatabaseUrl(env)) return;
  // Through the invocation's own env.DB (dbInject / withPgDb), NOT getDb: getDb
  // opens a fresh socket that is never closed, and a cron or agent loop records
  // many calls in one invocation, past the Worker's open-connection cap.
  await env.DB.prepare(
    `INSERT INTO public.ai_usage_events
       (feature, company_id, user_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, ok, error, http_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.feature, row.company_id, row.user_id, row.model,
      row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens,
      row.ok, row.error, row.http_status,
    )
    .run();
}

function schedule(tag: AiUsageTag, row: Promise<AiUsageRow>): Promise<void> {
  const work = row
    .then((r) => insertRow(tag.env, r))
    .catch((e: unknown) => {
      console.warn(`[ai-usage] ${tag.feature} not recorded:`, e instanceof Error ? e.message : e);
    });
  if (tag.waitUntil) {
    try {
      tag.waitUntil(work);
      return Promise.resolve();
    } catch {
      /* fall through: the caller's await covers it */
    }
  }
  return work;
}

/** Record one Anthropic response. Call right after the fetch, before the caller
 *  reads the body. Never rejects. A null tag (tests) records nothing. */
export function recordAiResponse(tag: AiUsageTag | null, resp: Response): Promise<void> {
  if (!tag) return Promise.resolve();
  try {
    const copy = resp.clone();
    return schedule(tag, copy.text().then(
      (t) => aiUsageRow(tag, resp.status, t),
      (e: unknown) => aiUsageRow(tag, resp.status, e),
    ));
  } catch (e) {
    return schedule(tag, Promise.resolve(aiUsageRow(tag, (resp as Response | undefined)?.status ?? null, e)));
  }
}

/** Record a call whose fetch threw (network error, timeout). Never rejects. */
export function recordAiError(tag: AiUsageTag | null, err: unknown): Promise<void> {
  if (!tag) return Promise.resolve();
  try {
    return schedule(tag, Promise.resolve(aiUsageRow(tag, null, err)));
  } catch {
    return Promise.resolve();
  }
}

/** Wrap a call site's fetch: `await recordAi(tag, fetch(...))`. Resolves to the
 *  same Response and rethrows the same error, recording exactly one row either
 *  way. Only the fetch is wrapped, so a caller's own catch never records twice. */
export async function recordAi(tag: AiUsageTag | null, call: Promise<Response>): Promise<Response> {
  let resp: Response;
  try {
    resp = await call;
  } catch (e) {
    await recordAiError(tag, e);
    throw e;
  }
  await recordAiResponse(tag, resp);
  return resp;
}

// ── Report ───────────────────────────────────────────────────────────────────

/** The last `n` MYT calendar months, oldest first, ending with `now`'s month. */
export function lastMonths(now: Date, n: number): string[] {
  const [y, m] = mytMonth(now).split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** One grouped row of ai_usage_events (month, feature, company, model). */
export interface EventAggRow extends TokenCounts {
  month: string;
  feature: string;
  companyId: number | null;
  companyName: string | null;
  model: string;
  calls: number;
  failures: number;
}

/** One grouped row of agent_runs (month, task id). */
export interface AgentRunAggRow {
  month: string;
  agent: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface FeatureUsage extends TokenCounts {
  feature: string;
  calls: number;
  failures: number;
  rm: number;
}

export interface CompanyUsage {
  companyId: number | null;
  companyName: string | null;
  rm: number;
}

export interface MonthUsage {
  month: string;
  totalRm: number;
  partial: boolean;
  note: string | null;
  features: FeatureUsage[];
  companies: CompanyUsage[];
}

export interface AiUsageReport {
  months: MonthUsage[];
  usdToRm: number;
  firstRecordedAt: string | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: build the per-month report. Months before the first recorded event come
 *  from agent_runs only (partial); from that month on, only from events, so the
 *  two sources never add up in the same month. */
export function buildAiUsageReport(input: {
  months: string[];
  firstRecordedAt: string | null;
  events: EventAggRow[];
  agentRuns: AgentRunAggRow[];
}): AiUsageReport {
  const firstMonth = input.firstRecordedAt ? mytMonth(new Date(input.firstRecordedAt)) : null;

  const months = input.months.map((month): MonthUsage => {
    const backfill = firstMonth === null || month < firstMonth;
    const rows: EventAggRow[] = backfill
      ? input.agentRuns
          .filter((r) => r.month === month)
          .map((r) => ({
            month,
            feature: agentFeature(taskFamily(r.agent)),
            companyId: null,
            companyName: null,
            model: DEFAULT_PRICE_MODEL,
            calls: r.runs,
            failures: 0,
            inputTokens: r.tokensIn,
            outputTokens: r.tokensOut,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }))
      : input.events.filter((r) => r.month === month);

    const features = new Map<string, FeatureUsage>();
    const companies = new Map<string, CompanyUsage>();
    let total = 0;
    for (const r of rows) {
      const rm = usdToRm(costUsd(r.model, r));
      total += rm;
      const f = features.get(r.feature) ?? {
        feature: r.feature, calls: 0, failures: 0, rm: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      };
      f.calls += r.calls;
      f.failures += r.failures;
      f.inputTokens += r.inputTokens;
      f.outputTokens += r.outputTokens;
      f.cacheReadTokens += r.cacheReadTokens;
      f.cacheWriteTokens += r.cacheWriteTokens;
      f.rm += rm;
      features.set(r.feature, f);
      const key = String(r.companyId);
      const co = companies.get(key) ?? { companyId: r.companyId, companyName: r.companyName, rm: 0 };
      co.rm += rm;
      companies.set(key, co);
    }

    let note: string | null = null;
    if (backfill) note = "Only agents were measured this month; other AI features were not recorded yet.";
    else if (month === firstMonth && input.firstRecordedAt) {
      note = `Recording started on ${mytDate(new Date(input.firstRecordedAt))}; earlier calls this month are not counted.`;
    }

    return {
      month,
      totalRm: round2(total),
      partial: backfill || month === firstMonth,
      note,
      features: [...features.values()]
        .map((f) => ({ ...f, rm: round2(f.rm) }))
        .sort((a, b) => b.rm - a.rm || a.feature.localeCompare(b.feature)),
      companies: [...companies.values()]
        .map((c) => ({ ...c, rm: round2(c.rm) }))
        .sort((a, b) => b.rm - a.rm),
    };
  });

  return { months, usdToRm: USD_TO_MYR_EST, firstRecordedAt: input.firstRecordedAt };
}

const num = (v: unknown) => Number(v) || 0;

/** Read the window from Postgres and build the report. IT-wide across companies
 *  by design: the only caller is behind requireItPages. */
export async function loadAiUsageReport(env: Env, monthCount: number, now: Date): Promise<AiUsageReport> {
  const months = lastMonths(now, monthCount);
  const { startIso } = mytMonthRangeUtc(months[0]);
  const { endIso } = mytMonthRangeUtc(months[months.length - 1]);
  const db = getDb(env);

  const first = await db.execute<{ first: string | Date | null }>(
    sql`SELECT min(created_at) AS first FROM public.ai_usage_events`,
  );
  const firstRaw = first.at(0)?.first ?? null;
  const firstRecordedAt = firstRaw === null ? null : new Date(firstRaw).toISOString();

  const events = await db.execute<Record<string, unknown>>(sql`
    SELECT to_char(e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM') AS month,
           e.feature, e.company_id, co.name AS company_name, e.model,
           count(*) AS calls,
           count(*) FILTER (WHERE NOT e.ok) AS failures,
           coalesce(sum(e.input_tokens), 0) AS input_tokens,
           coalesce(sum(e.output_tokens), 0) AS output_tokens,
           coalesce(sum(e.cache_read_tokens), 0) AS cache_read_tokens,
           coalesce(sum(e.cache_write_tokens), 0) AS cache_write_tokens
      FROM public.ai_usage_events e
      LEFT JOIN public.companies co ON co.id = e.company_id
     WHERE e.created_at >= ${startIso}::timestamptz AND e.created_at < ${endIso}::timestamptz
     GROUP BY 1, 2, 3, 4, 5`);

  // agent_runs.started_at is ISO text: a plain string compare bounds it (see
  // agent-console's MYT bucket note), the cast only labels the month.
  const runs = await db.execute<Record<string, unknown>>(sql`
    SELECT to_char(started_at::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM') AS month,
           agent,
           count(*) AS runs,
           coalesce(sum(tokens_in), 0) AS tokens_in,
           coalesce(sum(tokens_out), 0) AS tokens_out
      FROM public.agent_runs
     WHERE started_at >= ${startIso} AND started_at < ${endIso}
     GROUP BY 1, 2`);

  return buildAiUsageReport({
    months,
    firstRecordedAt,
    events: [...events].map((r) => ({
      month: String(r.month),
      feature: String(r.feature),
      companyId: r.company_id === null || r.company_id === undefined ? null : num(r.company_id),
      companyName: (r.company_name as string | null) ?? null,
      model: String(r.model),
      calls: num(r.calls),
      failures: num(r.failures),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cacheReadTokens: num(r.cache_read_tokens),
      cacheWriteTokens: num(r.cache_write_tokens),
    })),
    agentRuns: [...runs].map((r) => ({
      month: String(r.month),
      agent: String(r.agent),
      runs: num(r.runs),
      tokensIn: num(r.tokens_in),
      tokensOut: num(r.tokens_out),
    })),
  });
}
