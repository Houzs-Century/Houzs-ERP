// Document type on a notice (mig 20260908T0300, owner 2026-09-08: 每个部门自动
// 生成 memo reference number).
//
//   · POST takes docType — ANN by default, MEMO (a registered, active type);
//     an unknown or inactive code is refused;
//   · approval mints with the row's type: OPS-MEMO-2609-0001 runs its own
//     sequence beside OPS-ANN-2609-0001, per department and month;
//   · the attachment policy is read per type;
//   · the type may change until approval, never after.
//
// Same bare-Hono harness as announcementsApproval.test.ts (both routers).

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
function user(id: number, name: string, department_id: number, perms: string[]): User {
  return {
    id,
    email: `${name.toLowerCase()}@test.local`,
    name,
    department_id,
    position_id: null,
    position_name: null,
    permissions: perms,
    permissions_set: new Set(perms),
  };
}
const OPS = user(606, "Wira", 7, ["announcements.write"]);
const HR = user(608, "Hana", 8, ["announcements.write"]);
const APPROVER = user(700, "Adam", 3, ["announcements.read", "announcements.approve"]);

const state: { user: User | undefined } = { user: OPS };
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
    { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env as never,
  );
  const json = (await res.json().catch(() => ({}))) as Omit<Reply, "status">;
  return { status: res.status, ...json };
}
async function approved(as: User, body: Record<string, unknown>): Promise<string> {
  const r = await call(as, "POST", "", body);
  expect(r.status).toBe(201);
  const a = await call(APPROVER, "POST", `/${r.data.id}/approve`);
  expect(a.status).toBe(200);
  return a.data.refNo as string;
}

describe("announcements — document type (ANN / MEMO)", () => {
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
         voided_by INTEGER, voided_at TEXT, void_reason TEXT, doc_type TEXT)`,
    ).run();
    for (const [col, type] of [["voided_by", "INTEGER"], ["voided_at", "TEXT"], ["void_reason", "TEXT"], ["doc_type", "TEXT"]]) {
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
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS document_types (code TEXT PRIMARY KEY, label TEXT, attachment_required INTEGER, is_active INTEGER, created_at TEXT, updated_at TEXT)",
    ).run();
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
    await env.DB.prepare("INSERT OR IGNORE INTO departments (id, name, code) VALUES (8, 'Human Resources', 'HR')").run();
    await env.DB.prepare("INSERT OR IGNORE INTO departments (id, name, code) VALUES (3, 'Management', 'MGT')").run();
    await env.DB.prepare("UPDATE departments SET code = 'OPS' WHERE id = 7").run();
    await env.DB.prepare("UPDATE departments SET code = 'HR' WHERE id = 8").run();
    await env.DB.prepare("DELETE FROM announcements").run();
    await env.DB.prepare("DELETE FROM document_refs").run();
    for (const u of [OPS, HR, APPROVER]) {
      await env.DB.prepare("INSERT OR REPLACE INTO users (id, name, email, status, role_id, department_id) VALUES (?, ?, ?, 'active', 1, ?)")
        .bind(u.id, u.name, u.email, u.department_id)
        .run();
    }
    await env.DB.prepare("DELETE FROM document_types").run();
    await env.DB.prepare(
      "INSERT INTO document_types (code, label, attachment_required, is_active, created_at) VALUES ('ANN', 'Announcement', 0, 1, '2026-09-06T00:00:00.000Z'), ('MEMO', 'Memo', 1, 1, '2026-09-08T00:00:00.000Z'), ('OLD', 'Retired', 0, 0, '2026-09-08T00:00:00.000Z')",
    ).run();
  });

  test("a memo is numbered <DEPT>-MEMO-YYMM-NNNN on its own sequence, per department", async () => {
    const opsAnn = await approved(OPS, { title: "Ops notice" });
    const opsMemo1 = await approved(OPS, { title: "Ops memo 1", docType: "MEMO", attachments: [{ r2Key: "k1", name: "a.pdf", mime: "application/pdf" }] });
    const opsMemo2 = await approved(OPS, { title: "Ops memo 2", docType: "memo", attachments: [{ r2Key: "k2", name: "b.pdf", mime: "application/pdf" }] });
    const hrMemo = await approved(HR, { title: "HR memo", docType: "MEMO", attachments: [{ r2Key: "k3", name: "c.pdf", mime: "application/pdf" }] });
    expect(opsAnn).toMatch(/^OPS-ANN-\d{4}-0001$/);
    expect(opsMemo1).toMatch(/^OPS-MEMO-\d{4}-0001$/);
    expect(opsMemo2).toMatch(/^OPS-MEMO-\d{4}-0002$/);
    expect(hrMemo).toMatch(/^HR-MEMO-\d{4}-0001$/);
  });

  test("the public row carries docType; an unknown or inactive type is refused", async () => {
    const r = await call(OPS, "POST", "", { title: "Plain", draft: true });
    expect(r.data.docType).toBe("ANN");
    const m = await call(OPS, "POST", "", { title: "Memo draft", docType: "MEMO", draft: true });
    expect(m.data.docType).toBe("MEMO");
    expect((await call(OPS, "POST", "", { title: "x", docType: "SOP" })).status).toBe(400);
    expect((await call(OPS, "POST", "", { title: "x", docType: "OLD" })).status).toBe(400);
    expect((await call(OPS, "POST", "", { title: "x", docType: "not a code" })).status).toBe(400);
  });

  test("the attachment policy is read per type: MEMO demands a file, ANN does not", async () => {
    expect((await call(OPS, "POST", "", { title: "Ann without file" })).status).toBe(201);
    const refused = await call(OPS, "POST", "", { title: "Memo without file", docType: "MEMO" });
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/attachment is required/i);
    // As a draft it saves; submit is refused until a file is attached.
    const draft = await call(OPS, "POST", "", { title: "Memo draft", docType: "MEMO", draft: true });
    expect((await call(OPS, "POST", `/${draft.data.id}/submit`)).status).toBe(400);
    await call(OPS, "PATCH", `/${draft.data.id}`, { attachments: [{ r2Key: "k9", name: "z.pdf", mime: "application/pdf" }] });
    expect((await call(OPS, "POST", `/${draft.data.id}/submit`)).status).toBe(200);
  });

  test("the type can change until approval, never after", async () => {
    const d = await call(OPS, "POST", "", { title: "Switch me", draft: true });
    const to = await call(OPS, "PATCH", `/${d.data.id}`, { docType: "MEMO" });
    expect(to.status).toBe(200);
    expect(to.data.docType).toBe("MEMO");
    const back = await call(OPS, "PATCH", `/${d.data.id}`, { docType: "ANN" });
    expect(back.data.docType).toBe("ANN");
    await call(OPS, "POST", `/${d.data.id}/submit`);
    const ok = await call(APPROVER, "POST", `/${d.data.id}/approve`);
    expect(ok.status).toBe(200);
    const locked = await call(OPS, "PATCH", `/${d.data.id}`, { docType: "MEMO" });
    expect(locked.status).toBe(409);
  });
});
