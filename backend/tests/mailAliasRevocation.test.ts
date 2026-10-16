import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createOutboundFetchMock } from "./outboundFetchMock";
import { app } from "../src/index";
import { getUserBySession } from "../src/services/auth";
import {
  AliasMailboxCollisionError,
  changePersonalMailboxAliasAtomically,
} from "../src/routes/users";
import type { Env } from "../src/types";

const liveEnv = { ...env, RESEND_API_KEY: "re_test_key" } as unknown as Env;

let roleId = 0;
let userId = 0;
let otherUserId = 0;
let token = "";
let otherToken = "";

const sources = import.meta.glob("../src/routes/users.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const usersRouteSource = Object.values(sources)[0] ?? "";

function auth(tokenValue: string): HeadersInit {
  return {
    Authorization: `Bearer ${tokenValue}`,
    "Content-Type": "application/json",
  };
}

async function changeAlias(previous: string | null, next: string | null): Promise<void> {
  await changePersonalMailboxAliasAtomically(liveEnv, userId, previous, next);
}

async function compose(sessionToken: string, fromAddress: string): Promise<Response> {
  return app.request(
    "/api/mail-center/compose",
    {
      method: "POST",
      headers: auth(sessionToken),
      body: JSON.stringify({
        fromAddress,
        to: "recipient@example.com",
        subject: "Alias authority regression",
        text: "Test message",
      }),
    },
    liveEnv,
  );
}

/* Vitest Pool Workers 0.18 (PR #925) REMOVED the undici `fetchMock` export from
   cloudflare:test. This file arrived from PR #918, which was rebased before that
   upgrade landed, so it was the one suite still on the old API — green on its own
   PR, broken the moment both were on main together. `createOutboundFetchMock` is
   the repo's existing fail-closed replacement (see clientErrors / documentEmail /
   emailOutbox, which were migrated with the upgrade). */
let outbound: ReturnType<typeof createOutboundFetchMock>;

function mockResend(id: string): void {
  outbound.replyOnce("https://api.resend.com/emails", "POST", 200, { id });
}

beforeAll(async () => {
  // Replaces fetchMock.activate() + disableNetConnect(): the helper stubs
  // globalThis.fetch and throws on any outbound call that was not registered.
  outbound = createOutboundFetchMock();

  // Mail Center's schema is PG-only in this repository; the isolated vitest DB
  // is D1. Recreate the route's real table shapes here so the authorization and
  // compose handlers execute against D1 instead of replacing them with mocks.
  const mailSchema = [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_addr ON email_addresses (lower(address))`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user ON email_address_access (address_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
  ];
  for (const statement of mailSchema) {
    await env.DB.prepare(statement).run();
  }

  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'mail alias revocation test', ?, 0)`,
  )
    .bind(`mail-alias-role-${crypto.randomUUID()}`, JSON.stringify(["mail_center.read"]))
    .run();
  roleId = Number(role.meta.last_row_id);

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Alias Owner', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`alias-owner-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);
  const other = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Shared Grant User', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`alias-grantee-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  otherUserId = Number(other.meta.last_row_id);

  token = `mail-alias-owner-${crypto.randomUUID()}`;
  otherToken = `mail-alias-grantee-${crypto.randomUUID()}`;
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?), (?, ?, ?)`,
  )
    .bind(token, userId, expiry, otherToken, otherUserId, expiry)
    .run();
});

afterAll(async () => {
  // Replaces fetchMock.assertNoPendingInterceptors(): fails if a registered
  // Resend reply was never consumed, and restores globalThis.fetch either way.
  outbound.assertDone();
  await env.SESSION_CACHE.delete(`sess:${token}`);
  await env.SESSION_CACHE.delete(`sess:${otherToken}`);
  await env.DB.exec(`DELETE FROM email_messages`);
  await env.DB.exec(`DELETE FROM email_threads`);
  await env.DB.exec(`DELETE FROM email_outbox`);
  await env.DB.exec(`DELETE FROM email_log`);
  await env.DB.prepare(`DELETE FROM email_address_access WHERE user_id IN (?, ?)`)
    .bind(userId, otherUserId)
    .run();
  await env.DB.prepare(`DELETE FROM email_addresses WHERE assigned_user_id IN (?, ?) OR address LIKE 'alias-%@houzscentury.com'`)
    .bind(userId, otherUserId)
    .run();
  await env.DB.prepare(`DELETE FROM sessions WHERE token IN (?, ?)`)
    .bind(token, otherToken)
    .run();
  await env.DB.prepare(`DELETE FROM users WHERE id IN (?, ?)`)
    .bind(userId, otherUserId)
    .run();
  await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
});

describe("personal Mail Center alias revocation", () => {
  it("does not use PostgreSQL reserved current_user as an unquoted CTE name", () => {
    expect(usersRouteSource).not.toMatch(/\bWITH\s+current_user\s+AS\s*\(/i);
    expect(usersRouteSource).toMatch(/\bWITH\s+target_user\s+AS\s*\(/i);
  });

  test("the production users PATCH commits mailbox reconciliation before remaining user fields", () => {
    const start = usersRouteSource.indexOf('app.patch("/:id"');
    expect(start).toBeGreaterThan(-1);
    const handler = usersRouteSource.slice(start);
    const revokeAt = handler.indexOf("await changePersonalMailboxAliasAtomically(");
    const updateAt = handler.indexOf("await db.update(users).set(set)");
    expect(revokeAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(revokeAt);
    expect(handler).toContain("personal_mailbox_alias_change: personalMailboxAliasChange");
  });

  test("claims an inbound-created unowned mailbox and creates the self-grant atomically", async () => {
    const inboundAlias = `alias-inbound-${crypto.randomUUID()}@houzscentury.com`;
    const inboundMailboxId = crypto.randomUUID();
    await env.DB.prepare(`UPDATE users SET email_alias = NULL WHERE id = ?`)
      .bind(userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name, active, created_at, created_by)
       VALUES (?, ?, 'Inbound mailbox', NULL, NULL, 0, ?, NULL)`,
    )
      .bind(inboundMailboxId, inboundAlias, new Date().toISOString())
      .run();

    const change = await changePersonalMailboxAliasAtomically(
      liveEnv,
      userId,
      null,
      inboundAlias,
    );
    const state = await env.DB.prepare(
      `SELECT u.email_alias, ea.id AS mailbox_id, ea.assigned_user_id, ea.active,
              EXISTS(SELECT 1 FROM email_address_access a
                     WHERE a.address_id = ea.id AND a.user_id = u.id) AS self_grant
         FROM users u
         JOIN email_addresses ea ON lower(ea.address) = lower(u.email_alias)
        WHERE u.id = ?`,
    )
      .bind(userId)
      .first<{
        email_alias: string;
        mailbox_id: string;
        assigned_user_id: number;
        active: number;
        self_grant: number;
      }>();
    expect(change).toMatchObject({
      new_alias: inboundAlias,
      mailbox_id: inboundMailboxId,
    });
    expect(state).toMatchObject({
      email_alias: inboundAlias,
      mailbox_id: inboundMailboxId,
      assigned_user_id: userId,
      active: 1,
      self_grant: 1,
    });

    await changeAlias(inboundAlias, null);
    await env.DB.prepare(`DELETE FROM email_address_access WHERE address_id = ?`)
      .bind(inboundMailboxId)
      .run();
    await env.DB.prepare(`DELETE FROM email_addresses WHERE id = ?`)
      .bind(inboundMailboxId)
      .run();
  });

  test("rejects an alias owned by another user without revoking the current alias", async () => {
    const suffix = crypto.randomUUID();
    const oldAlias = `alias-collision-old-${suffix}@houzscentury.com`;
    const collisionAlias = `alias-collision-new-${suffix}@houzscentury.com`;
    const oldMailboxId = crypto.randomUUID();
    const collisionMailboxId = crypto.randomUUID();
    await env.DB.prepare(`UPDATE users SET email_alias = ? WHERE id = ?`)
      .bind(oldAlias, userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name, active, created_at, created_by)
       VALUES (?, ?, 'Current owner', ?, 'Alias Owner', 1, ?, ?),
              (?, ?, 'Other owner', ?, 'Shared Grant User', 1, ?, ?)`,
    )
      .bind(
        oldMailboxId,
        oldAlias,
        userId,
        new Date().toISOString(),
        userId,
        collisionMailboxId,
        collisionAlias,
        otherUserId,
        new Date().toISOString(),
        otherUserId,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO email_address_access (id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), oldMailboxId, userId, new Date().toISOString(), userId)
      .run();

    await expect(changeAlias(oldAlias, collisionAlias)).rejects.toBeInstanceOf(
      AliasMailboxCollisionError,
    );

    const user = await env.DB.prepare(`SELECT email_alias FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ email_alias: string | null }>();
    const current = await env.DB.prepare(
      `SELECT assigned_user_id,
              EXISTS(SELECT 1 FROM email_address_access a
                     WHERE a.address_id = email_addresses.id AND a.user_id = ?) AS self_grant
         FROM email_addresses WHERE id = ?`,
    )
      .bind(userId, oldMailboxId)
      .first<{ assigned_user_id: number | null; self_grant: number }>();
    const collision = await env.DB.prepare(
      `SELECT assigned_user_id,
              EXISTS(SELECT 1 FROM email_address_access a
                     WHERE a.address_id = email_addresses.id AND a.user_id = ?) AS wrong_grant
         FROM email_addresses WHERE id = ?`,
    )
      .bind(userId, collisionMailboxId)
      .first<{ assigned_user_id: number | null; wrong_grant: number }>();
    expect(user?.email_alias).toBe(oldAlias);
    expect(current).toMatchObject({ assigned_user_id: userId, self_grant: 1 });
    expect(collision).toMatchObject({ assigned_user_id: otherUserId, wrong_grant: 0 });

    await env.DB.prepare(`DELETE FROM email_address_access WHERE address_id IN (?, ?)`)
      .bind(oldMailboxId, collisionMailboxId)
      .run();
    await env.DB.prepare(`DELETE FROM email_addresses WHERE id IN (?, ?)`)
      .bind(oldMailboxId, collisionMailboxId)
      .run();
    await env.DB.prepare(`UPDATE users SET email_alias = NULL WHERE id = ?`)
      .bind(userId)
      .run();
  });

  test("a D1 batch failure rolls back grant, assignment, and users.email_alias together", async () => {
    const oldAlias = `alias-rollback-${crypto.randomUUID()}@houzscentury.com`;
    const nextAlias = `alias-never-committed-${crypto.randomUUID()}@houzscentury.com`;
    const mailboxId = crypto.randomUUID();
    await env.DB.prepare(`UPDATE users SET email_alias = ? WHERE id = ?`)
      .bind(oldAlias, userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name, active, created_at, created_by)
       VALUES (?, ?, 'Alias Owner', ?, 'Alias Owner', 1, ?, ?)`,
    )
      .bind(mailboxId, oldAlias, userId, new Date().toISOString(), userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_address_access (id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), mailboxId, userId, new Date().toISOString(), userId)
      .run();

    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) =>
        env.DB.batch([
          ...statements,
          env.DB.prepare(`INSERT INTO deliberately_missing_table (id) VALUES (1)`),
        ]),
    } as unknown as D1Database;
    const failingEnv = {
      ...liveEnv,
      DATABASE_URL: "",
      HYPERDRIVE: undefined,
      DB: failingDb,
    } as unknown as Env;

    await expect(
      changePersonalMailboxAliasAtomically(
        failingEnv,
        userId,
        oldAlias,
        nextAlias,
      ),
    ).rejects.toThrow();

    const user = await env.DB.prepare(`SELECT email_alias FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ email_alias: string | null }>();
    const mailbox = await env.DB.prepare(
      `SELECT assigned_user_id FROM email_addresses WHERE id = ?`,
    )
      .bind(mailboxId)
      .first<{ assigned_user_id: number | null }>();
    const grant = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_address_access WHERE address_id = ? AND user_id = ?`,
    )
      .bind(mailboxId, userId)
      .first<{ n: number }>();
    expect(user?.email_alias).toBe(oldAlias);
    expect(mailbox?.assigned_user_id).toBe(userId);
    expect(Number(grant?.n)).toBe(1);
    const partialNew = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_addresses WHERE lower(address) = ?`,
    )
      .bind(nextAlias)
      .first<{ n: number }>();
    expect(Number(partialNew?.n)).toBe(0);

    await env.DB.prepare(`DELETE FROM email_address_access WHERE address_id = ?`)
      .bind(mailboxId)
      .run();
    await env.DB.prepare(`DELETE FROM email_addresses WHERE id = ?`)
      .bind(mailboxId)
      .run();
    await env.DB.prepare(`UPDATE users SET email_alias = NULL WHERE id = ?`)
      .bind(userId)
      .run();
  });

  test("old From is revoked, new From works, and another user's shared grant survives", async () => {
    const suffix = crypto.randomUUID();
    const oldAlias = `alias-old-${suffix}@houzscentury.com`;
    const newAlias = `alias-new-${suffix}@houzscentury.com`;

    await env.DB.prepare(`UPDATE users SET email_alias = ? WHERE id = ?`)
      .bind(oldAlias, userId)
      .run();
    const oldMailboxId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name, active, created_at, created_by)
       VALUES (?, ?, 'Alias Owner', ?, 'Alias Owner', 1, ?, ?)`,
    )
      .bind(oldMailboxId, oldAlias, userId, new Date().toISOString(), userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_address_access (id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), oldMailboxId, userId, new Date().toISOString(), userId)
      .run();
    const warmed = await getUserBySession(liveEnv, token);
    expect(warmed?.email_alias).toBe(oldAlias);

    const oldMailbox = await env.DB.prepare(
      `SELECT id FROM email_addresses WHERE lower(address) = ? LIMIT 1`,
    )
      .bind(oldAlias)
      .first<{ id: string }>();
    expect(oldMailbox?.id).toBeTruthy();
    // This is a legitimate additional shared-mailbox grant and must survive
    // when the original owner's personal alias moves elsewhere.
    await env.DB.prepare(
      `INSERT INTO email_address_access (id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), oldMailbox!.id, otherUserId, new Date().toISOString(), userId)
      .run();

    await changeAlias(oldAlias, newAlias);

    const oldFrom = await compose(token, oldAlias);
    expect(oldFrom.status).toBe(403);
    expect(await oldFrom.json()).toMatchObject({
      error: `not allowed to send from ${oldAlias}`,
    });

    mockResend("new-alias-sent");
    expect((await compose(token, newAlias)).status).toBe(201);

    // The old mailbox remains active and the unrelated grantee can still use it.
    const preserved = await env.DB.prepare(
      `SELECT ea.active, ea.assigned_user_id,
              EXISTS(SELECT 1 FROM email_address_access a
                     WHERE a.address_id = ea.id AND a.user_id = ?) AS other_grant,
              EXISTS(SELECT 1 FROM email_address_access a
                     WHERE a.address_id = ea.id AND a.user_id = ?) AS owner_grant
         FROM email_addresses ea WHERE ea.id = ?`,
    )
      .bind(otherUserId, userId, oldMailbox!.id)
      .first<{
        active: number;
        assigned_user_id: number | null;
        other_grant: number;
        owner_grant: number;
      }>();
    expect(preserved).toMatchObject({
      active: 1,
      assigned_user_id: null,
      other_grant: 1,
      owner_grant: 0,
    });

    mockResend("shared-grant-sent");
    expect((await compose(otherToken, oldAlias)).status).toBe(201);

    // Removal follows the same backend path: the last personal From disappears
    // immediately even though the AuthUser cache was warm.
    await changeAlias(newAlias, null);
    expect((await compose(token, newAlias)).status).toBe(403);
  });
});
