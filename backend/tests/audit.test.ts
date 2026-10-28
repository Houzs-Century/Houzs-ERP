import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { writeAudit } from "../src/services/audit";

// Audit trail (mig 096 / 0006). writeAudit() is the append-only sink; mutating
// routes call it via audit(c, ...). The DASHBOARD_API_KEY bearer authenticates
// as the service admin (permissions ["*"]) so role/user mutations are allowed.

const ADMIN = { Authorization: "Bearer test-dashboard-key", "Content-Type": "application/json" };

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM audit_events`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
});

describe("audit trail", () => {
  test("writeAudit appends a row that survives a read-back, never throws", async () => {
    await writeAudit(env, {
      action: "test.event",
      entityType: "thing",
      entityId: 42,
      summary: "did a thing",
      meta: { before: 1, after: 2 },
      actorId: 7,
      actorEmail: "a@test.local",
    });
    const row = await env.DB.prepare(
      `SELECT action, entity_type, entity_id, summary, meta, actor_id FROM audit_events WHERE action = 'test.event'`,
    ).first<{ entity_id: string; meta: string; actor_id: number; entity_type: string }>();
    expect(row?.entity_type).toBe("thing");
    expect(row?.entity_id).toBe("42"); // stored as TEXT
    expect(row?.actor_id).toBe(7);
    expect(JSON.parse(row!.meta)).toEqual({ before: 1, after: 2 });
  });

  test("a bad insert is swallowed (best-effort): unknown column does not throw", async () => {
    // action is NOT NULL — omitting it would violate the constraint. writeAudit
    // must absorb that, not bubble it into the mutation it was recording.
    await expect(
      writeAudit(env, { action: undefined as unknown as string }),
    ).resolves.toBeUndefined();
  });

  test("a swallowed insert still names the row it lost, so it can be replayed", async () => {
    /* Swallowing is correct — audit must never break the mutation it records —
       but a payload-free "insert failed" line makes the gap unrecoverable AND
       invisible. HOOKKA shipped a column-type mismatch that failed EVERY insert
       from one deploy onward and nobody noticed, because the only trace said
       nothing about what was lost (BUG-2026-04-27-007 / BUG-2026-05-12-007).
       The identifying fields must reach the log so the row is reconstructable. */
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await writeAudit(env, {
        action: undefined as unknown as string, // violates NOT NULL -> insert fails
        entityType: "role",
        entityId: 5,
        summary: "would have recorded a role edit",
        actorId: 7,
        actorEmail: "actor@test.local",
        meta: { before: 1, after: 2 },
      });
    } finally {
      console.error = original;
    }

    expect(errors.length).toBe(1);
    const [message, payload] = errors[0] as [string, Record<string, unknown>];
    // The greppable prefix is what an alert would key on.
    expect(String(message)).toContain("[audit] insert failed");
    expect(payload).toMatchObject({
      entityType: "role",
      entityId: "5",
      summary: "would have recorded a role edit",
      actorId: 7,
      actorEmail: "actor@test.local",
    });
    // meta can be large and can carry customer data — presence only, never the
    // blob itself, because this sink has a wider audience than audit_events.
    expect(payload.hasMeta).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("after");
    // And the failure reason is carried, not just the fact of failure.
    expect(String(payload.error)).toBeTruthy();
  });

  test("GET /api/audit lists events and filters by action prefix", async () => {
    // Seed a spread of events directly (the mutating routes themselves run on
    // Drizzle, which has no DB in this harness — the read path is raw env.DB).
    await writeAudit(env, { action: "role.create", entityType: "role", entityId: 1, summary: "made role X" });
    await writeAudit(env, { action: "role.delete", entityType: "role", entityId: 1, summary: "removed role X" });
    await writeAudit(env, { action: "user.invite", entityType: "user", entityId: "z@test.local", summary: "invited z" });

    // Unfiltered: all three.
    const all = await SELF.fetch("https://test.local/api/audit", { headers: ADMIN });
    expect(all.status).toBe(200);
    expect(((await all.json()) as { total: number }).total).toBe(3);

    // Prefix filter "role" catches role.create + role.delete, not user.invite.
    const roleOnly = await SELF.fetch("https://test.local/api/audit?action=role", { headers: ADMIN });
    const body = (await roleOnly.json()) as { total: number; data: any[] };
    expect(body.total).toBe(2);
    expect(body.data.every((e) => e.action.startsWith("role"))).toBe(true);
  });

  test("GET /api/audit rejects an unauthenticated caller", async () => {
    const res = await SELF.fetch("https://test.local/api/audit", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("GET /api/users/:id/activity returns what a user did + what was done to them", async () => {
    // Did: actor_id = 7. Done-to: entity_type='user' AND entity_id='7'.
    // Unrelated rows (other actor, non-user entity) must be excluded.
    await writeAudit(env, { action: "role.update", entityType: "role", entityId: 3, summary: "edited a role", actorId: 7 });
    await writeAudit(env, { action: "user.disable", entityType: "user", entityId: 7, summary: "disabled by admin", actorId: 1 });
    await writeAudit(env, { action: "role.delete", entityType: "role", entityId: 9, summary: "noise", actorId: 99 });

    const res = await SELF.fetch("https://test.local/api/users/7/activity", { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: any[] };
    expect(body.activity.length).toBe(2);
    expect(body.activity.map((e) => e.action).sort()).toEqual(["role.update", "user.disable"]);
  });

  test("GET /api/users/:id/activity rejects an unauthenticated caller", async () => {
    const res = await SELF.fetch("https://test.local/api/users/7/activity", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });
});
