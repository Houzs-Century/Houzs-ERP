import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { drainEmailOutbox, sendEmail } from "../src/services/email";
import { createOutboundFetchMock } from "./outboundFetchMock";

// Durable email outbox (migrations 095 / 0005). sendEmail() enqueues a row and
// tries an immediate Resend delivery; on failure the row stays 'pending' for the
// */5 cron drain (drainEmailOutbox), up to 3 attempts, then 'failed'. The Resend
// POST is the only network call, so we mock api.resend.com and pass an env with
// a key set (the real test env leaves RESEND_API_KEY unset on purpose).

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as typeof env;
let outbound: ReturnType<typeof createOutboundFetchMock>;

function mockResend(status: number, body: unknown) {
  outbound.replyOnce("https://api.resend.com/emails", "POST", status, body);
}

async function outbox(id: string) {
  return env.DB.prepare(
    `SELECT status, attempts, last_error FROM email_outbox WHERE id = ?`,
  )
    .bind(id)
    .first<{ status: string; attempts: number; last_error: string | null }>();
}

async function onlyOutboxRow() {
  return env.DB.prepare(
    `SELECT id, status, attempts FROM email_outbox ORDER BY created_at LIMIT 1`,
  ).first<{ id: string; status: string; attempts: number }>();
}

afterEach(() => {
  // Surface any intercept that a test registered but didn't consume.
  outbound.assertDone();
});

beforeEach(async () => {
  outbound = createOutboundFetchMock();
  await env.DB.exec(`DELETE FROM email_outbox`);
  await env.DB.exec(`DELETE FROM email_log`);
});

describe("email outbox", () => {
  test("send enqueues then marks the row sent on a 200", async () => {
    mockResend(200, { id: "prov-123" });
    const res = await sendEmail(liveEnv, {
      to: "alice@test.local",
      subject: "Hello",
      html: "<p>hi</p>",
      purpose: "generic",
    });
    expect(res.status).toBe("sent");
    expect(res.providerId).toBe("prov-123");

    const row = await onlyOutboxRow();
    expect(row?.status).toBe("sent");

    // email_log carries the per-attempt audit.
    const log = await env.DB.prepare(
      `SELECT status, provider_id FROM email_log ORDER BY id DESC LIMIT 1`,
    ).first<{ status: string; provider_id: string | null }>();
    expect(log?.status).toBe("sent");
    expect(log?.provider_id).toBe("prov-123");
  });

  test("a 5xx leaves the row pending; the cron drain retries to 'failed' after 3 attempts", async () => {
    // Immediate send fails (attempt 1) -> row stays pending.
    mockResend(500, "boom");
    const res = await sendEmail(liveEnv, {
      to: "bob@test.local",
      subject: "Reset",
      html: "<p>reset</p>",
      purpose: "password_reset",
    });
    expect(res.status).toBe("error");

    let row = await onlyOutboxRow();
    const id = row!.id;
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);

    // First drain (attempt 2) -> still under the cap, stays pending.
    mockResend(500, "boom");
    const d1 = await drainEmailOutbox(liveEnv);
    expect(d1).toEqual({ processed: 1, sent: 0, failed: 0 });
    row = await outbox(id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(2);

    // Second drain (attempt 3) -> hits the cap, marked failed.
    mockResend(500, "boom");
    const d2 = await drainEmailOutbox(liveEnv);
    expect(d2).toEqual({ processed: 1, sent: 0, failed: 1 });
    row = await outbox(id);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toContain("500");

    // Drained-out: nothing left pending, so the next drain is a clean no-op.
    const d3 = await drainEmailOutbox(liveEnv);
    expect(d3).toEqual({ processed: 0, sent: 0, failed: 0 });
  });

  test("drain is a no-op without RESEND_API_KEY (and never touches pending rows)", async () => {
    // Seed a pending row directly; with no key configured the drain must not
    // attempt delivery or mutate it.
    await env.DB.prepare(
      `INSERT INTO email_outbox (id, to_address, subject, body_html, purpose, status, attempts)
       VALUES ('seed-1', 'c@test.local', 'Q', '<p>q</p>', 'generic', 'pending', 0)`,
    ).run();

    const r = await drainEmailOutbox(env); // real env: RESEND_API_KEY unset
    expect(r).toEqual({ processed: 0, sent: 0, failed: 0 });

    const row = await outbox("seed-1");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
  });
});
