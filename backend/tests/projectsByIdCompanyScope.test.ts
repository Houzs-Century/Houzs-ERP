/* Projects by id, across companies (raw-SQL master reads, statement level).
 *
 * Company A's session asking for company B's project, checklist task, section
 * or task attachment by id gets 404 and changes nothing. The payment route had
 * no company predicate at all before this: it read the prior status and set a
 * new one on any project id. The checklist/section statements now carry
 * activeCompanySql themselves instead of relying only on refuseForeignChild.
 *
 * Also pinned: a section created under the active company is STAMPED with it,
 * so the section's own-company gate admits it afterwards (an unstamped insert
 * fell to the column default, HOUZS).
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import projectRoutes from '../src/routes/projects';

const CO_A = 1;
const CO_B = 2;

const state = { company: CO_A as number };

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user' as never, { id: 909, department_id: null, position_id: null, permissions: ['*'], permissions_set: new Set(['*']) } as never);
  c.set('companyId' as never, state.company as never);
  c.set('allowedCompanyIds' as never, [state.company] as never);
  await next();
});
app.route('/api/projects', projectRoutes);

async function api(method: string, path: string, company: number, body?: unknown) {
  state.company = company;
  const res = await app.request(`/api/projects${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  return { status: res.status, text: await res.text() };
}

async function addCompanyColumn(table: string) {
  try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN company_id INTEGER`).run(); } catch { /* already there */ }
}

beforeAll(async () => {
  for (const t of ['projects', 'project_checklist', 'project_checklist_sections', 'project_checklist_attachments']) {
    await addCompanyColumn(t);
  }
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM project_checklist_attachments');
  await env.DB.exec('DELETE FROM project_checklist');
  await env.DB.exec('DELETE FROM project_checklist_sections');
  await env.DB.exec('DELETE FROM projects');
  for (const [id, co, label] of [[5001, CO_A, 'A'], [5002, CO_B, 'B']] as const) {
    await env.DB.prepare(
      `INSERT INTO projects (id, code, name, payment_status, company_id) VALUES (?, ?, ?, 'not_started', ?)`,
    ).bind(id, `P-${label}`, `PROJECT ${label}`, co).run();
    await env.DB.prepare(
      `INSERT INTO project_checklist_sections (id, project_id, name, sort_order, company_id) VALUES (?, ?, ?, 10, ?)`,
    ).bind(id + 100, id, `SECTION ${label}`, co).run();
    await env.DB.prepare(
      `INSERT INTO project_checklist (id, project_id, seq, title, status, section_id, company_id) VALUES (?, ?, 10, ?, 'pending', ?, ?)`,
    ).bind(id + 200, id, `TASK ${label}`, id + 100, co).run();
    await env.DB.prepare(
      `INSERT INTO project_checklist_attachments (id, item_id, r2_key, file_name, company_id) VALUES (?, ?, ?, ?, ?)`,
    ).bind(id + 300, id + 200, `task-attach/${label}.pdf`, `FILE ${label}.pdf`, co).run();
  }
});

describe('company A asking for company B\'s rows by id gets 404 and no change', () => {
  test('payment status on B\'s project', async () => {
    const r = await api('POST', '/5002/payment', CO_A, { status: 'paid' });
    expect(r.status).toBe(404);
    const row = await env.DB.prepare('SELECT payment_status FROM projects WHERE id = 5002').first<{ payment_status: string }>();
    expect(row?.payment_status).toBe('not_started');
  });

  test('rename B\'s section', async () => {
    const r = await api('PATCH', '/sections/5102', CO_A, { name: 'HIJACKED' });
    expect(r.status).toBe(404);
    const row = await env.DB.prepare('SELECT name FROM project_checklist_sections WHERE id = 5102').first<{ name: string }>();
    expect(row?.name).toBe('SECTION B');
  });

  test('delete B\'s section', async () => {
    const r = await api('DELETE', '/sections/5102', CO_A);
    expect(r.status).toBe(404);
    const row = await env.DB.prepare('SELECT id FROM project_checklist_sections WHERE id = 5102').first();
    expect(row).not.toBeNull();
    const task = await env.DB.prepare('SELECT section_id FROM project_checklist WHERE id = 5202').first<{ section_id: number }>();
    expect(task?.section_id).toBe(5102);
  });

  test('tick B\'s checklist task', async () => {
    const r = await api('POST', '/checklist/5202/status', CO_A, { status: 'done' });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('TASK B');
    const row = await env.DB.prepare('SELECT status FROM project_checklist WHERE id = 5202').first<{ status: string }>();
    expect(row?.status).toBe('pending');
  });

  test('archive B\'s task attachment', async () => {
    const r = await api('DELETE', '/checklist/attachments/5302', CO_A);
    expect(r.status).toBe(404);
    const row = await env.DB.prepare('SELECT archived_at FROM project_checklist_attachments WHERE id = 5302').first<{ archived_at: string | null }>();
    expect(row?.archived_at).toBeNull();
  });
});

describe('the same company still works', () => {
  test('rename its own section', async () => {
    const r = await api('PATCH', '/sections/5101', CO_A, { name: 'RENAMED' });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare('SELECT name FROM project_checklist_sections WHERE id = 5101').first<{ name: string }>();
    expect(row?.name).toBe('RENAMED');
  });

  test('company B deletes its own section and the task falls back to uncategorised', async () => {
    const r = await api('DELETE', '/sections/5102', CO_B);
    expect(r.status).toBe(200);
    const task = await env.DB.prepare('SELECT section_id FROM project_checklist WHERE id = 5202').first<{ section_id: number | null }>();
    expect(task?.section_id).toBeNull();
  });

  test('a new section is stamped with the active company and is then editable by it', async () => {
    const created = await api('POST', '/5002/sections', CO_B, { name: 'NEW B' });
    expect(created.status).toBe(201);
    const id = (JSON.parse(created.text) as { id: number }).id;
    const row = await env.DB.prepare('SELECT company_id FROM project_checklist_sections WHERE id = ?').bind(id).first<{ company_id: number }>();
    expect(Number(row?.company_id)).toBe(CO_B);
    expect((await api('PATCH', `/sections/${id}`, CO_B, { name: 'NEW B2' })).status).toBe(200);
  });
});
