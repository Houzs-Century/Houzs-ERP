import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { app } from "../src/index";
import {
  getActiveStaffToken,
  issueSalesToken,
  issueStaffToken,
  resolveTrackToken,
  revokeCaseTokens,
} from "../src/services/caseTracking";
import {
  issueSupplierToken,
  revokeSupplierTokensForCase,
} from "../src/services/supplierPortal";
import { issueSurveyToken } from "../src/services/assr";

/* The four unauthenticated portal surfaces are gated by their token and nothing
   else — they are mounted above the /api/* auth gate, so there is no second line
   of defence behind these checks. Each test below pins one hole that was open on
   2026-07-17.

   These drive the REAL service functions and (for the supplier portal) the real
   Hono app against the isolated test D1, rather than asserting on SQL strings:
   the supplier bug was a missing WHERE predicate, which a string test would have
   happily reproduced. */

let caseId: number;

async function makeCase(assrNo: string): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO assr_cases (assr_no, doc_no, customer_name, phone, stage)
     VALUES (?, 'SO-TEST-001', 'Test Customer', '60123456789', 'pending_review')
     RETURNING id`,
  )
    .bind(assrNo)
    .first<{ id: number }>();
  return r!.id;
}

beforeEach(async () => {
  caseId = await makeCase(`ASSR-${Math.random().toString(36).slice(2, 10)}`);
});

describe("customer portal — revocation is the kill switch for a permanent link", () => {
  test("a live staff token resolves; after revoke it does not", async () => {
    const token = await issueStaffToken(env as any, caseId);
    expect(await resolveTrackToken(env as any, token)).toMatchObject({
      assr_id: caseId,
      source: "staff",
    });

    await revokeCaseTokens(env as any, caseId);

    // The whole point: the link in WhatsApp stops opening the case.
    expect(await resolveTrackToken(env as any, token)).toBeNull();
  });

  test("revoke kills EVERY source at once, not just the one that leaked", async () => {
    const staff = await issueStaffToken(env as any, caseId);
    const sales = await issueSalesToken(env as any, caseId);
    expect(staff).not.toBe(sales);

    await revokeCaseTokens(env as any, caseId);

    expect(await resolveTrackToken(env as any, staff)).toBeNull();
    expect(await resolveTrackToken(env as any, sales)).toBeNull();
  });

  test("revoke does not leak across cases", async () => {
    const otherId = await makeCase(`ASSR-${Math.random().toString(36).slice(2, 10)}`);
    const mine = await issueStaffToken(env as any, caseId);
    const theirs = await issueStaffToken(env as any, otherId);

    await revokeCaseTokens(env as any, caseId);

    expect(await resolveTrackToken(env as any, mine)).toBeNull();
    // Revoking one case must not take an unrelated customer's link down.
    expect(await resolveTrackToken(env as any, theirs)).toMatchObject({ assr_id: otherId });
  });

  test("re-issuing after revoke mints a FRESH token — revoke is rotation, not lockout", async () => {
    const first = await issueStaffToken(env as any, caseId);
    await revokeCaseTokens(env as any, caseId);
    const second = await issueStaffToken(env as any, caseId);

    // If the reuse branch ignored revoked_at it would hand back `first`,
    // and the button would return a dead link forever.
    expect(second).not.toBe(first);
    expect(await resolveTrackToken(env as any, second)).toMatchObject({ assr_id: caseId });
    expect(await resolveTrackToken(env as any, first)).toBeNull();
  });

  test("the staff panel stops offering a revoked link", async () => {
    const token = await issueStaffToken(env as any, caseId);
    expect(await getActiveStaffToken(env as any, caseId)).toBe(token);

    await revokeCaseTokens(env as any, caseId);

    // Panel-open must not redisplay a dead token — that is where it gets
    // copied from.
    expect(await getActiveStaffToken(env as any, caseId)).toBeNull();
  });

  test("staff links stay PERMANENT — revocation replaced a TTL, it did not add one", async () => {
    const token = await issueStaffToken(env as any, caseId);
    const row = await env.DB.prepare(
      `SELECT expires_at FROM case_track_tokens WHERE token = ?`,
    )
      .bind(token)
      .first<{ expires_at: string }>();
    // Nick 2026-07-07 / mig 0076: a shared WhatsApp link must keep working
    // forever. This pins that nobody quietly reintroduces an expiry.
    expect(row!.expires_at).toBe("9999-12-31T23:59:59.000Z");
  });

  test("an empty token never resolves", async () => {
    expect(await resolveTrackToken(env as any, "")).toBeNull();
  });
});

describe("survey — the expiry the 404 always advertised", () => {
  test("a freshly issued token carries a ~90-day expiry", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    const row = await env.DB.prepare(
      `SELECT expires_at FROM assr_survey_tokens WHERE token = ?`,
    )
      .bind(token)
      .first<{ expires_at: string | null }>();

    // Immortal before this change: nothing wrote the column.
    expect(row!.expires_at).not.toBeNull();
    const days = (new Date(row!.expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  test("GET returns case PII for a live token", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    const res = await app.request(`/api/survey/${token}`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ customer_name: "Test Customer" });
  });

  test("GET 404s an EXPIRED token instead of echoing customer_name / doc_no", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    await env.DB.prepare(
      `UPDATE assr_survey_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?`,
    )
      .bind(token)
      .run();

    const res = await app.request(`/api/survey/${token}`, {}, env);
    expect(res.status).toBe(404);
    // Same body as an unknown token — the token space must not be probeable.
    expect(await res.json()).toEqual({ error: "Survey not found or expired" });
  });

  test("GET 404s a NULL expires_at — fail closed, not 'never expires'", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    // Simulates a legacy row the backfill missed, or a future mint path that
    // forgets the TTL. mig 015 called this "never expires"; it is now the bug.
    await env.DB.prepare(
      `UPDATE assr_survey_tokens SET expires_at = NULL WHERE token = ?`,
    )
      .bind(token)
      .run();

    const res = await app.request(`/api/survey/${token}`, {}, env);
    expect(res.status).toBe(404);
  });

  test("POST refuses to write a rating through an expired token", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    await env.DB.prepare(
      `UPDATE assr_survey_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?`,
    )
      .bind(token)
      .run();

    const res = await app.request(
      `/api/survey/${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 5 }),
      },
      env,
    );
    expect(res.status).toBe(404);

    // The GET is what leaks; this is the path that moves a KPI.
    const row = await env.DB.prepare(
      `SELECT satisfaction_rating FROM assr_cases WHERE id = ?`,
    )
      .bind(caseId)
      .first<{ satisfaction_rating: number | null }>();
    expect(row!.satisfaction_rating).toBeNull();
  });

  test("a live token still submits", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    const res = await app.request(
      `/api/survey/${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 4, notes: "fine" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT satisfaction_rating FROM assr_cases WHERE id = ?`,
    )
      .bind(caseId)
      .first<{ satisfaction_rating: number }>();
    expect(row!.satisfaction_rating).toBe(4);
  });

  test("the reuse branch never hands back an expired token", async () => {
    const first = await issueSurveyToken(env as any, caseId);
    await env.DB.prepare(
      `UPDATE assr_survey_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token = ?`,
    )
      .bind(first)
      .run();

    // Without the expiry predicate on the reuse SELECT this returns `first` —
    // a link that 404s the moment it is shared.
    const second = await issueSurveyToken(env as any, caseId);
    expect(second).not.toBe(first);

    const res = await app.request(`/api/survey/${second}`, {}, env);
    expect(res.status).toBe(200);
  });

  test("a malformed POST body is a 400, not a 500", async () => {
    const token = await issueSurveyToken(env as any, caseId);
    const res = await app.request(
      `/api/survey/${token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("supplier portal — internal photos are not the supplier's business", () => {
  /**
   * Attach a photo to `caseId`, optionally marked internal by staff.
   *
   * The R2 object is written for real, not just the DB row. Without bytes
   * behind the key the byte-serving route 404s at its `if (!obj)` guard
   * whether or not the visibility filter is there — so the "bytes are not
   * served" test below would pass against the unfixed code, which is exactly
   * the false green this helper exists to prevent.
   */
  async function attach(visibleToCustomer: 0 | 1, fileName: string): Promise<number> {
    const key = `test/${caseId}/${fileName}`;
    await env.POD_BUCKET.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    const r = await env.DB.prepare(
      `INSERT INTO assr_attachments
         (assr_id, r2_key, file_name, content_type, category, visible_to_customer)
       VALUES (?, ?, ?, 'image/jpeg', 'evidence', ?)
       RETURNING id`,
    )
      .bind(caseId, key, fileName, visibleToCustomer)
      .first<{ id: number }>();
    return r!.id;
  }

  test("GET /case lists visible attachments and HIDES internal ones", async () => {
    const shown = await attach(1, "customer-safe.jpg");
    const internal = await attach(0, "internal-staff-note.jpg");
    const token = await issueSupplierToken(env as any, caseId, null);

    const res = await app.request(
      "/api/supplier-portal/case",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: Array<{ id: number }> };
    const ids = body.attachments.map((a) => a.id);

    expect(ids).toContain(shown);
    // The bug: every attachment on the case was served, including the ones
    // staff had explicitly hidden.
    expect(ids).not.toContain(internal);
  });

  test("the BYTES of an internal photo are not served either", async () => {
    const internal = await attach(0, "internal-staff-note.jpg");
    const visible = await attach(1, "customer-safe.jpg");
    const token = await issueSupplierToken(env as any, caseId, null);

    const get = (id: number) =>
      app.request(
        `/api/supplier-portal/attachments/${id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );

    // Positive control FIRST: proves this route can serve bytes at all in
    // this fixture, so the 404 below means "filtered", not "nothing there".
    const ok = await get(visible);
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(4);

    // Filtering only the listing would hide the photo from the page while
    // still streaming it to anyone walking the (sequential) id space.
    expect((await get(internal)).status).toBe(404);
  });

  test("a supplier's own upload stays visible to them (default visible_to_customer = 1)", async () => {
    const own = await attach(1, "supplier-upload.jpg");
    const token = await issueSupplierToken(env as any, caseId, null);

    const res = await app.request(
      "/api/supplier-portal/case",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as { attachments: Array<{ id: number }> };
    expect(body.attachments.map((a) => a.id)).toContain(own);
  });

  test("no token is a 401 — the filter is not the only thing standing there", async () => {
    const res = await app.request("/api/supplier-portal/case", {}, env);
    expect(res.status).toBe(401);
  });

  /* Driven through app.request rather than resolveSupplierToken directly:
     resolveSupplierToken fires an unawaited `last_seen_at` UPDATE
     (`.run().catch(() => {})`), and calling it bare lets that write land after
     the test returns — which trips vitest-pool-workers' isolated-storage
     teardown. Going through the router is the surface a supplier actually hits
     anyway, so this tests more, not less. */
  const openPortal = (token: string) =>
    app.request(
      "/api/supplier-portal/case",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

  test("revoking a case's supplier links shuts the portal", async () => {
    const token = await issueSupplierToken(env as any, caseId, null);
    expect((await openPortal(token)).status).toBe(200);

    await revokeSupplierTokensForCase(env as any, caseId);

    // resolveSupplierToken has always had a `revoked_at` check; until now
    // nothing could set the column, so the branch was unreachable.
    expect((await openPortal(token)).status).toBe(401);
  });

  test("supplier revoke does not leak across cases", async () => {
    const otherId = await makeCase(`ASSR-${Math.random().toString(36).slice(2, 10)}`);
    const mine = await issueSupplierToken(env as any, caseId, null);
    const theirs = await issueSupplierToken(env as any, otherId, null);

    await revokeSupplierTokensForCase(env as any, caseId);

    expect((await openPortal(mine)).status).toBe(401);
    // Revoking one case must not lock an unrelated supplier out.
    expect((await openPortal(theirs)).status).toBe(200);
  });

  test("re-issuing after revoke mints a fresh supplier token", async () => {
    const first = await issueSupplierToken(env as any, caseId, null);
    await revokeSupplierTokensForCase(env as any, caseId);
    const second = await issueSupplierToken(env as any, caseId, null);

    // issueSupplierToken's reuse branch already excluded revoked rows, so
    // this pins that revoke is rotation here too.
    expect(second).not.toBe(first);
    expect((await openPortal(second)).status).toBe(200);
    expect((await openPortal(first)).status).toBe(401);
  });
});
