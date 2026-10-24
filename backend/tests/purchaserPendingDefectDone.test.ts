// Purchaser "My Pending" — the defect-replace lane must drop a project once the
// defect ITEM is closed, not keep nagging on the attachment's stale 'replace'.
//
// Owner 2026-10-21 (Sim, Purchaser): two HOMEDEC @ Setia Spice events (AKEMI,
// ZANOTTI, 2-4 Oct 2026) sat on Sim's My Pending even though the only open work
// on them was BD's ("2D Design") and Sales/owner's ("Event Complete Image").
// Root cause: the PURCHASER lane's defect arm (services/projects.ts) matched any
// event with a 'Defect Item%' / 'Defect List%' attachment whose LATEST action is
// 'replace' — and never checked whether the defect item itself was still open.
// Shukor's 'replace' stays on the attachment forever, so once Sim finished and
// ticked the item done the event lingered for the whole 30-day window. The list
// then showed the project's current section chip (a BD/owner task), which read as
// "why is this on my list". Fix: the arm now requires dl.status NOT IN
// ('done','na'). This test seeds both halves so a re-dropped guard turns it red.
//
// Harness follows projectsRowVisibility.test.ts: a bare Hono app standing in the
// user + company context, the REAL projects router, and the isolated D1. Real SQL
// runs, so the guard is exercised against the actual lane query, not a mock.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import projectRoutes from "../src/routes/projects";
import { todayMyt } from "../src/scm/lib/my-time";

const CO_A = 1;

// A Purchaser (Sim / Farra). role_name "Purchaser" maps to the PURCHASER lane in
// routes/projects.ts; no approval permission, so it does NOT take the approver
// branch. Only projects.list page access is needed to read the list.
const USER = {
  id: 84,
  name: "Sim",
  role_name: "Purchaser",
  position_name: "Operation Executive",
  department_name: null,
  scope_to_pic: false,
  brand_scope: null as string[] | null,
  manager_id: null as number | null,
  position_id: 7,
  permissions: [] as string[],
  permissions_set: new Set<string>(),
  page_access: { "projects.list": "view" },
};

const state = { company: undefined as number | undefined, allowed: undefined as number[] | undefined };

const app = new Hono();
app.use("*", async (c: never, next: never) => {
  const set = (c as { set: (k: string, v: unknown) => void }).set;
  set("user", USER);
  set("companyId", state.company);
  set("allowedCompanyIds", state.allowed);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api/projects", projectRoutes);

async function myPendingIds(): Promise<number[]> {
  state.company = CO_A;
  state.allowed = [CO_A];
  const res = await app.request(
    "/api/projects?my_pending=1&per_page=200",
    { method: "GET" } as never,
    env as never,
  );
  const json: any = await res.json().catch(() => null);
  return (json?.data ?? []).map((p: any) => p.id);
}

/** The D1 mirror predates mig-pg 0093, so projects has no company_id. Add it. */
async function addCompanyIdColumn() {
  try {
    await env.DB.prepare(`ALTER TABLE projects ADD COLUMN company_id INTEGER`).run();
  } catch {
    // Already present (warm isolate).
  }
}

// end_date within the 30-day defect window AND past the My Pending epoch
// (2026-08-01). Relative to "now" so the test never ages out.
const RECENT = todayMyt(-3);

const P_DONE = 7701; // defect item ticked done -> must NOT appear (the bug)
const P_OPEN = 7702; // defect item still open  -> must appear (positive control)

beforeAll(async () => {
  await addCompanyIdColumn();
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM project_checklist_attachment_actions WHERE attachment_id IN (77010, 77020)`);
  await env.DB.exec(`DELETE FROM project_checklist_attachments WHERE id IN (77010, 77020)`);
  await env.DB.exec(`DELETE FROM project_checklist WHERE id IN (77011, 77021)`);
  await env.DB.exec(`DELETE FROM projects WHERE id IN (${P_DONE}, ${P_OPEN})`);

  // Two confirmed events that ended within the last 30 days.
  for (const [id, name] of [[P_DONE, "AKEMI done defect"], [P_OPEN, "ZANOTTI open defect"]] as const) {
    await env.DB.prepare(
      `INSERT INTO projects (id, name, stage, status, start_date, end_date, company_id)
       VALUES (?, ?, 'draft', 'confirmed', ?, ?, ?)`,
    )
      .bind(id, name, RECENT, RECENT, CO_A)
      .run();
  }

  // A defect item on each. The arm keys on the TITLE + a 'replace' attachment,
  // not on role_label, so role_label stays NULL (never 'PURCHASER', which would
  // instead trip the lane's role-label arm and mask what we are testing).
  const items: [number, number, string][] = [
    [77011, P_DONE, "done"],
    [77021, P_OPEN, "pending"],
  ];
  for (const [itemId, projectId, status] of items) {
    await env.DB.prepare(
      `INSERT INTO project_checklist (id, project_id, seq, title, status)
       VALUES (?, ?, 0, 'Defect Item Setup', ?)`,
    )
      .bind(itemId, projectId, status)
      .run();
  }

  // One attachment per item, each escalated by the reviewer: latest action 'replace'.
  const atts: [number, number][] = [
    [77010, 77011],
    [77020, 77021],
  ];
  for (const [attId, itemId] of atts) {
    await env.DB.prepare(
      `INSERT INTO project_checklist_attachments (id, item_id, r2_key, file_name)
       VALUES (?, ?, ?, 'defect.jpg')`,
    )
      .bind(attId, itemId, `k/${attId}`)
      .run();
    await env.DB.prepare(
      `INSERT INTO project_checklist_attachment_actions (attachment_id, status, user_id)
       VALUES (?, 'replace', 60)`,
    )
      .bind(attId)
      .run();
  }
});

describe("purchaser My Pending — defect-replace arm respects the item status", () => {
  test("a defect item ticked done drops off the lane; a still-open one stays", async () => {
    const ids = await myPendingIds();
    // The reported bug: the done event lingered because the attachment's last
    // action is still 'replace'. It must now be gone.
    expect(ids).not.toContain(P_DONE);
    // Positive control: a genuine open replace must still reach the purchaser,
    // so the guard narrows the lane rather than emptying it.
    expect(ids).toContain(P_OPEN);
  });
});
