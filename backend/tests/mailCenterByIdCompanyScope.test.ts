/* Mail Center by id, across companies.
 *
 * Company A's session asking for company B's thread, attachment or thread
 * update by id gets 404 and no data. The thread's MESSAGES are now read under
 * the active company too (they were keyed on thread_id alone), so a message
 * stamped to another company never renders inside this company's thread.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mailCenter from '../src/routes/mail-center';

const CO_A = 1;
const CO_B = 2;
const USER_ID = 7701;

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user' as never, { id: USER_ID, department_id: null, permissions: ['*'], permissions_set: new Set(['*']) } as never);
  c.set('userId' as never, USER_ID as never);
  c.set('companyId' as never, CO_A as never);
  c.set('allowedCompanyIds' as never, [CO_A] as never);
  await next();
});
app.route('/api/mail-center', mailCenter);

const req = (method: string, path: string, body?: unknown) =>
  app.request(`/api/mail-center${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);

beforeAll(async () => {
  const schema = [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, requested_department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, last_inbound_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, needs_ack INTEGER NOT NULL DEFAULT 0, ack_escalated_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_thread_reads (thread_id TEXT NOT NULL, user_id INTEGER NOT NULL, read_at TEXT, PRIMARY KEY (thread_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_message_acks (message_id TEXT NOT NULL, user_id INTEGER NOT NULL, requested_at TEXT NOT NULL, acked_at TEXT, PRIMARY KEY (message_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS email_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT, content_type TEXT, size_bytes INTEGER, storage_path TEXT, content_id TEXT, created_at TEXT)`,
  ];
  for (const s of schema) await env.DB.prepare(s).run();
});

beforeEach(async () => {
  for (const t of ['email_attachments', 'email_messages', 'email_threads', 'email_addresses', 'mail_user_scope']) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await env.DB.prepare(`INSERT INTO mail_user_scope (user_id, level) VALUES (?, 'company')`).bind(USER_ID).run();
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, active, company_id) VALUES ('addr-a', 'sales@a.test', 1, ?), ('addr-b', 'sales@b.test', 1, ?)`,
  ).bind(CO_A, CO_B).run();
  await env.DB.prepare(
    `INSERT INTO email_threads (id, mailbox_address, subject, starred, company_id)
     VALUES ('t-a', 'sales@a.test', 'OWN THREAD', 0, ?), ('t-b', 'sales@b.test', 'OTHER COMPANY THREAD', 0, ?)`,
  ).bind(CO_A, CO_B).run();
  await env.DB.prepare(
    `INSERT INTO email_messages (id, thread_id, direction, subject, text_body, created_at, company_id)
     VALUES ('m-a', 't-a', 'inbound', 'OWN THREAD', 'own body', '2026-11-01T00:00:00Z', ?),
            ('m-stray', 't-a', 'inbound', 'stray', 'OTHER COMPANY BODY', '2026-11-01T00:01:00Z', ?),
            ('m-b', 't-b', 'inbound', 'OTHER COMPANY THREAD', 'OTHER COMPANY BODY', '2026-11-01T00:00:00Z', ?)`,
  ).bind(CO_A, CO_B, CO_B).run();
  await env.DB.prepare(
    `INSERT INTO email_attachments (id, message_id, filename, storage_path) VALUES ('att-b', 'm-b', 'other-company.pdf', 'mail/other-company.pdf')`,
  ).run();
});

describe('company A asking for company B\'s mail by id', () => {
  test('GET /threads/:id answers 404 with no data', async () => {
    const res = await req('GET', '/threads/t-b');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('OTHER COMPANY');
  });

  test('GET /attachments/:id answers 404', async () => {
    const res = await req('GET', '/attachments/att-b');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('other-company.pdf');
  });

  test('PATCH /threads/:id answers 404 and changes nothing', async () => {
    const res = await req('PATCH', '/threads/t-b', { starred: true });
    expect(res.status).toBe(404);
    const row = await env.DB.prepare(`SELECT starred FROM email_threads WHERE id = 't-b'`).first<{ starred: number }>();
    expect(Number(row?.starred)).toBe(0);
  });
});

describe('its own thread', () => {
  test('opens, and shows only this company\'s messages', async () => {
    const res = await req('GET', '/threads/t-a');
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ id: string }> };
    expect(body.messages.map((m) => m.id)).toEqual(['m-a']);
  });

  test('PATCH still updates it', async () => {
    const res = await req('PATCH', '/threads/t-a', { starred: true });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT starred FROM email_threads WHERE id = 't-a'`).first<{ starred: number }>();
    expect(Number(row?.starred)).toBe(1);
  });
});
