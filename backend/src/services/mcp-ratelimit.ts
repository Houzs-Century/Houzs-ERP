import type { Env } from "../types";

type Db = Env["DB"];

export const RATE_PER_MINUTE = 30;
export const RATE_PER_DAY = 600;
export const RATE_LIMITED_NOTE = "rate limited";
export const TOO_MANY_PER_MINUTE = "Too many requests — wait a minute and try again.";
export const DAILY_LIMIT_REACHED = "Daily limit reached — the AI connector allows 600 lookups per person per day. Try again tomorrow, or use the ERP directly.";

export type CallCounts = { minute: number; day: number };

/** The refusal for these counts, or null when the call may go ahead. */
export function rateDecision(n: CallCounts): string | null {
  if (n.day >= RATE_PER_DAY) return DAILY_LIMIT_REACHED;
  if (n.minute >= RATE_PER_MINUTE) return TOO_MANY_PER_MINUTE;
  return null;
}

/** This person's counted calls in the last minute and the last 24 h (one indexed read). */
export async function recentCallCounts(db: Db, userId: number, now: number): Promise<CallCounts> {
  const minuteAgo = new Date(now - 60_000).toISOString();
  const dayAgo = new Date(now - 24 * 3600_000).toISOString();
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS m, COUNT(*) AS d
         FROM mcp_calls
        WHERE user_id = ? AND created_at > ? AND (note IS NULL OR note <> ?)`,
    )
    .bind(minuteAgo, userId, dayAgo, RATE_LIMITED_NOTE)
    .first<Record<string, unknown>>();
  return { minute: Number(r?.m ?? 0) || 0, day: Number(r?.d ?? 0) || 0 };
}

/**
 * The refusal text when this person is over a limit, else null. If the count
 * cannot be read the call goes ahead (logged): a broken counter must not take
 * the connector down; the call log itself is the record.
 */
export async function rateLimitRefusal(db: Db, userId: number, now: number): Promise<string | null> {
  try {
    return rateDecision(await recentCallCounts(db, userId, now));
  } catch (e) {
    console.warn("[mcp] rate-limit count failed, call allowed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}


export const ANSWER_CACHE_TTL_MS = 30_000;
const ANSWER_CACHE_MAX = 300;

export class TtlCache<T> {
  private readonly m = new Map<string, { at: number; v: T }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}
  get(key: string, now: number): T | undefined {
    const hit = this.m.get(key);
    if (!hit) return undefined;
    if (now - hit.at >= this.ttlMs) {
      this.m.delete(key);
      return undefined;
    }
    return hit.v;
  }
  set(key: string, v: T, now: number): void {
    if (this.m.size >= this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(key, { at: now, v });
  }
  get size(): number {
    return this.m.size;
  }
}

/** Arguments in a stable order, so {a,b} and {b,a} share a cache entry. */
export function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
}

export const answerCacheKey = (userId: number, company: string | null, tool: string, args: Record<string, unknown>): string =>
  `${userId}|${company ?? ""}|${tool}|${stableArgs(args)}`;

type Cacheable = { result: { isError?: boolean }; status: number };
const answerCache = new TtlCache<unknown>(ANSWER_CACHE_TTL_MS, ANSWER_CACHE_MAX);

/** Run `make` unless the same person asked the same thing within 30 s; only successful answers are kept. */
export async function cachedAnswer<T extends Cacheable>(key: string, now: number, make: () => Promise<T>): Promise<T & { cached?: true }> {
  const hit = answerCache.get(key, now) as T | undefined;
  if (hit) return { ...hit, cached: true };
  const v = await make();
  if (!v.result.isError && v.status < 400) answerCache.set(key, v, now);
  return v;
}
