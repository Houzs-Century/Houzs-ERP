// Announcement approval workflow (mig 20260906T1509, owner 2026-09-06).
//
//   DRAFT → PENDING_APPROVAL → APPROVED (ref no minted) / REJECTED (reason)
//
// What must hold, on the real router against a D1 mirror:
//   · a new notice is NOT served to its audience until approved — the list
//     for a reader, the ack endpoint, the manager ledger all agree;
//   · approve / reject are behind announcements.approve, and approve mints
//     [DEPT]-ANN-[YYMM]-[NNNN] from the SUBMITTER's department code — a
//     department without a code blocks the approval with a message;
//   · reject needs a reason; a rejected notice can be submitted again;
//   · the approvers' bell rings on submit (not for the submitter), the
//     submitter's bell rings on approve / reject; audit_events has the trail.
//
// Same bare-Hono harness as announcementsRichBody.test.ts.

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import announcementRoutes from "../src/routes/announcements";
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
function user(id: number, name: string, department_id: number | null, perms: string[]): User {
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
// Ops manager: writes notices. Department 7 (Operation) gets its code mid-suite.
const WRITER = user(606, "Wira", 7, ["announcements.write"]);
// The approval desk: reads + approves, does NOT hold write.
const APPROVER = user(700, "Adam", 3, ["announcements.read", "announcements.approve"]);
// Plain staff in the audience.
const READER = user(800, "Rina", 7, []);

const state: { user: User | undefined } = { user: WRITER };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/announcements", announcementRoutes);

type Pub = {
  id: string;
  title: string;
  approvalStatus: string;
  submittedBy: number | null;
  reviewedBy: number | null;
  rejectReason: string | null;
  refNo: string | null;
};
type Reply = { status: number; success?: boolean; error?: string; data?: Pub; acked?: boolean };

async function call(as: User | undefined, method: string, path: string, body?: unknown): Promise<Reply> {
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
  state.user = as;
  const res = await app.request("/api/announcements", {}, env as never);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((a) => a.id);
}
/** System notices posted to one person by the flow (the bell slice). */
async function bellFor(userId: number): Promise<Array<{ title: string; category: string }>> {
  const res = await env.DB.prepare(
    "SELECT title, category, target_user_ids FROM announcements WHERE source = 'announcement_approval' ORDER BY created_at",
  ).all<{ title: string; category: string; target_user_ids: string }>();
  return res.results
    .filter((r) => (JSON.parse(r.target_user_ids) as number[]).includes(userId))
    .map((r) => ({ title: r.title, category: r.category }));
}

describe("announcement approval workflow", () => {
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
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY, name TEXT, email TEXT, status TEXT, role_id INTEGER,
         department_id INTEGER, position_id INTEGER, division TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT, code TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT, permissions TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_types (
         code TEXT PRIMARY KEY, label TEXT, attachment_required INTEGER, is_active INTEGER,
         created_at TEXT, updated_at TEXT)`,
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
    // Another suite in the same worker may have created these tables with a
    // narrower shape: add the columns this flow reads when they are missing.
    for (const [table, col, type] of [
      ["departments", "code", "TEXT"],
      ["departments", "name", "TEXT"],
      ["users", "status", "TEXT"],
      ["users", "role_id", "INTEGER"],
      ["users", "department_id", "INTEGER"],
      ["users", "division", "TEXT"],
      ["users", "name", "TEXT"],
      ["users", "email", "TEXT"],
      ["roles", "permissions", "TEXT"],
      ["roles", "name", "TEXT"],
    ] as Array<[string, string, string]>) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run().catch(() => undefined);
    }
    await env.DB.prepare("DELETE FROM announcements").run();
    await env.DB.prepare("DELETE FROM document_refs").run();
    await env.DB.prepare("DELETE FROM audit_events").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM departments").run();
    await env.DB.prepare("DELETE FROM roles").run();
    await env.DB.prepare("INSERT INTO roles (id, name, permissions) VALUES (1, 'Ops', ?), (2, 'MD', ?), (3, 'Staff', ?)")
      .bind(JSON.stringify(["announcements.write"]), JSON.stringify(["announcements.read", "announcements.approve"]), JSON.stringify([]))
      .run();
    await env.DB.prepare("INSERT INTO departments (id, name, code) VALUES (7, 'Operation', NULL), (3, 'Management', 'MGT')").run();
    for (const [u, role] of [
      [WRITER, 1],
      [APPROVER, 2],
      [READER, 3],
    ] as Array<[User, number]>) {
      await env.DB.prepare(
        "INSERT INTO users (id, name, email, status, role_id, department_id) VALUES (?, ?, ?, 'active', ?, ?)",
      )
        .bind(u.id, u.name, u.email, role, u.department_id)
        .run();
    }
  });

  test("deliverableNow requires APPROVED; a legacy row without the column still delivers", () => {
    const base = { id: "x", is_active: 1, expires_at: null, category: "GENERAL" };
    expect(deliverableNow({ ...base })).toBe(true);
    expect(deliverableNow({ ...base, approval_status: "APPROVED" })).toBe(true);
    expect(deliverableNow({ ...base, approval_status: "PENDING_APPROVAL" })).toBe(false);
    expect(deliverableNow({ ...base, approval_status: "REJECTED" })).toBe(false);
    expect(deliverableNow({ ...base, approval_status: "DRAFT" })).toBe(false);
  });

  let pendingId = "";

  test("POST creates INTO THE QUEUE: pending, invisible to readers, on the approvers' bell", async () => {
    const r = await call(WRITER, "POST", "", { title: "Forklift rule", body: "No riders." });
    expect(r.status).toBe(201);
    expect(r.data?.approvalStatus).toBe("PENDING_APPROVAL");
    expect(r.data?.submittedBy).toBe(WRITER.id);
    expect(r.data?.refNo).toBeNull();
    pendingId = r.data!.id;

    expect(await listIds(READER)).not.toContain(pendingId);
    expect(await listIds(WRITER)).toContain(pendingId);
    // The approval desk reads the ledger without announcements.write.
    expect(await listIds(APPROVER)).toContain(pendingId);
    // Nobody can acknowledge what is not published: the ack route answers
    // { acked: false } for a notice that is not deliverable, and writes nothing.
    const ack = await call(READER, "POST", `/${pendingId}/ack`);
    expect(ack.status).toBe(200);
    expect(ack.acked).toBe(false);

    const bell = await bellFor(APPROVER.id);
    expect(bell.map((b) => b.title)).toEqual(["Approval needed: Forklift rule"]);
    expect(await bellFor(WRITER.id)).toEqual([]);
    const audit = await env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ? ORDER BY id")
      .bind(pendingId)
      .all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["announcement.submit"]);
  });

  test("approve is gated by announcements.approve, and blocked while the submitter's department has no code", async () => {
    const denied = await call(WRITER, "POST", `/${pendingId}/approve`);
    expect(denied.status).toBe(403);
    const blocked = await call(APPROVER, "POST", `/${pendingId}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.error).toMatch(/Operation.*no code/);
    // Still pending, still invisible.
    expect(await listIds(READER)).not.toContain(pendingId);
  });

  test("approve mints [DEPT]-ANN-[YYMM]-[NNNN] from the submitter's department and publishes", async () => {
    await env.DB.prepare("UPDATE departments SET code = 'OPS' WHERE id = 7").run();
    const r = await call(APPROVER, "POST", `/${pendingId}/approve`);
    expect(r.status).toBe(200);
    expect(r.data?.approvalStatus).toBe("APPROVED");
    expect(r.data?.reviewedBy).toBe(APPROVER.id);
    expect(r.data?.refNo).toMatch(/^OPS-ANN-\d{4}-0001$/);

    expect(await listIds(READER)).toContain(pendingId);
    const ack = await call(READER, "POST", `/${pendingId}/ack`);
    expect(ack.status).toBe(200);
    expect(ack.acked).toBe(true);

    const reg = await env.DB.prepare("SELECT ref_no, entity_type, entity_id, status FROM document_refs")
      .all<{ ref_no: string; entity_type: string; entity_id: string; status: string }>();
    expect(reg.results).toEqual([
      { ref_no: r.data!.refNo, entity_type: "announcement", entity_id: pendingId, status: "ACTIVE" },
    ]);
    expect((await bellFor(WRITER.id)).map((b) => b.title)).toEqual(["Approved: Forklift rule"]);
    const audit = await env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ? ORDER BY id")
      .bind(pendingId)
      .all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["announcement.submit", "announcement.approve"]);

    // Approving twice is refused; submitting an approved notice is refused.
    expect((await call(APPROVER, "POST", `/${pendingId}/approve`)).status).toBe(409);
    expect((await call(WRITER, "POST", `/${pendingId}/submit`)).status).toBe(409);
  });

  test("reject needs a reason, tells the submitter, and the notice can be submitted again", async () => {
    const created = await call(WRITER, "POST", "", { title: "Canteen hours" });
    const id = created.data!.id;
    const noReason = await call(APPROVER, "POST", `/${id}/reject`, { reason: "  " });
    expect(noReason.status).toBe(400);
    const denied = await call(READER, "POST", `/${id}/reject`, { reason: "x" });
    expect(denied.status).toBe(403);

    const r = await call(APPROVER, "POST", `/${id}/reject`, { reason: "Wrong closing time." });
    expect(r.status).toBe(200);
    expect(r.data?.approvalStatus).toBe("REJECTED");
    expect(r.data?.rejectReason).toBe("Wrong closing time.");
    expect(await listIds(READER)).not.toContain(id);
    const bell = await bellFor(WRITER.id);
    expect(bell[bell.length - 1]).toEqual({ title: "Rejected: Canteen hours", category: "WARNING" });
    // Rejecting again is refused (not pending any more).
    expect((await call(APPROVER, "POST", `/${id}/reject`, { reason: "again" })).status).toBe(409);

    const again = await call(WRITER, "POST", `/${id}/submit`);
    expect(again.status).toBe(200);
    expect(again.data?.approvalStatus).toBe("PENDING_APPROVAL");
    expect(again.data?.rejectReason).toBeNull();
    // Second time on the approvers' bell.
    expect((await bellFor(APPROVER.id)).filter((b) => b.title === "Approval needed: Canteen hours")).toHaveLength(1);
    const ok = await call(APPROVER, "POST", `/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.data?.refNo).toMatch(/^OPS-ANN-\d{4}-0002$/);
    expect(await listIds(READER)).toContain(id);
  });

  test("a draft rings nobody's bell until it is submitted", async () => {
    const before = (await bellFor(APPROVER.id)).length;
    const created = await call(WRITER, "POST", "", { title: "Draft one", draft: true });
    expect(created.status).toBe(201);
    expect(created.data?.approvalStatus).toBe("DRAFT");
    expect(created.data?.submittedBy).toBeNull();
    expect((await bellFor(APPROVER.id)).length).toBe(before);
    expect(await listIds(READER)).not.toContain(created.data!.id);
    // A draft cannot be approved — it was never submitted.
    expect((await call(APPROVER, "POST", `/${created.data!.id}/approve`)).status).toBe(409);

    const sub = await call(WRITER, "POST", `/${created.data!.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.data?.approvalStatus).toBe("PENDING_APPROVAL");
    expect(sub.data?.submittedBy).toBe(WRITER.id);
    expect((await bellFor(APPROVER.id)).length).toBe(before + 1);
    // Submitting a pending notice again is a no-op — no second bell.
    expect((await call(WRITER, "POST", `/${created.data!.id}/submit`)).status).toBe(200);
    expect((await bellFor(APPROVER.id)).length).toBe(before + 1);
  });
});
