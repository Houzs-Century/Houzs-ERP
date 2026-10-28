// Project checklist TEMPLATES are per-company (mig 0288, owner 2026-08-13:
// "应该按公司分开"). Before this, /checklist-templates was company-BLIND on both
// the read and the write side — one shared master, both companies editing the
// same rows — while project_brands and project_venues, in the same router and
// carrying company_id from the same mig 0093, were already split.
//
// EVERY case is asserted in BOTH directions, deliberately, following
// companyScopeHardening.test.ts's rule: the failure mode of a scope sweep is not
// "the leak stayed open", it is "we hid a company's own data from its own users"
// — an outage nobody reports, because you cannot report data you cannot see. So
// each cross-company refusal is paired with a same-company request proving the
// legitimate path still works, and each refused WRITE also asserts the victim row
// was left UNCHANGED (a 404 that still mutated would pass a status-only check).
//
// Harness follows announcementsBannerFilter.test.ts: a bare Hono app that stands
// in the user + company context, the REAL projects router, and the isolated D1.
// Real SQL runs, so a dropped predicate genuinely returns the other company's
// rows rather than being mocked away.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import projectRoutes from "../src/routes/projects";

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

const TPL_A = 9001;
const TPL_B = 9002;

/* Mutable request context. `company: undefined` models the UNRESOLVED state
   (companies master unreadable / cold start) — activeCompanySql degrades to no
   predicate there, and requireActiveCompanyId REFUSES, which is the asymmetry
   the last describe block pins. */
const state = {
  company: undefined as number | undefined,
  allowed: undefined as number[] | undefined,
};

const USER = {
  id: 909,
  department_id: null,
  position_id: null,
  permissions: ["*"] as string[],
  permissions_set: new Set<string>(["*"]),
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

async function api(
  method: string,
  path: string,
  company: number | undefined,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  state.company = company;
  // A resolved context always carries an allow-list; only the explicit
  // unresolved case below clears it.
  state.allowed = company === undefined ? undefined : [company];
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(`/api/projects${path}`, init as never, env as never);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** The D1 mirror predates mig 0093/0288, so its template tables have no
 *  company_id. Add it here — the pg tree has carried it since 0093. */
async function addCompanyIdColumn(table: string) {
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN company_id INTEGER`).run();
  } catch {
    // Already present (suite re-run against a warm isolate).
  }
}

beforeAll(async () => {
  for (const t of [
    "project_checklist_templates",
    "project_checklist_template_sections",
    "project_checklist_template_items",
  ]) {
    await addCompanyIdColumn(t);
  }
});

beforeEach(async () => {
  // D1 migration 066 seeds real templates; wipe so MAX(id) and the list
  // assertions see only this test's rows.
  await env.DB.exec(`DELETE FROM project_checklist_template_items`);
  await env.DB.exec(`DELETE FROM project_checklist_template_sections`);
  await env.DB.exec(`DELETE FROM project_checklist_templates`);

  for (const [tpl, co, label] of [
    [TPL_A, CO_A, "A"],
    [TPL_B, CO_B, "B"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO project_checklist_templates (id, name, description, active, company_id)
       VALUES (?, ?, ?, 1, ?)`,
    )
      .bind(tpl, `TEMPLATE ${label}`, `owned by ${label}`, co)
      .run();
    await env.DB.prepare(
      `INSERT INTO project_checklist_template_sections (id, template_id, name, sort_order, company_id)
       VALUES (?, ?, ?, 10, ?)`,
    )
      .bind(tpl + 100, tpl, `SECTION ${label}`, co)
      .run();
    await env.DB.prepare(
      `INSERT INTO project_checklist_template_items (id, template_id, section_id, seq, title, crew_visible, requires_review, company_id)
       VALUES (?, ?, ?, 10, ?, 0, 0, ?)`,
    )
      .bind(tpl + 200, tpl, tpl + 100, `TASK ${label}`, co)
      .run();
  }
});

const itemRow = (id: number) =>
  env.DB.prepare(
    `SELECT title, seq, template_id FROM project_checklist_template_items WHERE id = ?`,
  )
    .bind(id)
    .first<{ title: string; seq: number; template_id: number }>();

const sectionRow = (id: number) =>
  env.DB.prepare(
    `SELECT name, sort_order FROM project_checklist_template_sections WHERE id = ?`,
  )
    .bind(id)
    .first<{ name: string; sort_order: number }>();

const countItems = async (templateId: number) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_checklist_template_items WHERE template_id = ?`,
    )
      .bind(templateId)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("checklist templates are per-company — READS", () => {
  test("GET /checklist-templates lists only the active company's templates, and each company still sees its own", async () => {
    const a = await api("GET", "/checklist-templates", CO_A);
    expect(a.status).toBe(200);
    expect(a.json.data.map((t: any) => t.name)).toEqual(["TEMPLATE A"]);

    const b = await api("GET", "/checklist-templates", CO_B);
    expect(b.status).toBe(200);
    expect(b.json.data.map((t: any) => t.name)).toEqual(["TEMPLATE B"]);
  });

  test("GET /checklist-templates/:id/items refuses another company's template body but serves its own", async () => {
    const cross = await api("GET", `/checklist-templates/${TPL_B}/items`, CO_A);
    expect(cross.status).toBe(404);

    const own = await api("GET", `/checklist-templates/${TPL_A}/items`, CO_A);
    expect(own.status).toBe(200);
    expect(own.json.data.map((i: any) => i.title)).toEqual(["TASK A"]);
    expect(own.json.sections.map((s: any) => s.name)).toEqual(["SECTION A"]);

    // And B can still open its own body — the split must not blank B.
    const bOwn = await api("GET", `/checklist-templates/${TPL_B}/items`, CO_B);
    expect(bOwn.status).toBe(200);
    expect(bOwn.json.data.map((i: any) => i.title)).toEqual(["TASK B"]);
  });

  test("GET /sections-distinct resolves the newest active template WITHIN the company", async () => {
    // TPL_B has the higher id, so a company-blind MAX(t.id) hands A's filter row
    // B's stage names.
    const a = await api("GET", "/sections-distinct", CO_A);
    expect(a.status).toBe(200);
    expect(a.json.data).toEqual(["SECTION A"]);

    const b = await api("GET", "/sections-distinct", CO_B);
    expect(b.json.data).toEqual(["SECTION B"]);
  });

  test("GET /task-titles-distinct is scoped the same way", async () => {
    const a = await api("GET", "/task-titles-distinct", CO_A);
    expect(a.status).toBe(200);
    expect(a.json.data.map((d: any) => d.title)).toEqual(["TASK A"]);

    const b = await api("GET", "/task-titles-distinct", CO_B);
    expect(b.json.data.map((d: any) => d.title)).toEqual(["TASK B"]);
  });
});

describe("checklist templates are per-company — WRITES", () => {
  test("POST items refuses a cross-company parent (and writes nothing), still appends to its own", async () => {
    const before = await countItems(TPL_B);
    const cross = await api("POST", `/checklist-templates/${TPL_B}/items`, CO_A, {
      title: "INJECTED",
    });
    expect(cross.status).toBe(404);
    expect(await countItems(TPL_B)).toBe(before);

    const own = await api("POST", `/checklist-templates/${TPL_A}/items`, CO_A, {
      title: "LEGITIMATE",
    });
    expect(own.status).toBe(201);
    const stamped = await env.DB.prepare(
      `SELECT company_id FROM project_checklist_template_items WHERE title = 'LEGITIMATE'`,
    ).first<{ company_id: number }>();
    // The stamp records ownership; the 404 above is what enforces it.
    expect(stamped?.company_id).toBe(CO_A);
  });

  test("PATCH item by id cannot reach another company's row, and leaves it UNCHANGED", async () => {
    const cross = await api("PATCH", `/checklist-templates/items/${TPL_B + 200}`, CO_A, {
      title: "HIJACKED",
    });
    expect(cross.status).toBe(404);
    expect((await itemRow(TPL_B + 200))?.title).toBe("TASK B");

    const own = await api("PATCH", `/checklist-templates/items/${TPL_A + 200}`, CO_A, {
      title: "RENAMED BY OWNER",
    });
    expect(own.status).toBe(200);
    expect((await itemRow(TPL_A + 200))?.title).toBe("RENAMED BY OWNER");
  });

  test("DELETE item by id cannot reach another company's row, and leaves it PRESENT", async () => {
    const cross = await api("DELETE", `/checklist-templates/items/${TPL_B + 200}`, CO_A);
    expect(cross.status).toBe(404);
    expect(await itemRow(TPL_B + 200)).not.toBeNull();

    const own = await api("DELETE", `/checklist-templates/items/${TPL_A + 200}`, CO_A);
    expect(own.status).toBe(200);
    expect(await itemRow(TPL_A + 200)).toBeNull();
  });

  test("PATCH section by id cannot reach another company's row, and leaves it UNCHANGED", async () => {
    const cross = await api("PATCH", `/checklist-templates/sections/${TPL_B + 100}`, CO_A, {
      name: "HIJACKED",
    });
    expect(cross.status).toBe(404);
    expect((await sectionRow(TPL_B + 100))?.name).toBe("SECTION B");

    const own = await api("PATCH", `/checklist-templates/sections/${TPL_A + 100}`, CO_A, {
      name: "RENAMED BY OWNER",
    });
    expect(own.status).toBe(200);
    expect((await sectionRow(TPL_A + 100))?.name).toBe("RENAMED BY OWNER");
  });

  test("DELETE section by id cannot reach another company's row, and leaves it PRESENT", async () => {
    const cross = await api("DELETE", `/checklist-templates/sections/${TPL_B + 100}`, CO_A);
    expect(cross.status).toBe(404);
    expect(await sectionRow(TPL_B + 100)).not.toBeNull();

    const own = await api("DELETE", `/checklist-templates/sections/${TPL_A + 100}`, CO_A);
    expect(own.status).toBe(200);
    expect(await sectionRow(TPL_A + 100)).toBeNull();
  });

  test("POST sections refuses a cross-company parent, still appends to its own", async () => {
    const cross = await api("POST", `/checklist-templates/${TPL_B}/sections`, CO_A, {
      name: "INJECTED",
    });
    expect(cross.status).toBe(404);
    const leaked = await env.DB.prepare(
      `SELECT id FROM project_checklist_template_sections WHERE name = 'INJECTED'`,
    ).first();
    expect(leaked).toBeNull();

    const own = await api("POST", `/checklist-templates/${TPL_A}/sections`, CO_A, {
      name: "LEGITIMATE SECTION",
    });
    expect(own.status).toBe(201);
    const stamped = await env.DB.prepare(
      `SELECT company_id FROM project_checklist_template_sections WHERE name = 'LEGITIMATE SECTION'`,
    ).first<{ company_id: number }>();
    expect(stamped?.company_id).toBe(CO_A);
  });

  test("items reorder refuses a cross-company template and leaves the victim's seq alone", async () => {
    const cross = await api("PUT", `/checklist-templates/${TPL_B}/items/reorder`, CO_A, {
      ids: [TPL_B + 200],
    });
    expect(cross.status).toBe(404);
    expect((await itemRow(TPL_B + 200))?.seq).toBe(10);

    const own = await api("PUT", `/checklist-templates/${TPL_A}/items/reorder`, CO_A, {
      ids: [TPL_A + 200],
    });
    expect(own.status).toBe(200);
    expect((await itemRow(TPL_A + 200))?.seq).toBe(10);
  });

  test("sections reorder refuses a cross-company template and leaves the victim's sort_order alone", async () => {
    const cross = await api("PUT", `/checklist-templates/${TPL_B}/sections/reorder`, CO_A, {
      ids: [TPL_B + 100],
    });
    expect(cross.status).toBe(404);
    expect((await sectionRow(TPL_B + 100))?.sort_order).toBe(10);

    const own = await api("PUT", `/checklist-templates/${TPL_A}/sections/reorder`, CO_A, {
      ids: [TPL_A + 100],
    });
    expect(own.status).toBe(200);
  });
});

describe("unresolved company", () => {
  test("a create REFUSES in words rather than writing an unscoped row", async () => {
    const res = await api("POST", `/checklist-templates/${TPL_A}/items`, undefined, {
      title: "NO COMPANY",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("company_unresolved");
    // Refused in words, and nothing was written under the column DEFAULT.
    const written = await env.DB.prepare(
      `SELECT id FROM project_checklist_template_items WHERE title = 'NO COMPANY'`,
    ).first();
    expect(written).toBeNull();
  });

  test("a section create refuses the same way", async () => {
    const res = await api("POST", `/checklist-templates/${TPL_A}/sections`, undefined, {
      name: "NO COMPANY SECTION",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("company_unresolved");
  });
});
