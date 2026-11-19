import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { deliveryStatus, refreshOutboundDelivery } from '../src/lib/mail-delivery';
import type { Env } from '../src/types';

const liveEnv = { ...env, RESEND_API_KEY: 're_test_key' } as unknown as Env;
const NOW = Date.parse('2026-11-19T10:00:00Z');
const SENDER_ID = 7703;
let lastEventByProviderId: Record<string, string | null> = {};

beforeAll(async () => {
  const schema = [
    `CREATE TABLE IF NOT EXISTS email_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, in_reply_to TEXT, reference_ids TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, text_body TEXT, html_body TEXT, sent_at TEXT, received_at TEXT, sent_by_user_id INTEGER, sent_by_name TEXT, provider_message_id TEXT, outbox_id TEXT, needs_ack INTEGER NOT NULL DEFAULT 0, ack_escalated_at TEXT, created_at TEXT, company_id INTEGER NOT NULL DEFAULT 1, delivery_status TEXT, delivery_status_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT, body TEXT, is_active INTEGER, expires_at TEXT, created_by INTEGER, created_at TEXT, translations TEXT, attachments TEXT, target_type TEXT, target_dept_ids TEXT, target_position_ids TEXT, target_user_ids TEXT, category TEXT, source TEXT)`,
    `CREATE TABLE IF NOT EXISTS announcement_acks (announcement_id TEXT NOT NULL, user_id INTEGER NOT NULL, acked_at TEXT, company_id INTEGER, PRIMARY KEY (announcement_id, user_id))`,
  ];
  for (const statement of schema) await env.DB.prepare(statement).run();
  try { await env.DB.prepare('ALTER TABLE email_messages ADD COLUMN delivery_status TEXT').run(); } catch { /* already there */ }
  try { await env.DB.prepare('ALTER TABLE email_messages ADD COLUMN delivery_status_at TEXT').run(); } catch { /* already there */ }
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM email_messages`);
  await env.DB.exec(`DELETE FROM announcements WHERE source = 'mail_bounce'`);
  const message = (id: string, providerId: string | null, createdAt: string, status: string | null) =>
    env.DB.prepare(
      `INSERT INTO email_messages (id, thread_id, direction, subject, to_addresses, sent_by_user_id, provider_message_id, created_at, delivery_status)
       VALUES (?, 't1', 'outbound', 'Order HC 8568', '["siti@gmial.test"]', ?, ?, ?, ?)`,
    ).bind(id, SENDER_ID, providerId, createdAt, status).run();
  await message('m-bounce', 're-bounce', '2026-11-19T09:00:00Z', null);
  await message('m-delivered', 're-ok', '2026-11-19T09:01:00Z', 'sent');
  await message('m-final', 're-final', '2026-11-19T09:02:00Z', 'opened');
  await message('m-old', 're-old', '2026-11-10T09:00:00Z', null);
  await message('m-unsent', null, '2026-11-19T09:03:00Z', null);
  lastEventByProviderId = { 're-bounce': 'bounced', 're-ok': 'delivered', 're-final': 'opened', 're-old': 'delivered' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new Request(input).url;
    const providerId = decodeURIComponent(url.split('/emails/')[1] ?? '');
    if (!(providerId in lastEventByProviderId)) throw new Error(`Unexpected outbound fetch: ${url}`);
    return Response.json({ message_id: `<${providerId}@resend.test>`, last_event: lastEventByProviderId[providerId] });
  });
});

afterEach(() => vi.restoreAllMocks());

async function statusOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT delivery_status FROM email_messages WHERE id = ?`).bind(id).first<{ delivery_status: string | null }>();
  return row?.delivery_status ?? null;
}

async function bounceNotices(): Promise<Array<{ title: string; target_user_ids: string }>> {
  const rows = await env.DB.prepare(`SELECT title, target_user_ids FROM announcements WHERE source = 'mail_bounce'`).all<{ title: string; target_user_ids: string }>();
  return rows.results;
}

describe('refreshOutboundDelivery', () => {
  test('stores what Resend says, and tells the sender once when a mail bounced', async () => {
    const run = await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW);
    expect(run).toEqual({ checked: 2, changed: 2, bounced: 1, unreachable: 0 });
    expect(await statusOf('m-bounce')).toBe('bounced');
    expect(await statusOf('m-delivered')).toBe('delivered');
    expect(await bounceNotices()).toEqual([{ title: 'Email bounced: Order HC 8568', target_user_ids: `[${SENDER_ID}]` }]);

    const again = await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW);
    expect(again.checked).toBe(1);
    expect(await bounceNotices()).toHaveLength(1);
  });

  test('skips final, too old and never-sent messages', async () => {
    await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW);
    expect(await statusOf('m-old')).toBeNull();
    expect(await statusOf('m-unsent')).toBeNull();
  });

  test('keeps asking about a delivered mail until it is opened', async () => {
    await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW);
    expect(await statusOf('m-delivered')).toBe('delivered');
    lastEventByProviderId['re-ok'] = 'opened';
    await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW + 300_000);
    expect(await statusOf('m-delivered')).toBe('opened');
    const after = await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW + 600_000);
    expect(after.checked).toBe(0);
  });

  test('asks the never-asked mail first, then the one asked longest ago', async () => {
    await env.DB.prepare(`UPDATE email_messages SET delivery_status_at = '2026-11-19T09:30:00Z' WHERE id = 'm-delivered'`).run();
    await refreshOutboundDelivery(env.DB, liveEnv, 1, NOW);
    expect(await statusOf('m-bounce')).toBe('bounced');
    expect(await statusOf('m-delivered')).toBe('sent');
    await refreshOutboundDelivery(env.DB, liveEnv, 1, NOW + 300_000);
    expect(await statusOf('m-delivered')).toBe('delivered');
  });

  test('leaves a message to the next run when Resend cannot answer', async () => {
    lastEventByProviderId['re-bounce'] = null;
    const run = await refreshOutboundDelivery(env.DB, liveEnv, 20, NOW);
    expect(run.unreachable).toBe(1);
    expect(await statusOf('m-bounce')).toBeNull();
    expect(await bounceNotices()).toEqual([]);
  });
});

describe('deliveryStatus', () => {
  test('the outbox wins while it still owns the send', () => {
    expect(deliveryStatus('pending', 'bounced')).toBe('queued');
    expect(deliveryStatus('failed', null)).toBe('failed');
  });

  test('maps Resend events to what the thread shows', () => {
    expect(deliveryStatus('sent', 'bounced')).toBe('bounced');
    expect(deliveryStatus(null, 'delivered')).toBe('delivered');
    expect(deliveryStatus(null, 'opened')).toBe('opened');
    expect(deliveryStatus(null, 'clicked')).toBe('opened');
    expect(deliveryStatus(null, 'complained')).toBe('delivered');
    expect(deliveryStatus(null, 'canceled')).toBe('failed');
    expect(deliveryStatus(null, 'delivery_delayed')).toBeNull();
    expect(deliveryStatus(null, null)).toBeNull();
  });
});
