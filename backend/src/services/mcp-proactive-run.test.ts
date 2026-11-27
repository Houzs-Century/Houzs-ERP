import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { mcpBriefPublic } from "../routes/mcpBrief";
import { cronOrigin, getSubscription, runAlerts, runBriefs, settingsUrl, unsubscribeByToken, unsubscribeUrl } from "./mcp-proactive-run";

type Call = { sql: string; args: unknown[] };
type Answer = { first?: unknown; all?: unknown[] };

function fakeDb(answer: (sql: string, args: unknown[]) => Answer) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first() {
          calls.push({ sql, args });
          return answer(sql, args).first ?? null;
        },
        async all() {
          calls.push({ sql, args });
          return { results: answer(sql, args).all ?? [] };
        },
        async run() {
          calls.push({ sql, args });
          return {};
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as Env["DB"], calls };
}

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const row = (o: Record<string, unknown> = {}) => ({ user_id: 9, brief_enabled: true, brief_time: "08:00", brief_days: "weekdays", alerts_enabled: false, unsubscribe_token: TOKEN, last_brief_day: null, ...o });

describe("subscriptions", () => {
  it("reads a row into prefs (Postgres booleans as 't' too)", async () => {
    const { db } = fakeDb(() => ({ first: row({ brief_enabled: "t", brief_days: "daily", last_brief_day: "2026-11-26" }) }));
    expect(await getSubscription(db, 9)).toEqual({ userId: 9, prefs: { briefEnabled: true, time: "08:00", days: "daily", alertsEnabled: false }, lastBriefDay: "2026-11-26", unsubscribeToken: TOKEN });
  });

  it("unsubscribe switches both off by token, and ignores a malformed token without touching the DB", async () => {
    const { db, calls } = fakeDb(() => ({ first: { user_id: 9 } }));
    expect(await unsubscribeByToken(db, "short")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await unsubscribeByToken(db, TOKEN)).toBe(true);
    expect(calls[0].sql).toContain("brief_enabled = false, alerts_enabled = false");
    expect(calls[0].args[1]).toBe(TOKEN);
  });

  it("links: unsubscribe in the path (not a query string), settings page, cron origin", () => {
    expect(unsubscribeUrl("https://erp.test", TOKEN)).toBe(`https://erp.test/api/mcp/brief/unsubscribe/${TOKEN}`);
    expect(settingsUrl("https://erp.test")).toBe("https://erp.test/ai-connector");
    expect(cronOrigin({ PUBLIC_APP_URL: "https://erp.test/" } as Env)).toBe("https://erp.test");
  });
});

describe("cron: bounded and idempotent", () => {
  it("a person already claimed for today (rerun / overlapping run) is not sent again", async () => {
    const { db, calls } = fakeDb((sql) => (sql.startsWith("SELECT") ? { all: [row()] } : {}));
    const r = await runBriefs({ DB: db } as Env, undefined, Date.parse("2026-11-27T00:05:00Z"));
    expect(r).toMatchObject({ due: 1, processed: 0, sent: 0, deferred: 0 });
    const claim = calls.find((c) => c.sql.startsWith("UPDATE mcp_brief_subscriptions SET last_brief_day"));
    expect(claim?.args).toEqual(["2026-11-27", 9, "2026-11-27"]);
    expect(calls.some((c) => c.sql.includes("mcp_tokens"))).toBe(false);
  });

  it("only due people are claimed; the rest wait for their time", async () => {
    const { db, calls } = fakeDb((sql) => (sql.startsWith("SELECT") ? { all: [row({ user_id: 1, brief_time: "09:00" }), row({ user_id: 2, brief_enabled: false })] } : {}));
    const r = await runBriefs({ DB: db } as Env, undefined, Date.parse("2026-11-27T00:05:00Z"));
    expect(r.due).toBe(0);
    expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("alerts read at most batchPerRun people, least recently checked first", async () => {
    const { db, calls } = fakeDb(() => ({ all: [] }));
    const r = await runAlerts({ DB: db } as Env, undefined, Date.now());
    expect(r.processed).toBe(0);
    expect(calls[0].sql).toContain("ORDER BY last_alert_check_at ASC NULLS FIRST");
    expect(calls[0].args).toEqual([10]);
  });
});

describe("public unsubscribe page", () => {
  it("GET only shows a button (a mail scanner opening the link changes nothing); POST unsubscribes", async () => {
    const { db, calls } = fakeDb(() => ({ first: { user_id: 9 } }));
    const env = { DB: db } as Env;
    const get = await mcpBriefPublic.request(`/unsubscribe/${TOKEN}`, {}, env);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('<form method="post"');
    expect(calls).toHaveLength(0);
    const post = await mcpBriefPublic.request(`/unsubscribe/${TOKEN}`, { method: "POST", body: "List-Unsubscribe=One-Click" }, env);
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("You are unsubscribed.");
    expect(calls).toHaveLength(1);
  });

  it("an unknown or malformed token is a 404 page", async () => {
    const { db } = fakeDb(() => ({}));
    const env = { DB: db } as Env;
    expect((await mcpBriefPublic.request("/unsubscribe/bad", {}, env)).status).toBe(404);
    expect((await mcpBriefPublic.request(`/unsubscribe/${TOKEN}`, { method: "POST" }, env)).status).toBe(404);
  });
});
