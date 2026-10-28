// Project row-level visibility, AFTER the PIC/brand ACL removal (owner decision
// 2026-08-19). The old rule scoped a Sales rep to projects where they (or their
// manager) were the PIC AND whose brand was in their allow-list. That whole
// axis is gone: within a company, ANY user with the projects page permission
// sees EVERY one of that company's projects, regardless of PIC or brand. The
// company boundary must STILL hold — this widens visibility inside a company,
// never across companies.
//
// Harness follows projectChecklistTemplateCompanyScope.test.ts: a bare Hono app
// that stands in the user + company context, the REAL projects router, and the
// isolated D1. Real SQL runs, so a re-introduced pic/brand predicate would
// genuinely drop rows here rather than being mocked away.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import projectRoutes from "../src/routes/projects";

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

const CALLER_ID = 909; // the scoped-style Sales rep making the request
const OTHER_ID = 910; // a different rep — projects PIC'd to them must still show

// A user who, under the OLD ACL, was row-scoped: scope_to_pic + a non-director
// Sales position, with NO brand allow-list (brand_scope null). Old behaviour
// would have shown them almost nothing; new behaviour shows every company row.
const state = {
  company: undefined as number | undefined,
  allowed: undefined as number[] | undefined,
};

const USER = {
  id: CALLER_ID,
  name: "Scoped Rep",
  role_name: "Sales Person",
  position_name: "Sales Executive",
  department_name: "Sales",
  scope_to_pic: true,
  brand_scope: null as string[] | null,
  manager_id: null as number | null,
  position_id: 7,
  permissions: [] as string[],
  permissions_set: new Set<string>(),
  // The only gate that remains on the list read: projects.list page access.
  page_access: { "projects.list": "view" },
};

const app = new Hono();
app.use("*", async (c: never, next: never) => {
  const set = (c as { set: (k: string, v: unknown) => void }).set;
  set("user", USER);
  set("companyId", state.company);
  set("allowedCompanyIds", state.allowed);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/projects", projectRoutes);

async function list(company: number | undefined): Promise<{ status: number; json: any }> {
  state.company = company;
  state.allowed = company === undefined ? undefined : [company];
  const res = await app.request(
    "/api/projects?per_page=200",
    { method: "GET" } as never,
    env as never,
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** The D1 mirror predates mig-pg 0093, so its projects table has no company_id.
 *  Add it — the pg tree has carried it since 0093. */
async function addCompanyIdColumn(table: string) {
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN company_id INTEGER`).run();
  } catch {
    // Already present (suite re-run against a warm isolate).
  }
}

// Distinct project ids so assertions are unambiguous.
const P_A_OTHER_AKEMI = 8001; // CO_A, PIC = someone else, brand AKEMI
const P_A_OTHER_ZANOTTI = 8002; // CO_A, PIC = someone else, brand ZANOTTI (different brand)
const P_A_MINE_NOBRAND = 8003; // CO_A, PIC = caller, brand NULL
const P_B_OTHER_AKEMI = 8004; // CO_B — must NEVER show for a CO_A caller

beforeAll(async () => {
  await addCompanyIdColumn("projects");
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM users WHERE id IN (${CALLER_ID}, ${OTHER_ID})`);

  // users.role_id is NOT NULL — seed a throwaway role for the PIC FK rows.
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'test', '[]', 1)`,
  )
    .bind(`row-vis role ${crypto.randomUUID()}`)
    .run();
  const roleId = role.meta.last_row_id as number;

  for (const [id, name] of [
    [CALLER_ID, "Scoped Rep"],
    [OTHER_ID, "Other Rep"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, role_id, status, joined_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
    )
      .bind(id, `u${id}@test.local`, name, roleId)
      .run();
  }

  const rows: [number, string, string | null, number, number][] = [
    // id, name, brand, pic_id, company_id
    [P_A_OTHER_AKEMI, "A other AKEMI", "AKEMI", OTHER_ID, CO_A],
    [P_A_OTHER_ZANOTTI, "A other ZANOTTI", "ZANOTTI", OTHER_ID, CO_A],
    [P_A_MINE_NOBRAND, "A mine no brand", null, CALLER_ID, CO_A],
    [P_B_OTHER_AKEMI, "B other AKEMI", "AKEMI", OTHER_ID, CO_B],
  ];
  for (const [id, name, brand, pic, co] of rows) {
    await env.DB.prepare(
      `INSERT INTO projects (id, name, stage, brand, pic_id, created_by, company_id)
       VALUES (?, ?, 'live', ?, ?, ?, ?)`,
    )
      .bind(id, name, brand, pic, pic, co)
      .run();
  }
});

describe("project list — PIC/brand ACL removed, company boundary intact", () => {
  test("a scoped-style rep sees ALL their company's projects regardless of PIC or brand", async () => {
    const a = await list(CO_A);
    expect(a.status).toBe(200);
    const ids: number[] = (a.json?.data ?? []).map((p: any) => p.id);
    // All three CO_A projects: one they PIC (no brand), and two PIC'd to someone
    // else with brands NOT in any allow-list. Under the old ACL none of the
    // "other" rows would have shown.
    expect(ids).toContain(P_A_OTHER_AKEMI);
    expect(ids).toContain(P_A_OTHER_ZANOTTI);
    expect(ids).toContain(P_A_MINE_NOBRAND);
    // The company boundary still holds — CO_B's project must not leak.
    expect(ids).not.toContain(P_B_OTHER_AKEMI);
  });

  test("the company boundary still scopes: a CO_B caller sees only CO_B projects", async () => {
    const b = await list(CO_B);
    expect(b.status).toBe(200);
    const ids: number[] = (b.json?.data ?? []).map((p: any) => p.id);
    expect(ids).toEqual([P_B_OTHER_AKEMI]);
    expect(ids).not.toContain(P_A_OTHER_AKEMI);
    expect(ids).not.toContain(P_A_MINE_NOBRAND);
  });
});
