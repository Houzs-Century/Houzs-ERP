// Regression (2026-10-26): a non-HOUZS project's cloned checklist rows and
// sections must carry the PROJECT's company_id, not the HOUZS column DEFAULT.
// The upload / review gate scopes project_checklist on its OWN company_id
// (project-company-gate.ts shape "own", mig 0093). When the clone left children
// on the default, every upload to a company-2 project (2990's Home) 404'd with
// "We couldn't find what you were looking for" — the floorplan-upload bug.
//
// Harness mirrors projectChecklistTemplateCompanyScope.test.ts: the D1 mirror
// predates mig 0093, so the company_id columns are added at runtime; the pg tree
// has carried them since 0093.
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Env } from "../src/types";
import { instantiateChecklistFromEventType } from "../src/services/projects";

const CO_2990 = 2; // non-HOUZS; HOUZS (1) is the column DEFAULT

const TPL = 7701;
const EVENT_TYPE = 7702;
const PROJECT = 7703; // stamped run
const PROJECT_UNSTAMPED = 7704; // control: no company resolved

async function addCompanyIdColumn(table: string) {
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN company_id INTEGER`).run();
  } catch {
    // Already present on a warm isolate.
  }
}

beforeAll(async () => {
  for (const t of ["project_checklist", "project_checklist_sections"]) {
    await addCompanyIdColumn(t);
  }
});

beforeEach(async () => {
  for (const id of [PROJECT, PROJECT_UNSTAMPED]) {
    await env.DB.prepare(`DELETE FROM project_checklist WHERE project_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM project_checklist_sections WHERE project_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run();
    await env.DB.prepare(`INSERT INTO projects (id, name) VALUES (?, 'company-stamp test')`).bind(id).run();
  }
  await env.DB.prepare(`DELETE FROM project_checklist_template_items WHERE template_id = ?`).bind(TPL).run();
  await env.DB.prepare(`DELETE FROM project_checklist_template_sections WHERE template_id = ?`).bind(TPL).run();
  await env.DB.prepare(`DELETE FROM project_checklist_templates WHERE id = ?`).bind(TPL).run();
  await env.DB.prepare(`DELETE FROM project_event_types WHERE id = ?`).bind(EVENT_TYPE).run();

  await env.DB.prepare(
    `INSERT INTO project_checklist_templates (id, name, description, active) VALUES (?, 'T', 't', 1)`,
  ).bind(TPL).run();
  await env.DB.prepare(
    `INSERT INTO project_checklist_template_sections (id, template_id, name, sort_order) VALUES (?, ?, 'EXPO MAP', 10)`,
  ).bind(TPL + 10, TPL).run();
  await env.DB.prepare(
    `INSERT INTO project_checklist_template_items (id, template_id, section_id, seq, title, crew_visible, requires_review)
     VALUES (?, ?, ?, 10, 'Blank Floorplan', 0, 0)`,
  ).bind(TPL + 20, TPL, TPL + 10).run();
  await env.DB.prepare(
    `INSERT INTO project_event_types (id, slug, name, default_template_id) VALUES (?, 'et-cstamp', 'ET', ?)`,
  ).bind(EVENT_TYPE, TPL).run();
});

describe("instantiateChecklistFromEventType company stamping", () => {
  test("a company-2 project's cloned tasks and sections carry company 2, not the HOUZS default", async () => {
    await instantiateChecklistFromEventType(env as unknown as Env, PROJECT, EVENT_TYPE, null, CO_2990);

    const tasks = await env.DB.prepare(
      `SELECT company_id FROM project_checklist WHERE project_id = ?`,
    ).bind(PROJECT).all<{ company_id: number }>();
    expect(tasks.results.length).toBeGreaterThan(0);
    for (const r of tasks.results) expect(r.company_id).toBe(CO_2990);

    const sections = await env.DB.prepare(
      `SELECT company_id FROM project_checklist_sections WHERE project_id = ?`,
    ).bind(PROJECT).all<{ company_id: number }>();
    expect(sections.results.length).toBeGreaterThan(0);
    for (const r of sections.results) expect(r.company_id).toBe(CO_2990);
  });

  test("with no company resolved the clone omits the stamp (single-company / D1 path unchanged)", async () => {
    await instantiateChecklistFromEventType(env as unknown as Env, PROJECT_UNSTAMPED, EVENT_TYPE, null, null);

    const tasks = await env.DB.prepare(
      `SELECT company_id FROM project_checklist WHERE project_id = ?`,
    ).bind(PROJECT_UNSTAMPED).all<{ company_id: number | null }>();
    expect(tasks.results.length).toBeGreaterThan(0);
    for (const r of tasks.results) expect(r.company_id).toBeNull();
  });
});
