// POST / PATCH /api/announcements — the translation runs AFTER the response
// (2026-09-06).
//
// Until this change the create route awaited the four-language Claude call
// before INSERTing. A rich notice (HTML × 4 languages, up to 4096 tokens,
// three retries, no timeout) held "Posting…" for 40-100 s; the owner clicked
// again and again, and each click had in fact written a row — nine copies of
// one scheduled notice on 2026-09-06. Now the row is written with
// `translations = NULL`, the route answers, and `translateAndStore` fills the
// column under waitUntil. The fill is guarded on the text: a reply that lands
// after the notice was edited is dropped, the edit's own reply is stored.
//
// Same bare-Hono harness as announcementsRichBody.test.ts. The Claude call is
// a stubbed global fetch that hands back a deferred per call, so a test can
// answer the route first and let the "model" reply whenever it likes.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import announcementRoutes from "../src/routes/announcements";
import { translateAndStore } from "../src/lib/translate-announcement";

const MANAGER = {
  id: 607,
  department_id: null,
  position_id: null,
  position_name: null,
  permissions: ["announcements.write"],
  permissions_set: new Set(["announcements.write"]),
};

const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", MANAGER);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/announcements", announcementRoutes);

// The route only calls the model when a key is configured.
const KEYED_ENV = { ...env, ANTHROPIC_API_KEY: "test-key" };

type Pub = { id: string; title: string; translations: unknown };

async function post(payload: Record<string, unknown>) {
  const res = await app.request(
    "/api/announcements",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    KEYED_ENV as never,
  );
  const json = (await res.json()) as { success?: boolean; error?: string; data?: Pub };
  return { status: res.status, ...json };
}

async function patch(id: string, payload: Record<string, unknown>) {
  const res = await app.request(
    `/api/announcements/${id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    KEYED_ENV as never,
  );
  const json = (await res.json()) as { success?: boolean; error?: string; data?: Pub };
  return { status: res.status, ...json };
}

async function storedTranslations(id: string): Promise<Record<string, { title: string }> | null> {
  const row = await env.DB.prepare("SELECT translations FROM announcements WHERE id = ?")
    .bind(id)
    .first<{ translations: string | null }>();
  return row?.translations ? JSON.parse(row.translations) : null;
}

/** Poll until the background fill lands (or give up after ~3 s). */
async function untilTranslated(id: string) {
  for (let i = 0; i < 120; i += 1) {
    const t = await storedTranslations(id);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

const settle = () => new Promise((r) => setTimeout(r, 150));

type Deferred = {
  resolve: (r: Response) => void;
  sentText: string;
};
let calls: Deferred[] = [];

function claudeReply(title: string, body = "") {
  const one = { title, body };
  const langs = { en: one, ms: one, zh: one, bn: one };
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(langs) }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS announcements (
       id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
       expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
       updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
       target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
       target_user_ids TEXT, target_company_ids TEXT, category TEXT,
       source TEXT, company_id INTEGER, require_ack INTEGER, scheduled_at TEXT,
       target_divisions TEXT, excluded_user_ids TEXT, escalated_at TEXT)`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS announcement_acks (
       announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT,
       company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
  ).run();
});

// The fetch stub is installed per test (not per file) so a test that never
// resolves one of its deferreds cannot leak into the next one.
afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

function stubClaude() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: Array<{ text: string }> }>;
      };
      return new Promise<Response>((resolve) => {
        calls.push({ resolve, sentText: body.messages[0].content[0].text });
      });
    }),
  );
}

describe("announcement translation runs after the response", () => {
  test("POST answers before the model replies; the column fills when it does", async () => {
    stubClaude();
    const r = await post({ title: "Hello office", body: "Doors close at six." });
    expect(r.status).toBe(201);
    // The response carries no translation — the model has not been heard from.
    expect(r.data?.translations).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].sentText).toContain("Hello office");
    expect(await storedTranslations(r.data!.id)).toBeNull();

    calls[0].resolve(claudeReply("Hello office (en)", "Doors close at six."));
    const t = await untilTranslated(r.data!.id);
    expect(t?.en.title).toBe("Hello office (en)");
  });

  test("a reply for text that was edited meanwhile is dropped; the edit's own reply is stored", async () => {
    stubClaude();
    const r = await post({ title: "First wording", body: "x" });
    const id = r.data!.id;
    expect(calls).toHaveLength(1);

    const p = await patch(id, { title: "Second wording" });
    expect(p.status).toBe(200);
    expect(p.data?.title).toBe("Second wording");
    expect(calls).toHaveLength(2);
    expect(calls[1].sentText).toContain("Second wording");

    // The stale reply (for "First wording") lands first — must not be stored.
    calls[0].resolve(claudeReply("First wording (en)", "x"));
    await settle();
    expect(await storedTranslations(id)).toBeNull();

    calls[1].resolve(claudeReply("Second wording (en)", "x"));
    const t = await untilTranslated(id);
    expect(t?.en.title).toBe("Second wording (en)");
  });

  test("PATCH of the text clears the old translation with the edit itself; a non-text PATCH keeps it and asks no model", async () => {
    stubClaude();
    const r = await post({ title: "Keep", body: "old body" });
    const id = r.data!.id;
    calls[0].resolve(claudeReply("Keep (en)", "old body"));
    expect((await untilTranslated(id))?.en.title).toBe("Keep (en)");

    // Toggling active is not a text change: translation stays, no fetch.
    const toggled = await patch(id, { isActive: false });
    expect(toggled.status).toBe(200);
    expect((await storedTranslations(id))?.en.title).toBe("Keep (en)");
    expect(calls).toHaveLength(1);

    // Editing the body clears the translation in the same UPDATE — readers
    // never see the old translation over the new text — and queues a refill.
    const edited = await patch(id, { body: "new body" });
    expect(edited.status).toBe(200);
    expect(edited.data?.translations).toBeNull();
    expect(await storedTranslations(id)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("without a key nothing is called and the column stays NULL", async () => {
    stubClaude();
    const res = await app.request(
      "/api/announcements",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "No key", body: "b" }),
      },
      env as never,
    );
    expect(res.status).toBe(201);
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe("translateAndStore", () => {
  test("reports 'stale' and leaves the row alone when the text no longer matches", async () => {
    stubClaude();
    const r = await post({ title: "Live title", body: "live" });
    const id = r.data!.id;
    calls[0].resolve(claudeReply("Live title (en)", "live"));
    expect((await untilTranslated(id))?.en.title).toBe("Live title (en)");

    const run = translateAndStore(KEYED_ENV as never, id, {
      title: "Some other title",
      body: "live",
      bodyHtml: null,
    });
    expect(calls).toHaveLength(2);
    calls[1].resolve(claudeReply("Some other title (en)", "live"));
    expect(await run).toBe("stale");
    expect((await storedTranslations(id))?.en.title).toBe("Live title (en)");
  });

  test("reports 'none' and never throws when the model answers garbage", async () => {
    stubClaude();
    const r = await post({ title: "Garbage", body: "g" });
    const id = r.data!.id;
    calls[0].resolve(new Response("not json", { status: 200 }));
    await settle();
    expect(await storedTranslations(id)).toBeNull();

    // 400 is not retried (429 / 5xx / 529 are), so one deferred settles the run.
    const run = translateAndStore(KEYED_ENV as never, id, { title: "Garbage", body: "g", bodyHtml: null });
    calls[1].resolve(new Response('{"error":{"type":"invalid_request_error","message":"bad"}}', { status: 400 }));
    expect(await run).toBe("none");
  });
});
