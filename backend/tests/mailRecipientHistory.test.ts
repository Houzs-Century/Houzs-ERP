import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mailPersonal from '../src/routes/mail-personal';
import { rankRecipientHistory, type RecipientHistoryRow } from '../src/lib/mail-recipient-history';

const COMPANY_A = 1;
const COMPANY_B = 2;
const USER_ID = 7702;

function appFor(companyId: number | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: USER_ID, department_id: null, permissions: ['mail_center.read'], permissions_set: new Set(['mail_center.read']) } as never);
    c.set('userId' as never, USER_ID as never);
    c.set('companyId' as never, companyId as never);
    c.set('allowedCompanyIds' as never, (companyId == null ? [] : [companyId]) as never);
    await next();
  });
  app.route('/api/mail-center', mailPersonal);
  return app;
}

type History = { recipients: Array<{ email: string; name: string; timesUsed: number }> };

async function history(companyId: number | null): Promise<{ status: number; body: History }> {
  const res = await appFor(companyId).request('/api/mail-center/recipients/history', {}, env);
  return { status: res.status, body: (await res.json()) as History };
}

beforeAll(async () => {
  const schema = [
    `CREATE TABLE IF NOT EXISTS email_addresses (id TEXT PRIMARY KEY, address TEXT NOT NULL, label TEXT, assigned_user_id INTEGER, assigned_user_name TEXT, assigned_dept TEXT, assigned_position TEXT, department_id INTEGER, requested_department_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1, mail_host_status TEXT, mail_host_confirmed_at TEXT, mail_host_confirmed_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS email_address_access (id TEXT PRIMARY KEY, address_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT, created_by INTEGER, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS mail_user_scope (user_id INTEGER PRIMARY KEY, level TEXT NOT NULL DEFAULT 'personal', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS email_threads (id TEXT PRIMARY KEY, mailbox_address TEXT, subject TEXT, counterparty_email TEXT, counterparty_name TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to_user_id INTEGER, assigned_to_name TEXT, last_message_at TEXT, last_direction TEXT, last_snippet TEXT, message_count INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, labels TEXT, trashed_at TEXT, last_inbound_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, needs_ack INTEGER NOT NULL DEFAULT 0, ack_escalated_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1)`,
  ];
  for (const statement of schema) await env.DB.prepare(statement).run();
});

beforeEach(async () => {
  for (const table of ['email_messages', 'email_threads', 'email_addresses', 'mail_user_scope']) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.DB.prepare(`INSERT INTO mail_user_scope (user_id, level) VALUES (?, 'personal')`).bind(USER_ID).run();
  await env.DB.prepare(
    `INSERT INTO email_addresses (id, address, assigned_user_id, active, company_id)
     VALUES ('mine', 'Sim@houzs.test', ?, 1, ?), ('colleague', 'boss@houzs.test', 9999, 1, ?)`,
  ).bind(USER_ID, COMPANY_A, COMPANY_A).run();
  await env.DB.prepare(
    `INSERT INTO email_threads (id, mailbox_address, company_id)
     VALUES ('t-mine', 'sim@houzs.test', ?), ('t-colleague', 'boss@houzs.test', ?), ('t-other-co', 'sim@houzs.test', ?)`,
  ).bind(COMPANY_A, COMPANY_A, COMPANY_B).run();
  await env.DB.prepare(
    `INSERT INTO email_messages (id, thread_id, direction, from_address, from_name, to_addresses, cc_addresses, created_at, company_id) VALUES
       ('m1', 't-mine', 'outbound', 'sim@houzs.test', NULL, '["Hookka@supplier.test","siti@customer.test"]', '[]', '2026-11-01T00:00:00Z', ?),
       ('m2', 't-mine', 'outbound', 'sim@houzs.test', NULL, '["hookka@supplier.test"]', '["accounts@supplier.test"]', '2026-11-02T00:00:00Z', ?),
       ('m3', 't-mine', 'inbound', 'hookka@supplier.test', 'Hookka Industries', NULL, NULL, '2026-11-03T00:00:00Z', ?),
       ('m4', 't-colleague', 'outbound', 'boss@houzs.test', NULL, '["private@colleague.test"]', '[]', '2026-11-04T00:00:00Z', ?),
       ('m5', 't-other-co', 'outbound', 'sim@houzs.test', NULL, '["other@company-b.test"]', '[]', '2026-11-05T00:00:00Z', ?)`,
  ).bind(COMPANY_A, COMPANY_A, COMPANY_A, COMPANY_A, COMPANY_B).run();
});

describe('GET /recipients/history', () => {
  test('lists addresses the caller has written to or heard from, most used first', async () => {
    const { status, body } = await history(COMPANY_A);
    expect(status).toBe(200);
    expect(body.recipients.map((r) => r.email)).toEqual([
      'hookka@supplier.test',
      'accounts@supplier.test',
      'siti@customer.test',
    ]);
    expect(body.recipients[0]).toMatchObject({ name: 'Hookka Industries', timesUsed: 3 });
  });

  test('never shows a colleague\'s mailbox or another company\'s mail', async () => {
    const { body } = await history(COMPANY_A);
    const emails = body.recipients.map((r) => r.email);
    expect(emails).not.toContain('private@colleague.test');
    expect(emails).not.toContain('other@company-b.test');
  });

  test('refuses when the active company is unknown', async () => {
    const { status } = await history(null);
    expect(status).toBe(409);
  });
});

describe('rankRecipientHistory', () => {
  const row = (overrides: Partial<RecipientHistoryRow>): RecipientHistoryRow => ({
    direction: 'outbound', from_address: null, from_name: null, to_addresses: null, cc_addresses: null, used_at: null, ...overrides,
  });

  test('drops entries that are not an email address and unreadable lists', () => {
    const ranked = rankRecipientHistory([
      row({ to_addresses: '["siti","ok@a.test"," "]' }),
      row({ to_addresses: 'not json' }),
    ]);
    expect(ranked.map((r) => r.email)).toEqual(['ok@a.test']);
  });

  test('breaks a tie in use by the most recent', () => {
    const ranked = rankRecipientHistory([
      row({ to_addresses: '["older@a.test"]', used_at: '2026-01-01' }),
      row({ to_addresses: '["newer@a.test"]', used_at: '2026-02-01' }),
    ]);
    expect(ranked.map((r) => r.email)).toEqual(['newer@a.test', 'older@a.test']);
  });
});
