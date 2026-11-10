// GET /api/badge-counts (routes/badgeCounts.ts): every sidebar count in one
// request. Pinned: only allow-listed sources are dispatched, each to its own
// existing endpoint with the caller's identity headers (so that endpoint's
// gates decide), and anything but a 200 { count } is null — no badge.
import { describe, expect, it } from "vitest";
import {
  BADGE_COUNT_PATHS,
  badgeCountsRouter,
  forwardedHeaders,
  parseBadgeSources,
  readBadgeCount,
  type BadgeDispatch,
} from "../src/routes/badgeCounts";

function recorder(answers: Record<string, () => Response>) {
  const seen: Request[] = [];
  const dispatch: BadgeDispatch = async (_c, req) => {
    seen.push(req);
    const path = new URL(req.url).pathname;
    const answer = answers[path];
    if (!answer) throw new Error(`no answer for ${path}`);
    return answer();
  };
  return { seen, dispatch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("parseBadgeSources", () => {
  it("keeps known names once, in order, and drops anything else", () => {
    expect(parseBadgeSources("finance-todo, amendment-approvals,finance-todo,/api/users,")).toEqual([
      "finance-todo",
      "amendment-approvals",
    ]);
    expect(parseBadgeSources(undefined)).toEqual([]);
    expect(parseBadgeSources("constructor,__proto__,toString")).toEqual([]);
  });
});

describe("readBadgeCount", () => {
  it("is the count on a 200 and null on anything else", async () => {
    expect(await readBadgeCount(json({ count: 4 }))).toBe(4);
    expect(await readBadgeCount(json({ count: 0 }))).toBe(0);
    expect(await readBadgeCount(json({ error: "forbidden" }, 403))).toBeNull();
    expect(await readBadgeCount(json({ error: "x" }, 500))).toBeNull();
    expect(await readBadgeCount(json({ count: "many" }))).toBeNull();
    expect(await readBadgeCount(new Response("not json", { status: 200 }))).toBeNull();
  });
});

describe("forwardedHeaders", () => {
  it("carries who is asking, not what this request was", () => {
    const h = forwardedHeaders(
      new Headers({
        Authorization: "Bearer t",
        "X-Company-Id": "2",
        "X-Session-Pass": "p",
        "If-None-Match": '"abc"',
        "Idempotency-Key": "k",
      }),
    );
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("x-company-id")).toBe("2");
    expect(h.get("x-session-pass")).toBe("p");
    expect(h.has("if-none-match")).toBe(false);
    expect(h.has("idempotency-key")).toBe(false);
  });
});

describe("GET /api/badge-counts", () => {
  it("dispatches each asked source to its own endpoint with the caller's headers", async () => {
    const { seen, dispatch } = recorder({
      [BADGE_COUNT_PATHS["amendment-approvals"]]: () => json({ count: 3 }),
      [BADGE_COUNT_PATHS["finance-todo"]]: () => json({ error: "forbidden" }, 403),
      [BADGE_COUNT_PATHS["it-support-replies"]]: () => {
        throw new Error("hub down");
      },
    });
    const app = badgeCountsRouter(dispatch);
    const res = await app.request(
      "https://erp.test/?sources=amendment-approvals,finance-todo,it-support-replies,not-a-source",
      { headers: { Authorization: "Bearer caller", "X-Company-Id": "9" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      counts: { "amendment-approvals": 3, "finance-todo": null, "it-support-replies": null },
    });
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /api/scm/so-amendments/pending-count",
      "GET /api/scm/accounting/todo/count",
      "GET /api/it-support/unread-count",
    ]);
    for (const r of seen) {
      expect(r.headers.get("authorization")).toBe("Bearer caller");
      expect(r.headers.get("x-company-id")).toBe("9");
      expect(new URL(r.url).origin).toBe("https://erp.test");
    }
  });

  it("asks nothing when no known source is named", async () => {
    const { seen, dispatch } = recorder({});
    const res = await badgeCountsRouter(dispatch).request("https://erp.test/?sources=");
    expect(await res.json()).toEqual({ counts: {} });
    expect(seen).toHaveLength(0);
  });

  it("is mounted behind the /api/* auth gate and dispatches through the whole app", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const index = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
    const mount = index.indexOf('app.route("/api/badge-counts", badgeCounts);');
    expect(mount).toBeGreaterThan(0);
    expect(index.indexOf('app.use("/api/*", auth);')).toBeLessThan(mount);
    const wiring = index.indexOf("setBadgeDispatch(");
    expect(wiring).toBeGreaterThan(0);
    expect(index.slice(wiring, mount)).toContain("app.fetch(req, c.env, ctx)");
  });
});
