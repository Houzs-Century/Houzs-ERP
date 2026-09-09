// Announcement attachments — the policy and the log (mig 20260907T0715).
//
//   · document_types.ANN.attachment_required gates the two doors into the
//     approval queue (POST without draft, POST /:id/submit); a draft is
//     always allowed; the policy off means nothing is blocked;
//   · announcement_files logs who attached / removed which file and when,
//     kept in step with the manifest on create and on edit;
//   · GET /:id/files answers the log to writers / approvers, not readers.
//
// Same bare-Hono harness as announcementsApproval.test.ts.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";
import announcementApprovalRoutes from "../src/routes/announcementApproval";

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
const EDITOR = user(607, "Edna", ["announcements.write"]);
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

type Reply = { status: number; success?: boolean; error?: string; data?: any };
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
async function setPolicy(required: boolean) {
  await env.DB.prepare("UPDATE document_types SET attachment_required = ? WHERE code = 'ANN'")
    .bind(required ? 1 : 0)
    .run();
}
const FILE_A = { r2Key: "announcements/compose/1725500000000-aaaaaaaa.pdf", name: "Rules.pdf", mime: "application/pdf", size: 1234 };
const FILE_B = { r2Key: "announcements/compose/1725500000001-bbbbbbbb.jpg", name: "Photo.jpg", mime: "image/jpeg", size: 999 };

describe("announcement attachment policy + log", () => {
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
         reviewed_at TEXT, reject_reason TEXT, ref_no TEXT, doc_type TEXT)`,
    ).run();
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
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_types (
         code TEXT PRIMARY KEY, label TEXT, attachment_required INTEGER, is_active INTEGER,
         created_at TEXT, updated_at TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcement_files (
         id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id TEXT NOT NULL, r2_key TEXT NOT NULL,
         name TEXT, mime TEXT, size INTEGER, uploaded_by INTEGER, uploaded_at TEXT NOT NULL,
         removed_by INTEGER, removed_at TEXT, UNIQUE (announcement_id, r2_key))`,
    ).run();
    for (const [table, col, type] of [
      ["users", "status", "TEXT"],
      ["users", "role_id", "INTEGER"],
      ["users", "name", "TEXT"],
      ["users", "email", "TEXT"],
    ] as Array<[string, string, string]>) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run().catch(() => undefined);
    }
    // A users mirror from another suite may carry a role_id FK: make sure the
    // role we reference exists, and replace rather than delete + insert.
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT, permissions TEXT)").run();
    await env.DB.prepare("INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT, code TEXT)").run();
    await env.DB.prepare("INSERT OR IGNORE INTO departments (id, name) VALUES (7, 'Operation')").run();
    await env.DB.prepare("DELETE FROM announcements").run();
    await env.DB.prepare("DELETE FROM announcement_files").run();
    await env.DB.prepare("DELETE FROM document_types").run();
    for (const u of [WRITER, EDITOR, APPROVER, READER]) {
      await env.DB.prepare("INSERT OR REPLACE INTO users (id, name, email, status, role_id, department_id) VALUES (?, ?, ?, 'active', 1, 7)")
        .bind(u.id, u.name, u.email)
        .run();
    }
    await env.DB.prepare(
      "INSERT INTO document_types (code, label, attachment_required, is_active, created_at) VALUES ('ANN', 'Announcement', 0, 1, '2026-09-06T00:00:00.000Z')",
    ).run();
  });

  test("policy off: a notice without an attachment enters the queue", async () => {
    await setPolicy(false);
    const r = await call(WRITER, "POST", "", { title: "No file needed" });
    expect(r.status).toBe(201);
    expect(r.data.approvalStatus).toBe("PENDING_APPROVAL");
  });

  test("policy on: submission without a file is refused; a draft is allowed; submit of that draft is refused until a file is attached", async () => {
    await setPolicy(true);
    const refused = await call(WRITER, "POST", "", { title: "Needs a file" });
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/attachment is required/i);

    const draft = await call(WRITER, "POST", "", { title: "Needs a file", draft: true });
    expect(draft.status).toBe(201);
    expect(draft.data.approvalStatus).toBe("DRAFT");
    const id = draft.data.id as string;

    const stillNo = await call(WRITER, "POST", `/${id}/submit`);
    expect(stillNo.status).toBe(400);

    const attached = await call(WRITER, "PATCH", `/${id}`, { attachments: [FILE_A] });
    expect(attached.status).toBe(200);
    const submitted = await call(WRITER, "POST", `/${id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.data.approvalStatus).toBe("PENDING_APPROVAL");
  });

  test("the log follows the manifest: create logs the uploader, an edit logs removals and additions under the editor, re-attaching re-opens the row", async () => {
    await setPolicy(false);
    const created = await call(WRITER, "POST", "", { title: "With files", attachments: [FILE_A, FILE_B] });
    expect(created.status).toBe(201);
    const id = created.data.id as string;

    let log = await call(WRITER, "GET", `/${id}/files`);
    expect(log.status).toBe(200);
    expect(log.data.map((f: any) => [f.name, f.uploadedByName, f.removedAt])).toEqual([
      ["Rules.pdf", "Wira", null],
      ["Photo.jpg", "Wira", null],
    ]);

    // Edna drops the photo.
    const edited = await call(EDITOR, "PATCH", `/${id}`, { attachments: [FILE_A] });
    expect(edited.status).toBe(200);
    log = await call(WRITER, "GET", `/${id}/files`);
    const photo = log.data.find((f: any) => f.name === "Photo.jpg");
    expect(photo.removedByName).toBe("Edna");
    expect(photo.removedAt).toBeTruthy();
    expect(log.data.find((f: any) => f.name === "Rules.pdf").removedAt).toBeNull();

    // A non-attachment edit leaves the log alone.
    await call(EDITOR, "PATCH", `/${id}`, { title: "With files (renamed)" });
    log = await call(WRITER, "GET", `/${id}/files`);
    expect(log.data).toHaveLength(2);

    // Wira brings the photo back: the same row re-opens under Wira.
    await call(WRITER, "PATCH", `/${id}`, { attachments: [FILE_A, FILE_B] });
    log = await call(WRITER, "GET", `/${id}/files`);
    expect(log.data).toHaveLength(2);
    const back = log.data.find((f: any) => f.name === "Photo.jpg");
    expect(back.removedAt).toBeNull();
    expect(back.uploadedByName).toBe("Wira");

    // The approval desk may read the log; a reader may not.
    expect((await call(APPROVER, "GET", `/${id}/files`)).status).toBe(200);
    expect((await call(READER, "GET", `/${id}/files`)).status).toBe(403);
  });
});
