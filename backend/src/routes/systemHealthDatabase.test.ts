// @vitest-project light
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import health from "./systemHealth";
import { connectionVerdict, lockWaitVerdict, longTransactionVerdict, POOLER_CONNECTION_CAP } from "./systemHealthDatabase";

// Canned catalog answers, one per metric in the order the route reads them.
const { rows } = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown> | Error> }));
vi.mock("../db/client", () => ({
  getDb: () => ({
    transaction: async (cb: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) => {
      let call = 0;
      return cb({
        execute: async () => {
          if (call++ === 0) return []; // SET LOCAL statement_timeout
          const next = rows.shift();
          if (next instanceof Error) throw next;
          return [next];
        },
      });
    },
  }),
}));

describe("database load verdicts", () => {
  it("long transactions: over 30 s warns, over 5 min is critical", () => {
    expect(longTransactionVerdict(null)).toBe("ok");
    expect(longTransactionVerdict(30)).toBe("ok");
    expect(longTransactionVerdict(30.5)).toBe("warning");
    expect(longTransactionVerdict(300)).toBe("warning");
    expect(longTransactionVerdict(301)).toBe("critical");
  });

  it("lock waits: 1 warns, 5 or a wait over 60 s is critical", () => {
    expect(lockWaitVerdict(0, null)).toBe("ok");
    expect(lockWaitVerdict(1, 2)).toBe("warning");
    expect(lockWaitVerdict(4, 60)).toBe("warning");
    expect(lockWaitVerdict(5, 1)).toBe("critical");
    expect(lockWaitVerdict(1, 61)).toBe("critical");
  });

  it("connections: above 70% of the limit warns, above 90% is critical", () => {
    expect(connectionVerdict(42, POOLER_CONNECTION_CAP)).toBe("ok");
    expect(connectionVerdict(43, POOLER_CONNECTION_CAP)).toBe("warning");
    expect(connectionVerdict(54, POOLER_CONNECTION_CAP)).toBe("warning");
    expect(connectionVerdict(55, POOLER_CONNECTION_CAP)).toBe("critical");
  });
});

function appAs(permissions: string[]) {
  const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: 1, permissions });
    await next();
  });
  app.route("/", health);
  return app;
}

describe("GET /database", () => {
  it("sits behind the IT-pages gate", async () => {
    const res = await appAs(["scm.access"]).request("/database");
    expect(res.status).toBe(403);
  });

  it("assembles every metric, flags hidden sessions, and isolates a failed read", async () => {
    rows.push(
      { hidden: 2, count: 1, top: JSON.stringify([{ seconds: 400, state: "idle in transaction", waitEventType: null, query: "x" }]) },
      new Error("canceling statement due to statement timeout"),
      { used: 50, hidden: 2, maxConnections: 100 },
      { bytes: 1024, largest: "[]" },
      { tempFiles: 0, tempBytes: 0, statsReset: null },
    );
    const res = await appAs(["it.view"]).request("/database");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.limitedVisibility).toBe(true);
    expect(body.visibilityNote).toContain("2 other session");
    expect(body.longTransactions).toMatchObject({ ok: true, value: 1, verdict: "critical" });
    expect(body.lockWaits).toEqual({ ok: false, error: "canceling statement due to statement timeout" });
    expect(body.connections).toMatchObject({ ok: true, value: 50, limit: 60, verdict: "warning", maxConnections: 100 });
    expect(body.databaseSize).toMatchObject({ ok: true, verdict: "ok", largestTables: [] });
    expect(body.tempFiles).toMatchObject({ ok: true, verdict: "ok" });
  });
});
