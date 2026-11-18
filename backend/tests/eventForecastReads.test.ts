/* The reads behind the three-layer Financial Snapshot (owner 2026-11-18;
 * services/eventForecastLoad.ts) against the D1 test mirror: the SQL narrows to
 * the same company, organiser and venue the way the venue join compares names
 * (trimmed, case-insensitive), takes only an EARLIER start, skips archived and
 * cancelled events, and a forecast is read through its project's company. */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { findLastEvent, readForecasts, readExpoMapFiles, hasExpoMapFiles } from "../src/services/eventForecastLoad";

/* The D1 mirror predates multi-company (mig-pg 0093): projects has no
   company_id there. Production's column is added for this file only. */
beforeAll(async () => {
  const cols = await env.DB.prepare(`PRAGMA table_info(projects)`).all<{ name: string }>();
  if (!cols.results.some((c) => c.name === "company_id")) {
    await env.DB.prepare(`ALTER TABLE projects ADD COLUMN company_id INTEGER`).run();
  }
});

const tag = Math.random().toString(36).slice(2, 8);
async function project(o: { company: number; organizer: string | null; venue: string | null; start: string | null; status?: string; archived?: boolean }): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO projects (code, name, stage, status, start_date, organizer, venue, company_id, archived_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
  ).bind(`FC-${tag}-${Math.random().toString(36).slice(2, 8)}`, "Fair", o.status ?? "pending", o.start, o.organizer, o.venue, o.company,
    o.archived ? "2026-01-01 00:00:00" : null).run();
  return r.meta.last_row_id as number;
}

describe("findLastEvent — the SQL narrowing", () => {
  test("same company, organiser and venue (trim / case), earlier start, not archived or cancelled; the latest wins", async () => {
    const org = `Org ${tag}`;
    const older = await project({ company: 1, organizer: org, venue: "MITEC", start: "2025-06-01" });
    const latest = await project({ company: 1, organizer: ` ${org.toUpperCase()} `, venue: "mitec ", start: "2026-06-01" });
    await project({ company: 1, organizer: org, venue: "MITEC", start: "2026-08-01", archived: true });
    await project({ company: 1, organizer: org, venue: "MITEC", start: "2026-09-01", status: "cancelled" });
    await project({ company: 2, organizer: org, venue: "MITEC", start: "2026-10-01" });
    await project({ company: 1, organizer: org, venue: "KLCC", start: "2026-10-01" });
    await project({ company: 1, organizer: org, venue: "MITEC", start: "2027-02-01" });
    const cur = await project({ company: 1, organizer: org, venue: "MITEC", start: "2026-12-05" });

    const got = await findLastEvent(env.DB, { id: cur, company_id: 1, organizer: org, venue: "MITEC", start_date: "2026-12-05" });
    expect(got?.id).toBe(latest);
    expect(got?.id).not.toBe(older);
  });

  test("none found: no earlier same-organiser-same-venue event, or no organiser", async () => {
    const org = `Lonely ${tag}`;
    const cur = await project({ company: 1, organizer: org, venue: "SPICE", start: "2026-12-05" });
    await project({ company: 1, organizer: "Someone else", venue: "SPICE", start: "2026-01-05" });
    expect(await findLastEvent(env.DB, { id: cur, company_id: 1, organizer: org, venue: "SPICE", start_date: "2026-12-05" })).toBeNull();
    expect(await findLastEvent(env.DB, { id: cur, company_id: 1, organizer: null, venue: "SPICE", start_date: "2026-12-05" })).toBeNull();
  });
});

describe("readForecasts — through the project's company", () => {
  test("reads RM per line for this company's events only; ignores an unknown line key", async () => {
    const mine = await project({ company: 1, organizer: "A", venue: "B", start: "2026-12-01" });
    const theirs = await project({ company: 2, organizer: "A", venue: "B", start: "2026-12-01" });
    await env.DB.prepare(
      `INSERT INTO project_forecast (company_id, project_id, line_key, amount_sen) VALUES (1, ?, 'sales', 9000000), (1, ?, 'rental', 1250050), (1, ?, 'bogus', 1), (2, ?, 'sales', 100)`,
    ).bind(mine, mine, mine, theirs).run();
    const m = await readForecasts(env.DB, [mine, theirs], 1);
    expect(m.get(mine)).toEqual({ sales: 90000, rental: 12500.5 });
    expect(m.has(theirs)).toBe(false);
    expect((await readForecasts(env.DB, [mine], null)).size).toBe(0);
  });
});

describe("the Expo Map reference", () => {
  test("reads the last event's Blank / Filled Floorplan files; an event with its own files needs none", async () => {
    const last = await project({ company: 1, organizer: "X", venue: "Y", start: "2026-01-01" });
    const sec = await env.DB.prepare(`INSERT INTO project_checklist_sections (project_id, name, sort_order) VALUES (?, 'EXPO MAP — COMPETITOR RESEARCH', 70)`).bind(last).run();
    const sectionId = sec.meta.last_row_id as number;
    const blank = await env.DB.prepare(`INSERT INTO project_checklist (project_id, seq, title, status, section_id) VALUES (?, 190, 'Blank Floorplan', 'done', ?)`).bind(last, sectionId).run();
    const other = await env.DB.prepare(`INSERT INTO project_checklist (project_id, seq, title, status) VALUES (?, 10, 'Contract', 'done')`).bind(last).run();
    await env.DB.prepare(`INSERT INTO project_checklist_attachments (item_id, r2_key, file_name) VALUES (?, 'task-attach/1/blank.pdf', 'blank.pdf'), (?, 'task-attach/2/contract.pdf', 'contract.pdf')`)
      .bind(blank.meta.last_row_id, other.meta.last_row_id).run();
    const files = await readExpoMapFiles(env.DB, last);
    expect(files.map((f) => [f.item_title, f.file_name])).toEqual([["Blank Floorplan", "blank.pdf"]]);

    expect(hasExpoMapFiles([{ id: 5, title: "Filled Floorplan", section_id: null }], [], [{ item_id: 5 }])).toBe(true);
    expect(hasExpoMapFiles([{ id: 5, title: "Filled Floorplan", section_id: null }], [], [])).toBe(false);
    expect(hasExpoMapFiles([{ id: 6, title: "Contract", section_id: null }], [], [{ item_id: 6 }])).toBe(false);
  });
});
