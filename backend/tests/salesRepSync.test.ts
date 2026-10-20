import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { ensureSalesRepForUser, syncSalesRepFromUser } from "../src/services/salesTeam";
import { attendeeRepId } from "../src/services/salesAttending";

// Covers the CREATE-path guarantee the users invite handler now relies on:
// creating a user straight into a Sales department must yield an active
// sales_reps row (previously the row was only minted on a later department
// CHANGE, so directly-invited Sales staff were missing from the PMS
// "Sales Attending" picker). The invite route's new behaviour is exactly
// "call syncSalesRepFromUser once the user + department exist", so exercising
// that function against the isolated test D1 verifies the fix end-to-end
// without standing up the full auth/email route harness.

const SALES_DEPT_ID = 900;
const OTHER_DEPT_ID = 901;

// The test D1 enforces FKs: users.role_id → roles(id), users.department_id →
// departments(id), sales_reps.user_id → users(id). Seed the throwaway parents.
async function seedUser(id: number, deptId: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, role_id, department_id, status)
     VALUES (?, ?, 1, ?, 'active')`,
  )
    .bind(id, `rep-sync-${id}@example.com`, deptId)
    .run();
}

// Read the rep the picker would see: active + not archived, linked to a user.
async function repForUser(userId: number) {
  return env.DB.prepare(
    `SELECT id, code, status, archived_at FROM sales_reps WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ id: number; code: string; status: string; archived_at: string | null }>();
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM sales_reps`);
  await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'rep-sync-role')`).run();
  // Prod matches any department NAME containing 'sales' (it's "Sales
  // Department", not the canonical "Sales") — seed that exact shape.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO departments (id, name) VALUES (?, 'Sales Department')`,
  )
    .bind(SALES_DEPT_ID)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO departments (id, name) VALUES (?, 'Operations')`,
  )
    .bind(OTHER_DEPT_ID)
    .run();
});

describe("syncSalesRepFromUser (invite/create path)", () => {
  test("creates an active, non-archived rep for a user invited into Sales", async () => {
    await seedUser(201, SALES_DEPT_ID);

    const res = await syncSalesRepFromUser(env, 201, null);
    expect(res.action).toBe("created");

    const rep = await repForUser(201);
    expect(rep).toBeTruthy();
    // The picker filter is `archived_at IS NULL AND status = 'active'` — the
    // freshly created rep must satisfy it, or it stays invisible.
    expect(rep?.status).toBe("active");
    expect(rep?.archived_at).toBeNull();
    expect(rep?.code).toMatch(/^SR-\d{3}$/);
  });

  test("is idempotent — re-running never duplicates the rep", async () => {
    await seedUser(202, SALES_DEPT_ID);

    const first = await syncSalesRepFromUser(env, 202, null);
    expect(first.action).toBe("created");
    const second = await syncSalesRepFromUser(env, 202, null);
    expect(second.action).toBe("noop");

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sales_reps WHERE user_id = ?`,
    )
      .bind(202)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  test("does NOT create a rep for a non-Sales user", async () => {
    await seedUser(203, OTHER_DEPT_ID);

    const res = await syncSalesRepFromUser(env, 203, null);
    expect(res.action).toBe("noop");
    expect(await repForUser(203)).toBeNull();
  });

  test("does NOT create a rep for a user with no department", async () => {
    await seedUser(204, null);

    const res = await syncSalesRepFromUser(env, 204, null);
    expect(res.action).toBe("noop");
    expect(await repForUser(204)).toBeNull();
  });
});

/* Owner 2026-10-19: 「不需要改部门啊，就让他们可以去 sales attending 不就好了？」
   Picking a staff member who is not on the roster in PMS Sales Attending puts
   them on it — without touching their department. */
describe("ensureSalesRepForUser (picked in Sales Attending)", () => {
  test("puts a non-Sales user on the roster and leaves their department alone", async () => {
    await seedUser(211, OTHER_DEPT_ID);

    const res = await ensureSalesRepForUser(env, 211, null, "Added from Sales Attending");
    expect(res?.action).toBe("created");

    const rep = await repForUser(211);
    expect(rep?.status).toBe("active");
    expect(rep?.archived_at).toBeNull();
    const user = await env.DB.prepare(`SELECT department_id FROM users WHERE id = ?`).bind(211).first<{ department_id: number }>();
    expect(user?.department_id).toBe(OTHER_DEPT_ID);
  });

  test("brings an archived row back instead of making a second one", async () => {
    await seedUser(212, OTHER_DEPT_ID);
    await env.DB.prepare(
      `INSERT INTO sales_reps (code, name, email, user_id, status, archived_at) VALUES ('SR-912', 'Old', NULL, 212, 'active', '2026-09-01 00:00:00')`,
    ).run();

    const res = await ensureSalesRepForUser(env, 212, null, "Added from Sales Attending");
    expect(res?.action).toBe("unarchived");
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sales_reps WHERE user_id = ?`).bind(212).first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect((await repForUser(212))?.archived_at).toBeNull();
  });

  test("an active row is used as it is", async () => {
    await seedUser(213, SALES_DEPT_ID);
    const made = await syncSalesRepFromUser(env, 213, null);

    const res = await ensureSalesRepForUser(env, 213, null, "Added from Sales Attending");
    expect(res).toEqual({ action: "existing", repId: made.repId });
  });

  test("a login that is not active is refused", async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, email, role_id, department_id, status) VALUES (?, ?, 1, ?, 'invited')`,
    ).bind(214, "rep-sync-214@example.com", OTHER_DEPT_ID).run();

    expect(await ensureSalesRepForUser(env, 214, null, "Added from Sales Attending")).toBeNull();
    expect(await repForUser(214)).toBeNull();
  });
});

describe("attendeeRepId (POST /projects/:id/sales-attendees body)", () => {
  test("a roster id passes straight through", async () => {
    expect(await attendeeRepId(env, null, { sales_rep_id: 77 }, null, 1)).toEqual({ ok: true, repId: 77 });
  });

  test("a login not on the roster is put on it and its roster id answered", async () => {
    await seedUser(221, OTHER_DEPT_ID);
    const res = await attendeeRepId(env, null, { user_id: 221 }, null, 1);
    expect(res.ok).toBe(true);
    const rep = await repForUser(221);
    expect(res.ok && res.repId).toBe(rep?.id);
  });

  test("nothing chosen is refused with the picker's sentence", async () => {
    expect(await attendeeRepId(env, null, {}, null, 1)).toEqual({ ok: false, error: "Please choose a sales attendee." });
  });
});
