// Company scoping on the two WRITE paths closed in this pass (audit PR #826,
// items 1 and 2), driven end-to-end through a bare Hono app whose middleware
// injects a fake scm supabase client + a company context. Mounting the EXPORTED
// handlers (not the whole router) skips the supabaseAuth bridge, which cannot
// run in this harness — same approach as fairReport.route.test.ts.
//
// BOTH DIRECTIONS are asserted for every fix, deliberately. The failure mode of
// this kind of change is not "the leak stayed open", it is "we locked a company
// out of its own data" — so every leak test is paired with a same-company test
// proving the legitimate request still works.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { postJournalEntryHandler } from '../src/scm/routes/accounting';
import { patchWarehouseHandler } from '../src/scm/routes/inventory';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

// ── Fake PostgREST query builder over an in-memory table ─────────────────────
type Row = Record<string, any>;
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' = 'select';
  private patch: Row = {};
  constructor(private rows: Row[], private log: string[]) {}
  select() { return this; }
  order() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row) { this.op = 'update'; this.patch = p; return this; }
  eq(col: string, val: unknown) {
    this.log.push(`eq:${col}`);
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) !== String(val));
    return this;
  }
  private matched() { return this.rows.filter((r) => this.preds.every((p) => p(r))); }
  private run() {
    const hit = this.matched();
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() {
    const hit = this.run();
    return Promise.resolve({ data: hit[0] ?? null, error: null });
  }
  single() {
    const hit = this.run();
    return Promise.resolve({ data: hit[0] ?? null, error: hit.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/* The GL post verbs gained a permission gate on 2026-08-13 (audit item C7:
   accounting.ts had ZERO in-route checks on four GL verbs while payment vouchers
   were double-gated). These tests are about COMPANY SCOPING, so the harness has
   to get past the gate to reach what it is testing — otherwise every assertion
   below reads 403 and proves nothing about scoping.
   Granting it here does NOT leave the gate untested: `the GL gate itself` below
   drives the same handler with no grant and asserts the 403. */
const GL_PERM = 'scm.payment_voucher.post';

function harness(
  tables: Record<string, Row[]>,
  companyId: number | undefined,
  perms: readonly string[] = [GL_PERM],
) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), log),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('houzsUser' as never, { permissions_set: perms } as never);
    await next();
  });
  app.post('/journal-entries/:id/post', postJournalEntryHandler as never);
  app.patch('/warehouses/:id', patchWarehouseHandler as never);
  return { app, log };
}

const jes = (): Row[] => [
  { id: 'je-a', je_no: 'JE-A-1', company_id: CO_A, posted: false, reversed: false },
  { id: 'je-b', je_no: 'JE-B-1', company_id: CO_B, posted: false, reversed: false },
  { id: 'je-a-done', je_no: 'JE-A-2', company_id: CO_A, posted: true, reversed: false },
  { id: 'je-a-rev', je_no: 'JE-A-3', company_id: CO_A, posted: false, reversed: true },
];

const whs = (): Row[] => [
  { id: 'wh-a1', code: 'KL', company_id: CO_A, is_default: true, is_active: true },
  { id: 'wh-a2', code: 'JB', company_id: CO_A, is_default: false, is_active: true },
  { id: 'wh-b1', code: 'PJ', company_id: CO_B, is_default: true, is_active: true },
];

const post = (app: Hono, id: string) =>
  app.request(`/journal-entries/${id}/post`, { method: 'POST' });
const patchWh = (app: Hono, id: string, body: Row) =>
  app.request(`/warehouses/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/* ── Item 1: POST /journal-entries/:id/post ──────────────────────────────── */
describe('posting a GL journal entry is scoped to the active company', () => {
  test('company A CANNOT post company B\'s journal entry, and B stays unposted', async () => {
    const t = { journal_entries: jes() };
    const { app } = harness(t, CO_A);
    const res = await post(app, 'je-b');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found_in_company' });
    // The write itself did not happen.
    expect(t.journal_entries.find((r) => r.id === 'je-b')!.posted).toBe(false);
  });

  test('the refusal does not reveal that B\'s entry exists', async () => {
    const t = { journal_entries: jes() };
    const { app } = harness(t, CO_A);
    const real = await post(app, 'je-b');       // exists, wrong company
    const fake = await post(app, 'nope-1234');  // does not exist at all
    expect(real.status).toBe(fake.status);
    expect(await real.json()).toEqual(await fake.json());
  });

  test('company A CAN still post its OWN journal entry', async () => {
    const t = { journal_entries: jes() };
    const { app } = harness(t, CO_A);
    const res = await post(app, 'je-a');

    expect(res.status).toBe(200);
    expect((await res.json()).journalEntry).toMatchObject({ id: 'je-a', posted: true });
    expect(t.journal_entries.find((r) => r.id === 'je-a')!.posted).toBe(true);
    // and it did not touch the other company's row
    expect(t.journal_entries.find((r) => r.id === 'je-b')!.posted).toBe(false);
  });

  test('the UPDATE carries the company predicate too, not just the load', async () => {
    const t = { journal_entries: jes() };
    const { app, log } = harness(t, CO_A);
    await post(app, 'je-a');
    // Two statements run (load, then update) and BOTH name company_id.
    expect(log.filter((l) => l === 'eq:company_id').length).toBeGreaterThanOrEqual(2);
  });

  test('an already-posted entry is refused with a plain reason', async () => {
    const { app } = harness({ journal_entries: jes() }, CO_A);
    const res = await post(app, 'je-a-done');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_posted');
  });

  test('a reversed entry is refused with a plain reason', async () => {
    const { app } = harness({ journal_entries: jes() }, CO_A);
    const res = await post(app, 'je-a-rev');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('je_reversed');
  });

  test('an unresolvable company is an ERROR, never "all companies"', async () => {
    const t = { journal_entries: jes() };
    const { app } = harness(t, undefined);
    const res = await post(app, 'je-a');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('company_unresolved');
    expect(t.journal_entries.every((r) => r.id === 'je-a-done' || !r.posted)).toBe(true);
  });
});

/* ── Item 2: PATCH /warehouses/:id — the default-warehouse demote ─────────── */
describe('setting a default warehouse only affects the active company', () => {
  test('promoting A\'s warehouse does NOT demote B\'s default', async () => {
    const t = { warehouses: whs() };
    const { app } = harness(t, CO_A);
    const res = await patchWh(app, 'wh-a2', { isDefault: true });

    expect(res.status).toBe(200);
    // A's default moved...
    expect(t.warehouses.find((r) => r.id === 'wh-a2')!.is_default).toBe(true);
    expect(t.warehouses.find((r) => r.id === 'wh-a1')!.is_default).toBe(false);
    // ...and B still has exactly the default it had. This is the regression:
    // unscoped, wh-b1 was demoted and company B was left with NO default, so
    // defaultWarehouseId() returned null and GRN/DO/return posts lost their
    // warehouse fallback.
    expect(t.warehouses.find((r) => r.id === 'wh-b1')!.is_default).toBe(true);
    expect(t.warehouses.filter((r) => r.company_id === CO_B && r.is_default)).toHaveLength(1);
  });

  test('company A CANNOT patch company B\'s warehouse by id', async () => {
    const t = { warehouses: whs() };
    const { app } = harness(t, CO_A);
    const res = await patchWh(app, 'wh-b1', { name: 'renamed by A' });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found_in_company' });
    expect(t.warehouses.find((r) => r.id === 'wh-b1')!.name).toBeUndefined();
  });

  test('A promoting B\'s warehouse cannot strand A without a default', async () => {
    // The reason scoping the demote alone is not enough: if the TARGET row were
    // still reachable by blind id, A would promote B's row and the now-scoped
    // demote would clear A's own default.
    const t = { warehouses: whs() };
    const { app } = harness(t, CO_A);
    await patchWh(app, 'wh-b1', { isDefault: true });
    expect(t.warehouses.find((r) => r.id === 'wh-a1')!.is_default).toBe(true);
  });

  test('company A CAN still rename its own warehouse', async () => {
    const t = { warehouses: whs() };
    const { app } = harness(t, CO_A);
    const res = await patchWh(app, 'wh-a2', { name: 'Johor Bahru' });

    expect(res.status).toBe(200);
    expect((await res.json()).warehouse).toMatchObject({ id: 'wh-a2' });
    expect(t.warehouses.find((r) => r.id === 'wh-a2')!.name).toBe('Johor Bahru');
  });

  test('company B CAN still set its own default (both companies keep working)', async () => {
    const t = { warehouses: [...whs(), { id: 'wh-b2', code: 'PJ2', company_id: CO_B, is_default: false, is_active: true }] };
    const { app } = harness(t, CO_B);
    const res = await patchWh(app, 'wh-b2', { isDefault: true });

    expect(res.status).toBe(200);
    expect(t.warehouses.find((r) => r.id === 'wh-b2')!.is_default).toBe(true);
    expect(t.warehouses.find((r) => r.id === 'wh-b1')!.is_default).toBe(false);
    // A untouched.
    expect(t.warehouses.find((r) => r.id === 'wh-a1')!.is_default).toBe(true);
  });

  test('an unresolvable company is an ERROR, and demotes nothing', async () => {
    const t = { warehouses: whs() };
    const { app } = harness(t, undefined);
    const res = await patchWh(app, 'wh-a2', { isDefault: true });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('company_unresolved');
    expect(t.warehouses.filter((r) => r.is_default).map((r) => r.id)).toEqual(['wh-a1', 'wh-b1']);
  });
});

/* ── The refusal has to survive the client that renders it ───────────────── */
/* ── The gate the harness above grants past ──────────────────────────────── */
describe('the GL gate itself', () => {
  /* Without this, granting GL_PERM in the harness would quietly REMOVE coverage
     of the gate it was added to get past — the shape where a test is "fixed" by
     disabling the thing it was failing on. */
  test('a caller without the permission cannot post a journal entry at all', async () => {
    const t = { journal_entries: jes() };
    const { app } = harness(t, CO_A, []);
    const res = await post(app, 'je-a');

    expect(res.status).toBe(403);
    // And it is refused BEFORE the row is touched, not after.
    expect(t.journal_entries.find((r) => r.id === 'je-a')!.posted).toBe(false);
  });

  test('the wildcard grant passes, so Owner / IT Admin are not locked out', async () => {
    const t = { journal_entries: jes() };
    const { app } = harness(t, CO_A, ['*']);
    const res = await post(app, 'je-a');

    expect(res.status).toBe(200);
  });
});

describe('refusal wording', () => {
  test('every refusal message is under the SCM client\'s 200-character cutoff', async () => {
    const { app } = harness({ journal_entries: jes(), warehouses: whs() }, undefined);
    const bodies = [
      await (await post(app, 'je-a')).json(),
      await (await patchWh(app, 'wh-a2', { isDefault: true })).json(),
    ];
    for (const b of bodies) {
      expect(typeof b.message).toBe('string');
      // authed-fetch.ts drops a server message of 200+ chars and shows a
      // generic clash line instead — the operator would hit a blank wall.
      expect(b.message.length).toBeLessThan(200);
    }
  });
});
