// Void, not delete (mig 20260907T1030, owner: 不可以删只可以 cancel).
//
//   · DELETE /:id discards a DRAFT only; a submitted notice answers 409;
//   · POST /:id/void needs a reason, keeps the row / receipts / number
//     (document_refs.status = VOID), stops serving the notice (list, ack),
//     audits, tells the submitter; voiding twice is a no-op; a draft is not
//     voided (409 — discard it);
//   · a Sales Director voids only their own post; a reader gets 403.
//
// Same bare-Hono harness as announcementsApproval.test.ts (both routers).

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";
import announcementApprovalRoutes from "../src/routes/announcementApproval";
import { deliverableNow } from "../src/lib/announcementAudience";

type User = {
  id: number;
  email: string;
  name: string;
  department_id: number | null;
  position_id: null;
  position_name: null;
  permissions: string[];
  permissions_set: Set<string>;
};
function user(id: number, name: string, perms: string[]): User {
  return {
    id,
    email: `${name.toLowerCase()}@test.local`,
    name,
    department_id: 7,
    position_id: null,
    position_name: null,
    permissions: perms,
    permissions_set: new Set(perms),
  };
}
const WRITER = user(606, "Wira", ["announcements.write"]);
const APPROVER = user(700, "Adam", ["announcements.read", "announcements.approve"]);
const READER = user(800, "Rina", []);

const state: { user: User | undefined } = { user: WRITER };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/announcements", announcementRoutes);
app.route("/api/announcements", announcementApprovalRoutes);

type Reply = { status: number; success?: boolean; error?: string; data?: any; acked?: boolean };
async function call(as: User, method: string, path: string, body?: unknown): Promise<Reply> {
  state.user = as;
  const res = await app.request(
    `/api/announcements${path}`,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env as never,
  );
  const json = (await res.json().catch(() => ({}))) as Omit<Reply, "status">;
  return { status: res.status, ...json };
}
async function listIds(as: User): Promise<string[]> {
  const r = await call(as, "GET", "");
  return ((r.data ?? []) as Array<{ id: string }>).map((a) => a.id);
}

describe("announcements — void, not delete", () => {
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
         reviewed_at TEXT, reject_reason TEXT, ref_no TEXT,
         voided_by INTEGER, voided_at TEXT, void_reason TEXT)`,
    ).run();
    for (const [col, type] of [["voided_by", "INTEGER"], ["voided_at", "TEXT"], ["void_reason", "TEXT"]]) {
      await env.DB.prepare(`ALTER TABLE announcements ADD COLUMN ${col} ${type}`).run().catch(() => undefined);
    }
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_acks (
         announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT,
         company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, name TEXT, email TEXT, status TEXT, role_id INTEGER,
         department_id INTEGER, position_id INTEGER, division TEXT)`,
    ).run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT, code TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT, permissions TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS document_types (code TEXT PRIMARY KEY, label TEXT, attachment_required INTEGER, is_active INTEGER, created_at TEXT, updated_at TEXT)").run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_refs (
         ref_no TEXT PRIMARY KEY, series TEXT, dept_code TEXT, type_code TEXT, yymm TEXT,
         seq INTEGER, entity_type TEXT, entity_id TEXT, status TEXT, created_by INTEGER,
         created_at TEXT, voided_by INTEGER, voided_at TEXT, void_reason TEXT,
         UNIQUE (entity_type, entity_id))`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS audit_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_email TEXT, action TEXT,
         entity_type TEXT, entity_id TEXT, summary TEXT, meta TEXT, ip TEXT, request_id TEXT,
         created_at TEXT)`,
    ).run();
    for (const [table, col, type] of [
      ["departments", "code", "TEXT"],
      ["users", "status", "TEXT"],
      ["users", "role_id", "INTEGER"],
      ["users", "name", "TEXT"],
      ["users", "email", "TEXT"],
    ] as Array<[string, string, string]>) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run().catch(() => undefined);
    }
    await env.DB.prepare("INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')").run();
    await env.DB.prepare("INSERT OR IGNORE INTO departments (id, name, code) VALUES (7, 'Operation', 'OPS')").run();
    await env.DB.prepare("UPDATE departments SET code = 'OPS' WHERE id = 7").run();
    await env.DB.prepare("DELETE FROM announcements").run();
    await env.DB.prepare("DELETE FROM document_refs").run();
    await env.DB.prepare("DELETE FROM audit_events").run();
    for (const u of [WRITER, APPROVER, READER]) {
      await env.DB.prepare("INSERT OR REPLACE INTO users (id, name, email, status, role_id, department_id) VALUES (?, ?, ?, 'active', 1, 7)")
        .bind(u.id, u.name, u.email)
        .run();
    }
    await env.DB.prepare("DELETE FROM document_types").run();
    await env.DB.prepare(
      "INSERT INTO document_types (code, label, attachment_required, is_active, created_at) VALUES ('ANN', 'Announcement', 0, 1, '2026-09-06T00:00:00.000Z')",
    ).run();
  });

  test("deliverableNow: a voided notice is out whatever its approval state", () => {
    const base = { id: "x", is_active: 1, expires_at: null, category: "GENERAL", approval_status: "APPROVED" };
    expect(deliverableNow({ ...base })).toBe(true);
    expect(deliverableNow({ ...base, voided_at: "2026-09-07T00:00:00.000Z" })).toBe(false);
  });

  test("DELETE discards a draft; a submitted notice answers 409 and stays", async () => {
    const draft = await call(WRITER, "POST", "", { title: "Draft to discard", draft: true });
    expect(draft.status).toBe(201);
    const gone = await call(WRITER, "DELETE", `/${draft.data.id}`);
    expect(gone.status).toBe(200);
    expect(await listIds(WRITER)).not.toContain(draft.data.id);

    const pending = await call(WRITER, "POST", "", { title: "Submitted — keep" });
    const refused = await call(WRITER, "DELETE", `/${pending.data.id}`);
    expect(refused.status).toBe(409);
    expect(refused.error).toMatch(/voided, not deleted/);
    expect(await listIds(WRITER)).toContain(pending.data.id);
  });

  test("void needs a reason, keeps the row / number, stops serving, audits, tells the submitter; twice is a no-op", async () => {
    const created = await call(WRITER, "POST", "", { title: "Wrong canteen date" });
    const id = created.data.id as string;
    const approved = await call(APPROVER, "POST", `/${id}/approve`);
    expect(approved.status).toBe(200);
    const refNo = approved.data.refNo as string;
    expect(refNo).toMatch(/^OPS-ANN-\d{4}-\d{4}$/);
    expect(await listIds(READER)).toContain(id);

    expect((await call(WRITER, "POST", `/${id}/void`, { reason: "  " })).status).toBe(400);
    expect((await call(READER, "POST", `/${id}/void`, { reason: "x" })).status).toBe(403);

    // The approver voids it (they hold approve, not write — so 403: void is
    // the poster's door). The writer voids it.
    expect((await call(APPROVER, "POST", `/${id}/void`, { reason: "Superseded" })).status).toBe(403);
    const voided = await call(WRITER, "POST", `/${id}/void`, { reason: "Superseded by the corrected date." });
    expect(voided.status).toBe(200);
    expect(voided.data.voidReason).toBe("Superseded by the corrected date.");
    expect(voided.data.voidedBy).toBe(WRITER.id);
    expect(voided.data.refNo).toBe(refNo);

    // Out of the reader feed and unackable; still on the manager's ledger.
    expect(await listIds(READER)).not.toContain(id);
    expect((await call(READER, "POST", `/${id}/ack`)).acked).toBe(false);
    expect(await listIds(WRITER)).toContain(id);
    // The number is VOID in the registry and never re-issued: the next mint
    // in the series moves on.
    const reg = await env.DB.prepare("SELECT status, void_reason FROM document_refs WHERE ref_no = ?").bind(refNo).first<{ status: string; void_reason: string }>();
    expect(reg?.status).toBe("VOID");
    expect(reg?.void_reason).toBe("Superseded by the corrected date.");
    const next = await call(WRITER, "POST", "", { title: "Corrected canteen date" });
    const nextApproved = await call(APPROVER, "POST", `/${next.data.id}/approve`);
    expect(nextApproved.data.refNo).not.toBe(refNo);
    // Audit + the submitter's bell (the writer voided their own — no self-notice).
    const audit = await env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ? ORDER BY id").bind(id).all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["announcement.submit", "announcement.approve", "announcement.void"]);

    // Twice: same answer, nothing rewritten.
    const again = await call(WRITER, "POST", `/${id}/void`, { reason: "another reason" });
    expect(again.status).toBe(200);
    expect(again.data.voidReason).toBe("Superseded by the corrected date.");
    // And a voided notice cannot be deleted either.
    expect((await call(WRITER, "DELETE", `/${id}`)).status).toBe(409);
  });

  test("a draft is discarded, not voided", async () => {
    const draft = await call(WRITER, "POST", "", { title: "Draft", draft: true });
    const r = await call(WRITER, "POST", `/${draft.data.id}/void`, { reason: "nope" });
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/discarded, not voided/);
  });
});
