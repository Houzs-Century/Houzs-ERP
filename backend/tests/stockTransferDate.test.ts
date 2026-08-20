/* A stock transfer filed with no date must still reach the schedule.
 *
 * Every transfer auto-creates a mirrored project_checklist row
 * (services/projects.ts syncStockTransferTask). Its TITLE and its due_date
 * both come from the same field, `transferred_at`. When that field arrives
 * empty the mirror row was created with `due_date NULL` and the bare title
 * "Stock OUT" — invisible to the tasklist's date column, the Gantt and every
 * due-date rollup, and PERMANENTLY so: the project-schedule redate pass
 * (services/projects.ts, redateChecklistFromOffsets) deliberately skips
 * `notes LIKE 'auto:%'` mirror rows because their date is supposed to follow
 * the transfer.
 *
 * Reachable from the DESKTOP form, which is the surface that sends the field:
 * `transferredAt` starts as '' and nothing requires it, AND
 * joinDateTimeLocal() emits '' for a half-filled control — so picking a date
 * and leaving the time blank sends nothing while the date stays on screen.
 *
 * The rule here is the owner's standing one for this system: DEFAULT, never
 * refuse. A missing date becomes today rather than a validation wall.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";

let adminBearer: string;

async function seedAdmin(): Promise<string> {
  const roleRes = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, 0)`,
  )
    .bind(`bd role_${Math.random().toString(36).slice(2)}`, "test role", JSON.stringify(["*"]))
    .run();
  const roleId = roleRes.meta.last_row_id as number;
  const userRes = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'admin', ?, 'active', datetime('now'))`,
  )
    .bind(`st-admin-${roleId}@test.local`, roleId)
    .run();
  const userId = userRes.meta.last_row_id as number;
  const token = `st-token-${userId}-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, new Date(Date.now() + 3600_000).toISOString())
    .run();
  return `Bearer ${token}`;
}

async function api(method: string, path: string, bearer: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { Authorization: bearer, "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await SELF.fetch(`https://test.local${path}`, init);
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM project_checklist`);
  await env.DB.exec(`DELETE FROM project_stock_transfers`);
  await env.DB.exec(`DELETE FROM project_activity`);
  await env.DB.exec(`DELETE FROM project_finance`);
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  adminBearer = await seedAdmin();
});

async function newProject(): Promise<number> {
  const res = await api("POST", "/api/projects", adminBearer, {
    name: "Transfer date project",
    brand: "AKEMI",
    state: "SELANGOR",
    venue: "TEST VENUE",
    organizer: "TEST ORG",
  });
  expect(res.status).toBe(201);
  return res.json.id as number;
}

/** The auto-created mirror row for a transfer, found by its notes marker. */
async function mirrorTask(transferId: number) {
  return env.DB.prepare(
    `SELECT title, due_date FROM project_checklist WHERE notes = ?`,
  )
    .bind(`auto:stock_transfer=${transferId}`)
    .first<{ title: string; due_date: string | null }>();
}

describe("stock transfer filed with no date", () => {
  test("the transfer stores today rather than NULL", async () => {
    const projectId = await newProject();
    const res = await api("POST", `/api/projects/${projectId}/stock-transfers`, adminBearer, {
      direction: "out",
    });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      `SELECT transferred_at FROM project_stock_transfers WHERE id = ?`,
    )
      .bind(res.json.id)
      .first<{ transferred_at: string | null }>();

    expect(row!.transferred_at).not.toBeNull();
    expect(row!.transferred_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  test("its mirrored checklist row carries a due_date, so the schedule can see it", async () => {
    const projectId = await newProject();
    const res = await api("POST", `/api/projects/${projectId}/stock-transfers`, adminBearer, {
      direction: "out",
    });
    expect(res.status).toBe(201);

    const task = await mirrorTask(res.json.id);
    expect(task).toBeTruthy();
    // The defect: due_date NULL, and permanently so.
    expect(task!.due_date).not.toBeNull();
    expect(task!.due_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  test("its title names the date instead of the bare direction", async () => {
    const projectId = await newProject();
    const res = await api("POST", `/api/projects/${projectId}/stock-transfers`, adminBearer, {
      direction: "out",
    });
    expect(res.status).toBe(201);

    const task = await mirrorTask(res.json.id);
    // The defect: the title was exactly "Stock OUT", naming no date at all.
    expect(task!.title).not.toBe("Stock OUT");
    expect(task!.title).toMatch(/^Stock OUT — \d{4}-\d{2}-\d{2}/);
  });

  test("a date that WAS supplied is kept exactly, never replaced by today", async () => {
    const projectId = await newProject();
    const res = await api("POST", `/api/projects/${projectId}/stock-transfers`, adminBearer, {
      direction: "return",
      transferred_at: "2026-01-09T08:15",
    });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      `SELECT transferred_at FROM project_stock_transfers WHERE id = ?`,
    )
      .bind(res.json.id)
      .first<{ transferred_at: string | null }>();
    expect(row!.transferred_at).toBe("2026-01-09T08:15");

    const task = await mirrorTask(res.json.id);
    expect(task!.title).toBe("Stock RETURN — 2026-01-09T08:15");
    expect(task!.due_date).toBe("2026-01-09T08:15");
  });
});
