// Remind approver through the ROUTE (the redesign's e8; owner 2026-11-03:
// 「主要是付款吧」 — payment vouchers only). What a pure table cannot prove:
//   · the note lands in the approvers' bell (the announcements system slice,
//     through the real postPersonalNotice), worded "<sender> asks you to
//     approve <no> · <payee> · RM x", tagged so the bell opens the voucher;
//   · several vouchers make ONE note, never a card per voucher per person;
//   · nothing on the voucher changes, and the trail records who reminded;
//   · one reminder per voucher an hour, read off that trail;
//   · a voucher that is not checked, or is another company's, is refused;
//   · the approver is whoever holds the approve key by role, else whoever may
//     approve (the To do's rule), never the sender.
//
// Bare Hono + a fake PostgREST for the scm side and a fake D1 for the public
// side, the pvApproval.test.ts shape. NO vi.mock.

import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { remindApproverHandler, remindNotice, REMIND_EVERY_MS } from '../src/scm/routes/payment-vouchers-remind';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' = 'select';
  private inserted: Row[] = [];
  private window: [number, number] | null = null;
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  gte(col: string, val: unknown) { this.preds.push((r) => String(r[col]) >= String(val)); return this; }
  range(from: number, to: number) { this.window = [from, to]; return this; }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: `${this.table}-${this.rows.length + i + 1}`, created_at: new Date().toISOString(), ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return this.window ? hit.slice(this.window[0], this.window[1] + 1) : hit;
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: this.run(), error: null }); }
  async maybeSingle() { const hit = this.run(); return { data: hit[0] ?? null, error: null }; }
}

const checked = (id: string, no: string, extra: Row = {}): Row => ({
  id, pv_number: no, company_id: CO, status: 'DRAFT', voucher_date: '2026-10-28', payee_name: 'Freight Co',
  notes: 'October haulage.', currency: 'MYR', exchange_rate: 1, total_sen: 50_000,
  submitted_at: '2026-10-28T01:00:00Z', checked_at: '2026-10-29T02:00:00Z', checked_by: 'Siti', approved_at: null, ...extra,
});

/* Roles: 20 Finance (prepare + check), 21 Approver (the key by name), 22 Super Admin ('*').
   Users: 30 the checker, 31 the approver (both companies), 32 an approver of 2990 only,
   33 a super admin, 34 a disabled approver. */
let ROLES: Row[];
const USERS = [
  { id: 30, role_id: 20, status: 'active' },
  { id: 31, role_id: 21, status: 'active' },
  { id: 32, role_id: 21, status: 'active' },
  { id: 33, role_id: 22, status: 'active' },
  { id: 34, role_id: 21, status: 'disabled' },
];
const GRANTS = [
  { user_id: 30, company_id: 1 }, { user_id: 31, company_id: 1 }, { user_id: 31, company_id: 2 },
  { user_id: 32, company_id: 2 }, { user_id: 33, company_id: 1 }, { user_id: 33, company_id: 2 },
];

type Notice = { id: string; title: string; body: string; targets: number[]; category: string; source: string };
let tables: Record<string, Row[]>;
let notices: Notice[];

function fakeEnv() {
  const all = (sql: string, args: unknown[]) => {
    if (/FROM roles/.test(sql)) return { results: ROLES };
    if (/FROM users/.test(sql)) return { results: USERS.filter((u) => u.status === 'active' && args.map(Number).includes(u.role_id)) };
    if (/FROM user_companies/.test(sql)) return { results: GRANTS.filter((g) => args.map(Number).includes(g.user_id)) };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...a: unknown[]) => { args = a; return stmt; },
          all: async () => all(sql, args),
          /* postPersonalNotice's double-post probe: an identical, still-unread note. */
          first: async () => {
            const [source, title, targets] = args as [string, string, string];
            const hit = notices.find((n) => n.source === source && n.title === title && JSON.stringify(n.targets) === targets);
            return hit ? { id: hit.id } : null;
          },
          run: async () => {
            if (!/INSERT INTO announcements/.test(sql)) throw new Error(`unexpected write: ${sql}`);
            const [id, title, body, , , targets, category, source] = args as [string, string, string, string, string, string, string, string];
            notices.push({ id, title, body, targets: JSON.parse(targets), category, source });
            return { success: true };
          },
        };
        return stmt;
      },
    },
  };
}

function makeApp(perms: string[], who = { id: 30, name: 'Carrie Ong' }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ??= []), t) } as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { ...who, permissions_set: new Set(perms) } as never);
    await next();
  });
  app.post('/pv/remind', remindApproverHandler as never);
  return app;
}
const remind = (app: Hono, ids: unknown) =>
  app.request('/pv/remind', { method: 'POST', body: JSON.stringify({ ids }), headers: { 'content-type': 'application/json' } }, fakeEnv());

const CHECKER = ['scm.payment_voucher.write', 'scm.payment_voucher.check'];
const reminders = () => tables.entity_audit_log!.filter((r) => r.action === 'REMIND_APPROVER');

beforeEach(() => {
  ROLES = [
    { id: 20, permissions: JSON.stringify(CHECKER) },
    { id: 21, permissions: JSON.stringify(['scm.payment_voucher.approve']) },
    { id: 22, permissions: '["*"]' },
  ];
  tables = {
    payment_vouchers: [
      checked('pv-1', 'HCPV-2610-001'),
      checked('pv-2', 'HCPV-2610-002', { payee_name: 'Tenaga Nasional', total_sen: 12_345, notes: null }),
      checked('pv-3', 'HCPV-2610-003', { checked_at: null, checked_by: null }),
      checked('pv-9', '2990PV-2610-001', { company_id: 2 }),
      checked('pv-5', 'HCPV-2610-005', { status: 'POSTED', approved_at: '2026-10-30T02:00:00Z' }),
    ],
    entity_audit_log: [],
    staff: [],
  };
  notices = [];
});

describe('one checked voucher', () => {
  test("the approver's bell gets the note, the trail records it, the voucher stays as it was", async () => {
    const before = JSON.stringify(tables.payment_vouchers);
    const res = await remind(makeApp(CHECKER), ['pv-1']);
    expect(res.status).toBe(200);
    const out = await res.json() as Row;
    expect(out.reminded).toEqual([{ id: 'pv-1', pvNumber: 'HCPV-2610-001' }]);
    expect(out.approvers).toBe(1);
    expect(notices).toHaveLength(1);
    const n = notices[0]!;
    /* 31 holds the key by name and is granted Houzs; 32 is 2990's only; 34 is disabled; 33's wildcard is not asked while 31 exists. */
    expect(n.targets).toEqual([31]);
    expect(n.title).toBe('Carrie Ong asks you to approve HCPV-2610-001 · Freight Co · RM 500.00');
    expect(n.body).toBe('Checked by Siti on 2026/10/29 · October haulage. Open it to approve & post.');
    expect(n.source).toBe('pv_approval:1:pv-1');
    expect(JSON.stringify(tables.payment_vouchers)).toBe(before);
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({ entity_type: 'PAYMENT_VOUCHER', entity_id: 'pv-1', entity_doc_no: 'HCPV-2610-001', company_id: CO, actor_name_snapshot: 'Carrie Ong' });
  });

  test('a second reminder within the hour is refused, and says when the next can go', async () => {
    const app = makeApp(CHECKER);
    expect((await remind(app, ['pv-1'])).status).toBe(200);
    const again = await remind(app, ['pv-1']);
    expect(again.status).toBe(429);
    const out = await again.json() as Row;
    expect(out.error).toBe('reminded_recently');
    expect(out.message).toMatch(/^HCPV-2610-001 was reminded at \d{2}:\d{2} by Carrie Ong\. One reminder per voucher an hour — the next can go after \d{2}:\d{2}\.$/);
    expect(out.message.length).toBeLessThan(200);
    expect(notices).toHaveLength(1);
  });

  test('after the hour another may go', async () => {
    tables.entity_audit_log!.push({
      entity_type: 'PAYMENT_VOUCHER', entity_id: 'pv-1', company_id: CO, action: 'REMIND_APPROVER',
      actor_name_snapshot: 'Mika', created_at: new Date(Date.now() - REMIND_EVERY_MS - 60_000).toISOString(),
    });
    expect((await remind(makeApp(CHECKER), ['pv-1'])).status).toBe(200);
  });

  test('a voucher not checked yet is refused, and nothing is sent', async () => {
    const res = await remind(makeApp(CHECKER), ['pv-3']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).message).toBe('HCPV-2610-003: This voucher is not checked yet — only a checked voucher waits for the approver.');
    const posted = await remind(makeApp(CHECKER), ['pv-5']);
    expect(posted.status).toBe(409);
    expect(notices).toHaveLength(0);
    expect(reminders()).toHaveLength(0);
  });

  test("another company's voucher is not found here", async () => {
    const res = await remind(makeApp(CHECKER), ['pv-9']);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Row).message).toMatch(/isn't available in the company you're working in/);
    expect(notices).toHaveLength(0);
  });
});

describe('several vouchers from the batch bar', () => {
  test('ONE note lists them; the ones that cannot go are named', async () => {
    const res = await remind(makeApp(CHECKER), ['pv-1', 'pv-2', 'pv-3']);
    expect(res.status).toBe(200);
    const out = await res.json() as Row;
    expect(out.reminded.map((r: Row) => r.pvNumber)).toEqual(['HCPV-2610-001', 'HCPV-2610-002']);
    expect(out.refused).toEqual([expect.objectContaining({ id: 'pv-3', error: 'not_checked' })]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Carrie Ong asks you to approve 2 payment vouchers · RM 623.45');
    expect(notices[0]!.body.split('\n')).toEqual([
      'HCPV-2610-001 · Freight Co · RM 500.00',
      'HCPV-2610-002 · Tenaga Nasional · RM 123.45',
      'Open the checked vouchers to approve & post.',
    ]);
    expect(notices[0]!.source).toBe('pv_approval:1');
    expect(reminders().map((r) => r.entity_id)).toEqual(['pv-1', 'pv-2']);
  });

  test('when every ticked voucher was reminded within the hour, one sentence says so', async () => {
    const app = makeApp(CHECKER);
    expect((await remind(app, ['pv-1', 'pv-2'])).status).toBe(200);
    const again = await remind(app, ['pv-1', 'pv-2']);
    expect(again.status).toBe(429);
    expect(((await again.json()) as Row).message).toMatch(/^All 2 were reminded within the hour\. One reminder per voucher an hour — the first can go again after \d{2}:\d{2}\.$/);
  });

  test('a long batch lists eight and counts the rest', () => {
    const pvs = Array.from({ length: 11 }, (_, i) => checked(`p${i}`, `HCPV-2610-${String(i + 10).padStart(3, '0')}`)) as never[];
    const n = remindNotice('Carrie Ong', CO, pvs);
    expect(n.body.split('\n')).toHaveLength(10);
    expect(n.body).toContain('…and 3 more');
  });
});

describe('who is reminded', () => {
  test('nobody holds the key by name: whoever may approve — never the sender', async () => {
    ROLES = ROLES.filter((r) => r.id !== 21);
    const res = await remind(makeApp(CHECKER), ['pv-1']);
    expect(res.status).toBe(200);
    expect(notices[0]!.targets).toEqual([33]);
    const self = await remind(makeApp(CHECKER, { id: 33, name: 'Nico' }), ['pv-2']);
    expect(self.status).toBe(409);
    expect(((await self.json()) as Row).error).toBe('no_approver');
  });

  test('a viewer who may neither prepare nor check is turned away', async () => {
    const res = await remind(makeApp(['scm.payment_voucher.read']), ['pv-1']);
    expect(res.status).toBe(403);
    expect(notices).toHaveLength(0);
  });

  test('a malformed request names what is missing', async () => {
    expect((await remind(makeApp(CHECKER), [])).status).toBe(400);
    expect((await remind(makeApp(CHECKER), ['pv-1', 'pv-1'])).status).toBe(400);
  });
});
