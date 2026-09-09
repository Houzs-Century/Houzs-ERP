// Memo register (mig 20260909T0500, owner 2026-09-08: 每个部门自动生成 memo
// reference number — the register half).
//
//   · POST /api/memos numbers the memo AT CREATION: <DEPT>-MEMO-<YYMM>-NNNN,
//     one sequence per department and month (shared with memos composed as
//     notices — same mint, same series);
//   · a plain user registers for their own department only; memos.manage
//     (or *) for any; a department without a code is refused with the fix;
//   · the MEMO attachment policy (Settings → Documents) gates creation;
//   · void needs a reason, the registrar or a manager, marks the number VOID,
//     audits; twice is a no-op; there is no DELETE route at all.
//
// Same bare-Hono harness as the announcement suites.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import memoRoutes from "../src/routes/memos";

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
function user(id: number, name: string, department_id: number | null, perms: string[]): User {
  return { id, email: `${name.toLowerCase()}@test.local`, name, department_id, position_id: null, position_name: null, permissions: perms, permissions_set: new Set(perms) };
}
const OPS = user(606, "Wira", 7, []);
const HR = user(608, "Hana", 8, []);
const MANAGER = user(700, "Adam", 3, ["memos.manage"]);
const NODEPT = user(801, "Nadia", 9, []);

const state: { user: User | undefined } = { user: OPS };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/memos", memoRoutes);

type Reply = { status: number; success?: boolean; error?: string; data?: any };
async function call(as: User, method: string, path: string, body?: unknown): Promise<Reply> {
  state.user = as;
  const res = await app.request(
    `/api/memos${path}`,
    { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env as never,
  );
  const json = (await res.json().catch(() => ({}))) as Omit<Reply, "status">;
  return { status: res.status, ...json };
}
const FILE = { r2Key: "memos/1725500000000-aaaaaaaa.pdf", name: "Memo.pdf", mime: "application/pdf", size: 2048 };

describe("memo register", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS memos (
         id TEXT PRIMARY KEY, title TEXT NOT NULL, department_id INTEGER NOT NULL, dept_code TEXT NOT NULL,
         memo_date TEXT NOT NULL, notes TEXT, file_key TEXT, file_name TEXT, file_mime TEXT, file_size INTEGER,
         ref_no TEXT UNIQUE, created_by INTEGER, created_at TEXT NOT NULL,
         voided_by INTEGER, voided_at TEXT, void_reason TEXT)`,
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
    for (const [id, name, code] of [[7, "Operation", "OPS"], [8, "Human Resources", "HR"], [3, "Management", "MGT"], [9, "Canteen", null]] as Array<[number, string, string | null]>) {
      await env.DB.prepare("INSERT OR IGNORE INTO departments (id, name, code) VALUES (?, ?, ?)").bind(id, name, code).run();
      await env.DB.prepare("UPDATE departments SET code = ? WHERE id = ?").bind(code, id).run();
    }
    for (const u of [OPS, HR, MANAGER, NODEPT]) {
      await env.DB.prepare("INSERT OR REPLACE INTO users (id, name, email, status, role_id, department_id) VALUES (?, ?, ?, 'active', 1, ?)")
        .bind(u.id, u.name, u.email, u.department_id)
        .run();
    }
    await env.DB.prepare("DELETE FROM memos").run();
    await env.DB.prepare("DELETE FROM document_refs WHERE entity_type = 'memo'").run();
    await env.DB.prepare("DELETE FROM document_types").run();
    await env.DB.prepare(
      "INSERT INTO document_types (code, label, attachment_required, is_active, created_at) VALUES ('ANN', 'Announcement', 0, 1, '2026-09-06T00:00:00.000Z'), ('MEMO', 'Memo', 0, 1, '2026-09-08T00:00:00.000Z')",
    ).run();
  });

  test("registering mints <DEPT>-MEMO-YYMM-NNNN at creation, per department", async () => {
    const a = await call(OPS, "POST", "", { title: "Forklift keys", memoDate: "2026-09-09", file: FILE });
    expect(a.status).toBe(201);
    expect(a.data.refNo).toMatch(/^OPS-MEMO-\d{4}-0001$/);
    expect(a.data.departmentName).toBe("Operation");
    expect(a.data.createdByName).toBe("Wira");
    expect(a.data.file.name).toBe("Memo.pdf");
    expect(a.data.memoDate).toBe("2026-09-09");
    const b = await call(OPS, "POST", "", { title: "Second", departmentId: 7 });
    expect(b.data.refNo).toMatch(/^OPS-MEMO-\d{4}-0002$/);
    expect(b.data.file).toBeNull();
    // The date defaults to today when omitted.
    expect(b.data.memoDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const h = await call(HR, "POST", "", { title: "Leave policy", departmentId: 8 });
    expect(h.data.refNo).toMatch(/^HR-MEMO-\d{4}-0001$/);
    // The registry knows the memo.
    const reg = await env.DB.prepare("SELECT entity_type, entity_id, status FROM document_refs WHERE ref_no = ?").bind(a.data.refNo).first<{ entity_type: string; entity_id: string; status: string }>();
    expect(reg).toEqual({ entity_type: "memo", entity_id: a.data.id, status: "ACTIVE" });
    const audit = await env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ?").bind(a.data.id).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["memo.create"]);
  });

  test("own department only, unless memos.manage; a department without a code is refused with the fix", async () => {
    const other = await call(OPS, "POST", "", { title: "Not mine", departmentId: 8 });
    expect(other.status).toBe(403);
    const managed = await call(MANAGER, "POST", "", { title: "Any department", departmentId: 8 });
    expect(managed.status).toBe(201);
    expect(managed.data.refNo).toMatch(/^HR-MEMO-\d{4}-0002$/);
    const noCode = await call(NODEPT, "POST", "", { title: "Canteen memo" });
    expect(noCode.status).toBe(409);
    expect(noCode.error).toMatch(/Canteen.*no code/);
    expect((await call(OPS, "POST", "", { title: "" })).status).toBe(400);
    expect((await call(OPS, "POST", "", { title: "Bad date", memoDate: "9/9/26" })).status).toBe(400);
    expect((await call(OPS, "POST", "", { title: "Bad key", file: { ...FILE, r2Key: "announcements/x.pdf" } })).status).toBe(400);
  });

  test("the MEMO attachment policy gates registration", async () => {
    await env.DB.prepare("UPDATE document_types SET attachment_required = 1 WHERE code = 'MEMO'").run();
    const refused = await call(OPS, "POST", "", { title: "No file" });
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/attachment is required/i);
    expect((await call(OPS, "POST", "", { title: "With file", file: FILE })).status).toBe(201);
    await env.DB.prepare("UPDATE document_types SET attachment_required = 0 WHERE code = 'MEMO'").run();
  });

  test("the register lists, filters by department and hides voided rows unless asked", async () => {
    const all = await call(HR, "GET", "");
    expect(all.status).toBe(200);
    expect(all.data.length).toBeGreaterThanOrEqual(4);
    const ops = await call(HR, "GET", "?departmentId=7");
    expect(ops.data.every((m: any) => m.departmentId === 7)).toBe(true);
    expect(ops.data.map((m: any) => m.refNo)).toEqual(expect.arrayContaining([expect.stringMatching(/^OPS-MEMO-/)]));
  });

  test("void: a reason, the registrar or a manager; the number goes VOID; twice is a no-op; no DELETE route", async () => {
    const m = await call(OPS, "POST", "", { title: "To void" });
    const id = m.data.id as string;
    expect((await call(OPS, "POST", `/${id}/void`, { reason: " " })).status).toBe(400);
    expect((await call(HR, "POST", `/${id}/void`, { reason: "not mine" })).status).toBe(403);
    const v = await call(OPS, "POST", `/${id}/void`, { reason: "Issued in error." });
    expect(v.status).toBe(200);
    expect(v.data.voidReason).toBe("Issued in error.");
    expect(v.data.voidedByName).toBe("Wira");
    const reg = await env.DB.prepare("SELECT status FROM document_refs WHERE ref_no = ?").bind(m.data.refNo).first<{ status: string }>();
    expect(reg?.status).toBe("VOID");
    const again = await call(MANAGER, "POST", `/${id}/void`, { reason: "another" });
    expect(again.status).toBe(200);
    expect(again.data.voidReason).toBe("Issued in error.");
    // Hidden from the default list, present with includeVoided=1.
    expect((await call(OPS, "GET", "")).data.some((x: any) => x.id === id)).toBe(false);
    expect((await call(OPS, "GET", "?includeVoided=1")).data.some((x: any) => x.id === id)).toBe(true);
    // The next memo in the series moves on — a voided number is never re-issued.
    const next = await call(OPS, "POST", "", { title: "After the void" });
    expect(next.data.refNo).not.toBe(m.data.refNo);
    // No delete door.
    expect((await call(MANAGER, "DELETE", `/${id}`)).status).toBe(404);
  });
});
