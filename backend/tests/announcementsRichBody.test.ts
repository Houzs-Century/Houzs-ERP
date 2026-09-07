// POST / PATCH /api/announcements — the rich body contract (mig 20260904T1700).
//
// The composer sends `bodyHtml`; the route must (1) canonicalise it through
// lib/announcementRichText.ts so nothing outside the allow-list is ever stored,
// (2) DERIVE the plain `body` from it rather than trusting the client's copy —
// the two columns are read by different surfaces and must never disagree —
// (3) store NULL html when the fragment carries no formatting, so an
// unformatted notice stays on the pre-feature plain path, and (4) on PATCH,
// let whichever of body / bodyHtml was sent last define the format.
//
// Same bare-Hono harness as announcementsListAccess.test.ts: stand in the
// user, mount the real router, minimal D1 mirror of the pg-only table.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";

const MANAGER = {
  id: 606,
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

type Pub = { id: string; body: string; bodyHtml: string | null };

async function post(payload: Record<string, unknown>) {
  const res = await app.request(
    "/api/announcements",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    env as never,
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
    env as never,
  );
  const json = (await res.json()) as { success?: boolean; error?: string; data?: Pub };
  return { status: res.status, ...json };
}

async function stored(id: string) {
  return env.DB.prepare("SELECT body, body_html FROM announcements WHERE id = ?")
    .bind(id)
    .first<{ body: string; body_html: string | null }>();
}

describe("announcement rich body", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
         id TEXT PRIMARY KEY, title TEXT, body TEXT, body_html TEXT, is_active INTEGER,
         expires_at TEXT, reminded_at TEXT, created_by INTEGER, created_at TEXT,
         updated_at TEXT, translations TEXT, attachments TEXT, media_layout TEXT,
         target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT,
         target_user_ids TEXT, target_company_ids TEXT, category TEXT,
         source TEXT, company_id INTEGER, require_ack INTEGER, scheduled_at TEXT,
         target_divisions TEXT, excluded_user_ids TEXT, escalated_at TEXT,
         approval_status TEXT, submitted_by INTEGER, submitted_at TEXT, reviewed_by INTEGER,
         reviewed_at TEXT, reject_reason TEXT, ref_no TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT,
         company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
    ).run();
  });

  test("POST stores the canonical html and DERIVES the plain body from it", async () => {
    const r = await post({
      title: "Rich",
      // The client's `body` is deliberately wrong — the server must not trust it.
      body: "client-sent junk",
      bodyHtml:
        '<div>Step list:</div><ol><li><strong>Bold one</strong></li><li><span data-size="xl" style="color:red">Two</span></li></ol><script>alert(1)</script>',
    });
    expect(r.status).toBe(201);
    expect(r.data?.bodyHtml).toBe(
      '<p>Step list:</p><ol><li><b>Bold one</b></li><li><span data-size="xl">Two</span></li></ol>',
    );
    expect(r.data?.body).toBe("Step list:\n1. Bold one\n2. Two");
    const row = await stored(r.data!.id);
    expect(row?.body_html).toBe(r.data?.bodyHtml);
    expect(row?.body).toBe(r.data?.body);
  });

  test("POST keeps an inline image only when its key is in the attachments manifest", async () => {
    const mine = "announcements/compose/1725500000000-0badf00d.jpg";
    const other = "announcements/ann-x/1725500000001-deadbeef.png";
    const r = await post({
      title: "Pic",
      bodyHtml: `<p>see</p><img data-att="${mine}"><img data-att="${other}"><p><b>end</b></p>`,
      attachments: [{ r2Key: mine, name: "a.jpg", mime: "image/jpeg", size: 10 }],
    });
    expect(r.status).toBe(201);
    expect(r.data?.bodyHtml).toBe(`<p>see</p><img data-att="${mine}"><p><b>end</b></p>`);
    // The plain shadow is derived from the STRIPPED fragment: one image, not two.
    expect(r.data?.body).toBe("see\n[image]end");
    expect((await stored(r.data!.id))?.body_html).toBe(r.data?.bodyHtml);
  });

  test("PATCH removing an attachment also removes its inline use and re-derives the plain body", async () => {
    const mine = "announcements/compose/1725500000002-0badf00d.jpg";
    const created = await post({
      title: "Pic edit",
      bodyHtml: `<p><i>before</i></p><img data-att="${mine}">`,
      attachments: [{ r2Key: mine, name: "a.jpg", mime: "image/jpeg", size: 10 }],
    });
    const id = created.data!.id;
    expect(created.data?.bodyHtml).toContain("<img");
    const r = await patch(id, { attachments: [] });
    expect(r.status).toBe(200);
    expect(r.data?.bodyHtml).toBe("<p><i>before</i></p>");
    expect(r.data?.body).toBe("before");
    expect((await stored(id))?.body_html).toBe("<p><i>before</i></p>");
  });

  test("POST with html that carries no formatting stores NULL html — the plain path", async () => {
    const r = await post({ title: "Plain", bodyHtml: "<p>just words</p><p>two lines</p>" });
    expect(r.status).toBe(201);
    expect(r.data?.bodyHtml).toBeNull();
    expect(r.data?.body).toBe("just words\ntwo lines");
  });

  test("POST without bodyHtml is the pre-feature contract, untouched", async () => {
    const r = await post({ title: "Legacy", body: "  plain text  " });
    expect(r.status).toBe(201);
    expect(r.data?.bodyHtml).toBeNull();
    expect(r.data?.body).toBe("plain text");
  });

  test("POST refuses a fragment past the hard cap", async () => {
    const r = await post({ title: "Huge", bodyHtml: "<b>" + "x".repeat(20_001) + "</b>" });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/too long/i);
  });

  test("PATCH with bodyHtml rewrites both columns; PATCH with plain body clears the html", async () => {
    const created = await post({ title: "Edit me", bodyHtml: "<p><u>v1</u></p>" });
    const id = created.data!.id;
    expect(created.data?.bodyHtml).toBe("<p><u>v1</u></p>");

    const rich = await patch(id, { bodyHtml: "<ul><li>v2</li></ul>", body: "ignored" });
    expect(rich.status).toBe(200);
    expect(rich.data?.bodyHtml).toBe("<ul><li>v2</li></ul>");
    expect(rich.data?.body).toBe("• v2");

    // A phone on the old build, or any plain-text editor, sends `body` only:
    // the stale formatting must not survive under a new plain text.
    const plain = await patch(id, { body: "v3 plain" });
    expect(plain.status).toBe(200);
    expect(plain.data?.bodyHtml).toBeNull();
    expect(plain.data?.body).toBe("v3 plain");
    const row = await stored(id);
    expect(row).toEqual({ body: "v3 plain", body_html: null });
  });
});
