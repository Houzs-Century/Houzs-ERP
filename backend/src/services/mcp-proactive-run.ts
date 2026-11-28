import type { Env } from "../types";
import type { AuthUser } from "./auth";
import { sendEmail } from "./email";
import { mcpIdentity, readAs, type InnerCaller } from "../routes/mcp";
import { rememberVerified } from "./mcp-inner";
import { issueTokens, logCall, randomToken, revokeToken } from "./mcp-store";
import { runRound3Tool, type R3Ctx } from "./mcp-round3";
import { openSalesOrders, pagedRows } from "./mcp-faq";
import { addDays } from "./mcp-brief";
import {
  ALERT_THRESHOLDS,
  alertEmail,
  BRIEF_SETTINGS,
  briefDue,
  briefEmail,
  debounceSince,
  DEFAULT_PREFS,
  freshAlerts,
  isMondayMyt,
  mytClock,
  poAlerts,
  slaAlerts,
  soAlerts,
  stockAlerts,
  type Alert,
  type BriefDays,
  type BriefPrefs,
} from "./mcp-proactive";

type Db = Env["DB"];
type Obj = Record<string, unknown>;

/** The OAuth client the scheduled brief's short-lived tokens are issued to (revoked as soon as the run ends). */
export const BRIEF_CLIENT_ID = "mcpc_brief";

export type Subscription = { userId: number; prefs: BriefPrefs; lastBriefDay: string | null; unsubscribeToken: string };

const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "t" || v === "true";
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

function subFrom(r: Obj): Subscription {
  const days = s(r.brief_days) === "daily" ? "daily" : "weekdays";
  return {
    userId: Number(r.user_id),
    prefs: { briefEnabled: bool(r.brief_enabled), time: s(r.brief_time) || DEFAULT_PREFS.time, days: days as BriefDays, alertsEnabled: bool(r.alerts_enabled) },
    lastBriefDay: s(r.last_brief_day) || null,
    unsubscribeToken: s(r.unsubscribe_token),
  };
}

const SUB_COLS = "user_id, brief_enabled, brief_time, brief_days, alerts_enabled, unsubscribe_token, last_brief_day";

export async function getSubscription(db: Db, userId: number): Promise<Subscription | null> {
  const r = await db.prepare(`SELECT ${SUB_COLS} FROM mcp_brief_subscriptions WHERE user_id = ?`).bind(userId).first<Obj>();
  return r ? subFrom(r) : null;
}

/** Save a person's choices (insert with a fresh unsubscribe token, or update). */
export async function saveSubscription(db: Db, userId: number, prefs: BriefPrefs): Promise<Subscription> {
  const now = new Date().toISOString();
  const r = await db
    .prepare(
      `INSERT INTO mcp_brief_subscriptions (user_id, brief_enabled, brief_time, brief_days, alerts_enabled, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET brief_enabled = EXCLUDED.brief_enabled, brief_time = EXCLUDED.brief_time, brief_days = EXCLUDED.brief_days,
         alerts_enabled = EXCLUDED.alerts_enabled, updated_at = EXCLUDED.updated_at
       RETURNING ${SUB_COLS}`,
    )
    .bind(userId, prefs.briefEnabled, prefs.time, prefs.days, prefs.alertsEnabled, randomToken(24), now, now)
    .first<Obj>();
  if (!r) throw new Error("subscription not saved");
  return subFrom(r);
}

/** One-click unsubscribe: both switches off for the token's person. True when a row matched. */
export async function unsubscribeByToken(db: Db, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return false;
  const r = await db
    .prepare("UPDATE mcp_brief_subscriptions SET brief_enabled = false, alerts_enabled = false, updated_at = ? WHERE unsubscribe_token = ? RETURNING user_id")
    .bind(new Date().toISOString(), token)
    .first<Obj>();
  return !!r;
}

export const unsubscribeUrl = (origin: string, token: string): string => `${origin}/api/mcp/brief/unsubscribe/${encodeURIComponent(token)}`;
export const settingsUrl = (origin: string): string => `${origin}/ai-connector`;

/** The public origin the scheduled job builds links on and re-enters the app at. */
export const cronOrigin = (env: Env): string => (env.PUBLIC_APP_URL || (env as Env & { MCP_PUBLIC_ORIGIN?: string }).MCP_PUBLIC_ORIGIN || "https://erp.houzscentury.com").replace(/\/+$/, "");

async function ensureBriefClient(db: Db): Promise<void> {
  await db
    .prepare("INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, 'Morning brief', '[]', ?) ON CONFLICT (client_id) DO NOTHING")
    .bind(BRIEF_CLIENT_ID, new Date().toISOString())
    .run();
}

type AsPerson<T> = { ok: true; value: T; user: AuthUser; tokenId: string } | { ok: false; reason: string };

/**
 * Run `work` AS this person, exactly like a connector call: a short-lived
 * connector token (the leak check's pattern), checked by mcpIdentity (active,
 * still allowed to use the connector), every read through readAs (the in-process
 * GET, credential strip, money strip). The token is revoked when `work` ends.
 */
export async function asPerson<T>(k: InnerCaller, userId: number, work: (ctx: R3Ctx, user: AuthUser) => Promise<T>): Promise<AsPerson<T>> {
  const db = k.env.DB;
  await ensureBriefClient(db);
  const tok = await issueTokens(db, userId, BRIEF_CLIENT_ID);
  try {
    const id = await mcpIdentity(k.env, tok.accessToken);
    if (!id) return { ok: false, reason: "no connector access (inactive, or access removed)" };
    rememberVerified(tok.accessToken, id, Date.now());
    const ctx: R3Ctx = { read: (p, q) => readAs(k, tok.accessToken, p, q, null), origin: k.origin, userId, bucket: k.env.POD_BUCKET, now: Date.now() };
    return { ok: true, value: await work(ctx, id.user), user: id.user, tokenId: tok.tokenId };
  } finally {
    await revokeToken(db, tok.tokenId, null);
  }
}

const toolJson = async (ctx: R3Ctx, name: string): Promise<unknown | null> => {
  const o = await runRound3Tool(ctx, name, {});
  if (o.result.isError) return null;
  try {
    return JSON.parse(o.result.content[0]?.text ?? "null");
  } catch {
    return null;
  }
};

export type SendOutcome = { status: "sent" | "skipped" | "error"; note: string; items: number };

/** Build and send one person's brief now (the cron after its claim, or the "send me a test" button). */
export async function sendBriefFor(k: InnerCaller, sub: Subscription, nowMs: number, test: boolean): Promise<SendOutcome> {
  const t0 = Date.now();
  const today = mytClock(nowMs).day;
  const withGaps = test || isMondayMyt(nowMs);
  const got = await asPerson(k, sub.userId, async (ctx) => ({ brief: await toolJson(ctx, "daily_brief"), gaps: withGaps ? await toolJson(ctx, "data_gaps") : null }));
  if (!got.ok) return { status: "skipped", note: got.reason, items: 0 };
  if (got.value.brief === null) return { status: "error", note: "the brief could not be built", items: 0 };
  const unsub = unsubscribeUrl(k.origin, sub.unsubscribeToken);
  const mail = briefEmail({ name: got.user.name ?? "", today, brief: got.value.brief, gaps: got.value.gaps, origin: k.origin, unsubscribeUrl: unsub, settingsUrl: settingsUrl(k.origin) });
  const res = await sendEmail(k.env, {
    to: got.user.email,
    subject: test ? `[Test] ${mail.subject}` : mail.subject,
    html: mail.html,
    purpose: "ai_brief",
    refType: "mcp_brief",
    refId: sub.userId,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  const status = res.status === "sent" ? "sent" : res.status === "skipped" ? "skipped" : "error";
  const note = res.status === "sent" ? "" : (res.reason ?? res.status).slice(0, 200);
  await logCall(k.env.DB, {
    tokenId: got.tokenId,
    userId: sub.userId,
    clientId: BRIEF_CLIENT_ID,
    tool: "email:daily_brief",
    target: `brief:${today} items=${mail.items}${withGaps ? " +data_gaps" : ""}${test ? " (test)" : ""}`,
    status: status === "sent" ? 200 : status === "skipped" ? 204 : 502,
    ok: status === "sent",
    note,
    ms: Date.now() - t0,
  });
  return { status, note, items: mail.items };
}

/** Was a test brief sent to this person in the last few minutes? (the button's cooldown) */
export async function recentTestBrief(db: Db, userId: number, nowMs: number): Promise<boolean> {
  const since = new Date(nowMs - BRIEF_SETTINGS.testCooldownMinutes * 60_000).toISOString();
  const r = await db
    .prepare("SELECT id FROM mcp_calls WHERE user_id = ? AND tool = 'email:daily_brief' AND created_at > ? AND target LIKE '%(test)' LIMIT 1")
    .bind(userId, since)
    .first();
  return !!r;
}

export type RunSummary = { due: number; processed: number; sent: number; skipped: number; failed: number; deferred: number };

/**
 * The 15-minute brief run: everyone whose brief is due, at most batchPerRun and
 * runBudgetMs per run (the rest go next run, still inside the catch-up window).
 * Each person is claimed for today BEFORE building (UPDATE ... WHERE
 * last_brief_day <> today RETURNING), so a rerun or an overlapping run never
 * sends twice.
 */
export async function runBriefs(env: Env, execCtx: unknown, nowMs: number): Promise<RunSummary> {
  const k: InnerCaller = { env, ctx: execCtx, origin: cronOrigin(env) };
  const today = mytClock(nowMs).day;
  const rows = await env.DB
    .prepare(`SELECT ${SUB_COLS} FROM mcp_brief_subscriptions WHERE brief_enabled = true AND (last_brief_day IS NULL OR last_brief_day <> ?) ORDER BY user_id`)
    .bind(today)
    .all<Obj>();
  const due = rows.results.map(subFrom).filter((x) => briefDue(x, nowMs));
  const out: RunSummary = { due: due.length, processed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const started = Date.now();
  let attempted = 0;
  for (const sub of due.slice(0, BRIEF_SETTINGS.batchPerRun)) {
    if (Date.now() - started > BRIEF_SETTINGS.runBudgetMs) break;
    attempted += 1;
    // eslint-disable-next-line no-await-in-loop -- one person at a time: bounds DB and Worker load per run
    const claimed = await env.DB
      .prepare("UPDATE mcp_brief_subscriptions SET last_brief_day = ? WHERE user_id = ? AND brief_enabled = true AND (last_brief_day IS NULL OR last_brief_day <> ?) RETURNING user_id")
      .bind(today, sub.userId, today)
      .first();
    if (!claimed) continue;
    out.processed += 1;
    try {
      // eslint-disable-next-line no-await-in-loop -- one person at a time: bounds DB and Worker load per run
      const r = await sendBriefFor(k, sub, nowMs, false);
      if (r.status === "sent") out.sent += 1;
      else if (r.status === "skipped") out.skipped += 1;
      else out.failed += 1;
    } catch (e) {
      out.failed += 1;
      console.error(`[mcp-brief] user ${sub.userId}:`, e instanceof Error ? e.message : String(e));
    }
  }
  out.deferred = due.length - attempted;
  return out;
}

async function collectAlerts(ctx: R3Ctx, today: string, nowMs: number): Promise<Alert[]> {
  const t = ALERT_THRESHOLDS;
  const [sos, pos, sla, stock] = await Promise.all([
    openSalesOrders(ctx, addDays(today, -1)),
    pagedRows(ctx, "/api/scm/mfg-purchase-orders", "purchaseOrders", { status: "outstanding", sort: "po_date:asc" }, 10),
    ctx.read("/api/assr/metrics/drill", { metric: "breach_now", limit: 500 }),
    t.stockNegative ? ctx.read("/api/scm/inventory/products", undefined) : Promise.resolve(null),
  ]);
  return [
    ...(sos.ok ? soAlerts(sos.rows, today, ctx.origin, t) : []),
    ...(pos.ok ? poAlerts(pos.rows, today, ctx.origin, t) : []),
    ...(sla.ok ? slaAlerts(sla.value, nowMs, ctx.origin, t) : []),
    ...(stock && stock.ok ? stockAlerts(stock.value, ctx.origin) : []),
  ];
}

async function claimAlertKeysInsertedNow(db: Db, userId: number, today: string, alerts: readonly Alert[]): Promise<Alert[]> {
  const claimed: Alert[] = [];
  for (const a of alerts) {
    // eslint-disable-next-line no-await-in-loop -- at most maxLinesPerEmail inserts, each a single-row claim
    const r = await db
      .prepare("INSERT INTO mcp_alert_sent (user_id, alert_key, sent_day, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING alert_key")
      .bind(userId, a.key, today, new Date().toISOString())
      .first();
    if (r) claimed.push(a);
  }
  return claimed;
}

/**
 * The 30-minute alert check: opted-in people, least recently checked first, at
 * most batchPerRun and runBudgetMs per run. Each check runs as the person;
 * a list they cannot read gives no alert. Debounced by mcp_alert_sent.
 */
export async function runAlerts(env: Env, execCtx: unknown, nowMs: number): Promise<RunSummary> {
  const k: InnerCaller = { env, ctx: execCtx, origin: cronOrigin(env) };
  const t = ALERT_THRESHOLDS;
  const today = mytClock(nowMs).day;
  const rows = await env.DB
    .prepare(`SELECT ${SUB_COLS} FROM mcp_brief_subscriptions WHERE alerts_enabled = true ORDER BY last_alert_check_at ASC NULLS FIRST, user_id LIMIT ?`)
    .bind(t.batchPerRun)
    .all<Obj>();
  const subs = rows.results.map(subFrom);
  const out: RunSummary = { due: subs.length, processed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const started = Date.now();
  for (const sub of subs) {
    if (Date.now() - started > t.runBudgetMs) break;
    out.processed += 1;
    const t0 = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop -- one person at a time: bounds DB and Worker load per run
      await env.DB.prepare("UPDATE mcp_brief_subscriptions SET last_alert_check_at = ? WHERE user_id = ?").bind(new Date(nowMs).toISOString(), sub.userId).run();
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      const got = await asPerson(k, sub.userId, (ctx) => collectAlerts(ctx, today, nowMs));
      if (!got.ok) {
        out.skipped += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      const recent = await env.DB.prepare("SELECT alert_key FROM mcp_alert_sent WHERE user_id = ? AND sent_day >= ?").bind(sub.userId, debounceSince(today, t)).all<Obj>();
      const fresh = freshAlerts(got.value, new Set(recent.results.map((r) => s(r.alert_key))), t);
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      const claimed = fresh.length ? await claimAlertKeysInsertedNow(env.DB, sub.userId, today, fresh) : [];
      if (!claimed.length) continue;
      const unsub = unsubscribeUrl(k.origin, sub.unsubscribeToken);
      const mail = alertEmail({ name: got.user.name ?? "", alerts: claimed, origin: k.origin, unsubscribeUrl: unsub, settingsUrl: settingsUrl(k.origin) });
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      const res = await sendEmail(env, {
        to: got.user.email,
        subject: mail.subject,
        html: mail.html,
        purpose: "ai_alert",
        refType: "mcp_alert",
        refId: sub.userId,
        headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      if (res.status === "sent") out.sent += 1;
      else if (res.status === "skipped") out.skipped += 1;
      else out.failed += 1;
      const kinds = [...new Set(claimed.map((a) => a.kind))].join(",");
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      await logCall(env.DB, {
        tokenId: got.tokenId,
        userId: sub.userId,
        clientId: BRIEF_CLIENT_ID,
        tool: "email:alerts",
        target: `alerts:${today} items=${claimed.length} kinds=${kinds}`,
        status: res.status === "sent" ? 200 : res.status === "skipped" ? 204 : 502,
        ok: res.status === "sent",
        note: res.status === "sent" ? "" : (res.reason ?? res.status).slice(0, 200),
        ms: Date.now() - t0,
      });
    } catch (e) {
      out.failed += 1;
      console.error(`[mcp-alerts] user ${sub.userId}:`, e instanceof Error ? e.message : String(e));
    }
  }
  out.deferred = subs.length - out.processed;
  return out;
}
