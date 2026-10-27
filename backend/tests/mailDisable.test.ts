import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { closePersonalMailOnDisable, isPersonalAddressTaken, reopenPersonalMailbox } from "../src/lib/mail-provision";

// HC-0157 C: disabling a member closes their personal mailbox and removes
// their grants to shared mailboxes; re-enabling opens their own mailbox again.
// Before this, a disabled member's mailbox kept receiving mail and their grants
// stayed, so a re-enable silently restored every shared mailbox. The member
// routes are Drizzle on Postgres, so the helpers run here on D1 and the wiring
// is checked on the route source.

const sources = import.meta.glob("../src/routes/users.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const usersRouteSource = Object.values(sources)[0] ?? "";
let roleId = 0;
const made: number[] = [];

async function user(name: string, alias: string | null): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, email_alias, joined_at) VALUES (?, ?, 'unused', ?, 'active', ?, datetime('now'))`,
  )
    .bind(`hc157c-${crypto.randomUUID().slice(0, 8)}@test.local`, name, roleId, alias)
    .run();
  const id = Number(r.meta.last_row_id);
  made.push(id);
  return id;
}

async function mailbox(address: string, ownerId: number | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, label, assigned_user_id, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
  )
    .bind(id, address, address, ownerId, new Date().toISOString())
    .run();
  return id;
}

async function grant(addressId: string, userId: number) {
  await env.DB.prepare(`INSERT INTO email_address_access (id, address_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), addressId, userId, new Date().toISOString())
    .run();
}

const active = async (address: string) =>
  Number(
    (await env.DB.prepare(`SELECT active FROM email_addresses WHERE address = ?`).bind(address).first<{ active: number }>())
      ?.active,
  );
const grants = async (userId: number) =>
  (
    await env.DB.prepare(
      `SELECT a.address FROM email_address_access g JOIN email_addresses a ON a.id = g.address_id WHERE g.user_id = ? ORDER BY a.address`,
    )
      .bind(userId)
      .all<{ address: string }>()
  ).results.map((r) => r.address);

beforeAll(async () => {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_addr ON email_addresses (lower(address))`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user ON email_address_access (address_id, user_id)`,
  ]) {
    await env.DB.prepare(statement).run();
  }
  roleId = Number(
    (
      await env.DB.prepare(`INSERT INTO roles (name, description, permissions, scope_to_pic) VALUES (?, 'hc157c', '[]', 0)`)
        .bind(`hc157c-${crypto.randomUUID()}`)
        .run()
    ).meta.last_row_id,
  );
});

afterAll(async () => {
  await env.DB.exec(`DELETE FROM email_address_access`);
  await env.DB.exec(`DELETE FROM email_addresses`);
  for (const id of made.reverse()) await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_address_access`);
  await env.DB.exec(`DELETE FROM email_addresses`);
});

describe("a disabled member keeps no Mail Center reach", () => {
  test("disable closes their mailbox and drops shared grants; re-enable opens only their own", async () => {
    const id = await user("Leaver One", "leaver.one@houzscentury.com");
    const other = await user("Colleague", null);
    const own = await mailbox("leaver.one@houzscentury.com", id);
    const sales = await mailbox("sales@houzscentury.com", null);
    await grant(own, id);
    await grant(sales, id);
    await grant(sales, other);

    await closePersonalMailOnDisable(env.DB, id);
    expect(await active("leaver.one@houzscentury.com")).toBe(0);
    expect(await active("sales@houzscentury.com")).toBe(1);
    expect(await grants(id)).toEqual(["leaver.one@houzscentury.com"]);
    expect(await grants(other)).toEqual(["sales@houzscentury.com"]);
    // The address is never handed to the next person along with the old mail.
    expect(await isPersonalAddressTaken(env.DB, "leaver.one@houzscentury.com", null)).toBe(true);

    await reopenPersonalMailbox(env.DB, id);
    expect(await active("leaver.one@houzscentury.com")).toBe(1);
    expect(await grants(id)).toEqual(["leaver.one@houzscentury.com"]);
  });

  test("re-enable opens only the mailbox of their current address", async () => {
    const id = await user("Renamed", "new.name@houzscentury.com");
    await mailbox("old.name@houzscentury.com", id);
    await mailbox("new.name@houzscentury.com", id);
    await closePersonalMailOnDisable(env.DB, id);
    await reopenPersonalMailbox(env.DB, id);
    expect(await active("old.name@houzscentury.com")).toBe(0);
    expect(await active("new.name@houzscentury.com")).toBe(1);
  });

  test("both disable paths close the mailbox, and only a disabled member is reopened", () => {
    expect(usersRouteSource.split("await closePersonalMailOnDisable(c.env.DB, id);").length - 1).toBe(2);
    expect(usersRouteSource.replace(/\s+/g, " ")).toContain(
      `if (body.status === "active" && current[0].status === "disabled") { await reopenPersonalMailbox(c.env.DB, id); }`,
    );
  });
});
