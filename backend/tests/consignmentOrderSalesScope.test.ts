/* ── The consignment order's WRITE verbs had no salesperson row scope ─────────
   The CO READ paths have held a rep to their OWN + reporting-downline orders
   since #417 (GET /:docNo, /audit-log, /payments all run salesDocOutOfScope).
   Every WRITE carried COMPANY scope and nothing else, so a scoped salesperson
   could amend, cancel, re-line, repay or reassign ANY consignment order by
   enumerable doc_no — including both payment verbs, which write money. Owner
   ruling 2026-08-13: "要,和销售订单一致" — match the Sales Order.

   Three layers, because each catches what the others cannot:

     1. the shared guard's own decision, driven directly. Ten write verbs defer
        to selfScopedConsignmentBlocked, so its truth table IS their behaviour.
     2. one real handler end to end (PATCH /:docNo/status — the CANCEL verb),
        through a bare Hono app with a fake PostgREST client, asserting the HTTP
        answer AND that the victim row is byte-unchanged. A 404 that still
        mutated would pass a status-only assertion.
     3. a structural sweep of the route source, so a write verb added next month
        cannot skip the guard silently. Layer 1 and 2 prove the guard works;
        only layer 3 proves every verb uses it.

   BOTH DIRECTIONS are asserted throughout, deliberately. The failure mode of a
   scope sweep is not "the leak stayed open", it is "we hid a rep's own orders
   from them" — so every refusal test is paired with a reach test.

   Harness shape: mount the EXPORTED handler, not the router. consignmentOrders
   applies supabaseAuth at '*', which cannot run here — the same limitation
   companyScopeConsignmentPo.test.ts and photoSigningFallback.test.ts document. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/consignment-orders.ts?raw';
import {
  patchConsignmentOrderStatusHandler,
  selfScopedConsignmentBlocked,
} from '../src/scm/routes/consignment-orders';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

/* ── The org chart. REP_A reports to MANAGER; REP_B reports to nobody, so the
   two reps are siblings with no line between them — the exact pair the scope
   is supposed to separate. ─────────────────────────────────────────────────── */
const MANAGER = 11;
const REP_A = 9;
const REP_B = 10;
const USERS: Array<{ id: number; manager_id: number | null }> = [
  { id: MANAGER, manager_id: null },
  { id: REP_A, manager_id: MANAGER },
  { id: REP_B, manager_id: null },
];

/* mig 0066 sync rows — salesperson_id speaks scm.staff uuids, never user ids. */
const STAFF_A = 'staff-aaaa';
const STAFF_B = 'staff-bbbb';
const STAFF_MGR = 'staff-mgr';

type Row = Record<string, any>;

const staffRows = (): Row[] => [
  { id: STAFF_A, user_id: REP_A, name: 'Rep A' },
  { id: STAFF_B, user_id: REP_B, name: 'Rep B' },
  { id: STAFF_MGR, user_id: MANAGER, name: 'Manager' },
];

const OWN_DOC = 'HC-CS-2608-001';   // REP_A's
const OTHER_DOC = 'HC-CS-2608-002'; // REP_B's
const B_CO_DOC = '2990-CS-2608-003'; // REP_A's, but company B's book

const orders = (): Row[] => [
  { doc_no: OWN_DOC, company_id: CO_A, salesperson_id: STAFF_A, status: 'CONFIRMED' },
  { doc_no: OTHER_DOC, company_id: CO_A, salesperson_id: STAFF_B, status: 'CONFIRMED' },
  { doc_no: B_CO_DOC, company_id: CO_B, salesperson_id: STAFF_A, status: 'CONFIRMED' },
];

/* ── Callers ─────────────────────────────────────────────────────────────────
   "Sales Executive" is deliberately NOT one of pmsAccess' DIRECTOR_POSITION_NAMES
   (Super Admin / Sales Director / Finance Manager), so these two are genuinely
   self-scoped and canViewAllSales is false for them. */
const repA = { id: REP_A, name: 'Rep A', position_name: 'Sales Executive', permissions_set: new Set(['scm.access']) };
const repB = { id: REP_B, name: 'Rep B', position_name: 'Sales Executive', permissions_set: new Set(['scm.access']) };
const manager = { id: MANAGER, name: 'Manager', position_name: 'Sales Manager', permissions_set: new Set(['scm.access']) };
/* The two INDEPENDENT view-all grants canViewAllSales OR-s together. */
const viewAllByPermission = { id: 20, name: 'Ops', position_name: 'Logistics Executive', permissions_set: new Set(['scm.so.view_all']) };
const viewAllByPosition = { id: 21, name: 'Director', position_name: 'Sales Director', permissions_set: new Set(['scm.access']) };

/* ── Fake D1, for orgScope.subtreeUserIds ────────────────────────────────────
   The only statement it runs is `SELECT id FROM users WHERE manager_id IN (?)`,
   expanded breadth-first. */
function fakeDb() {
  return {
    prepare(sql: string) {
      return {
        bind(...ids: unknown[]) {
          return {
            async all<T>(): Promise<{ results: T[] }> {
              if (!/FROM users WHERE manager_id IN/.test(sql)) return { results: [] };
              const frontier = new Set(ids.map(Number));
              return {
                results: USERS
                  .filter((u) => u.manager_id != null && frontier.has(Number(u.manager_id)))
                  .map((u) => ({ id: u.id })) as unknown as T[],
              };
            },
          };
        },
      };
    },
  };
}

/* ── Permissive fake PostgREST builder ───────────────────────────────────────
   A copy of the one in companyScopeConsignmentPo.test.ts, plus `count` (the
   downstream-lock probe reads a head/count response). Every method chains and
   an unknown table reads as empty rather than throwing — the assertions are
   about the scope predicate, not the rest of the handler. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private counting = false;
  constructor(private rows: Row[]) {}
  select(_cols?: unknown, opts?: { count?: string }) {
    if (opts?.count) this.counting = true;
    return this;
  }
  order() { return this; }
  limit() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  not() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const h = this.run();
    return Promise.resolve({ data: this.counting ? null : h, error: null, count: h.length }).then(res, rej);
  }
}

function fakeSupabase(tables: Record<string, Row[]>) {
  return { from: (t: string) => new FakeQuery((tables[t] ||= [])) };
}

/* A minimal context satisfying what the guard reads: get('supabase'),
   get('companyId') / get('allowedCompanyIds') for companyScope, get('houzsUser')
   for the permission tier, and `env` for the org-chart walk. */
function ctx(
  tables: Record<string, Row[]>,
  houzsUser: unknown,
  companyId: number | undefined,
  allowedCompanyIds: number[] | undefined = companyId == null ? undefined : [CO_A, CO_B],
) {
  const bag: Record<string, unknown> = {
    supabase: fakeSupabase(tables),
    companyId,
    allowedCompanyIds,
    houzsUser,
    user: { id: 'system-staff-uuid', user_metadata: { name: 'Tester' } },
  };
  return { get: (k: string) => bag[k], env: { DB: fakeDb() } };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The shared guard — the decision all ten write verbs defer to.
// ═══════════════════════════════════════════════════════════════════════════
describe('selfScopedConsignmentBlocked: salesperson row scope on consignment writes', () => {
  const blockedFor = (user: unknown, docNo: string, companyId: number | undefined = CO_A) =>
    selfScopedConsignmentBlocked(
      ctx({ consignment_sales_orders: orders(), staff: staffRows() }, user, companyId),
      docNo,
    );

  test('a scoped rep is BLOCKED from another rep\'s consignment order', async () => {
    await expect(blockedFor(repA, OTHER_DOC)).resolves.toBe(true);
  });

  test('a scoped rep CAN still reach their OWN consignment order', async () => {
    await expect(blockedFor(repA, OWN_DOC)).resolves.toBe(false);
  });

  test('the block is symmetric — rep B cannot reach rep A\'s order either', async () => {
    await expect(blockedFor(repB, OWN_DOC)).resolves.toBe(true);
    await expect(blockedFor(repB, OTHER_DOC)).resolves.toBe(false);
  });

  test('a manager reaches their DOWNLINE\'s order, not the unrelated rep\'s', async () => {
    // Owner spec: self + FULL reporting chain, not one hop and not the whole book.
    await expect(blockedFor(manager, OWN_DOC)).resolves.toBe(false);
    await expect(blockedFor(manager, OTHER_DOC)).resolves.toBe(true);
  });

  test('the view-all tier still reaches EVERY order in its company', async () => {
    for (const user of [viewAllByPermission, viewAllByPosition]) {
      await expect(blockedFor(user, OWN_DOC)).resolves.toBe(false);
      await expect(blockedFor(user, OTHER_DOC)).resolves.toBe(false);
    }
  });

  test('company is checked FIRST and for everyone — view-all included', async () => {
    /* The salesperson dimension answers false straight away for a view-all
       caller, which is right for its own question and useless for tenancy. A
       company-A caller holding a company-B doc_no must still be refused. */
    await expect(blockedFor(viewAllByPermission, B_CO_DOC)).resolves.toBe(true);
    await expect(blockedFor(viewAllByPosition, B_CO_DOC)).resolves.toBe(true);
    // ...and REP_A owns that order, so only the company predicate can refuse it.
    await expect(blockedFor(repA, B_CO_DOC)).resolves.toBe(true);
    // Switched into company B, the same caller reaches it again.
    await expect(blockedFor(repA, B_CO_DOC, CO_B)).resolves.toBe(false);
  });

  test('an unknown doc_no is blocked — fail closed, never open', async () => {
    await expect(blockedFor(viewAllByPermission, 'HC-CS-9999-999')).resolves.toBe(true);
    await expect(blockedFor(repA, 'HC-CS-9999-999')).resolves.toBe(true);
  });

  test('a caller with no houzsUser at all is blocked', async () => {
    await expect(blockedFor(undefined, OWN_DOC)).resolves.toBe(true);
  });

  test('an UNRESOLVED company degrades on tenancy but still holds the rep to their own', async () => {
    /* companyScope.ts's three-state sentinel: undefined allowedCompanyIds means
       the companies master was unreadable (pre-migration / cold start), and the
       company predicate must DROP rather than fail closed — a guard that failed
       closed here would lock every user out of every CO write during a cold
       start. The salesperson dimension is unaffected and still refuses. */
    const noCompany = (user: unknown, docNo: string) =>
      selfScopedConsignmentBlocked(
        ctx({ consignment_sales_orders: orders(), staff: staffRows() }, user, undefined, undefined),
        docNo,
      );
    await expect(noCompany(repA, OWN_DOC)).resolves.toBe(false);
    await expect(noCompany(repA, OTHER_DOC)).resolves.toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. One real handler, end to end — PATCH /:docNo/status (the CANCEL verb).
// ═══════════════════════════════════════════════════════════════════════════
function harness(tables: Record<string, Row[]>, houzsUser: unknown, companyId: number | undefined) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, fakeSupabase(tables) as never);
    c.set('companyId' as never, companyId as never);
    c.set('allowedCompanyIds' as never, [CO_A, CO_B] as never);
    c.set('user' as never, { id: 'system-staff-uuid', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, houzsUser as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = { DB: fakeDb() };
    await next();
  });
  app.patch('/consignment-orders/:docNo/status', patchConsignmentOrderStatusHandler as never);
  return app;
}

const cancel = (app: Hono, docNo: string) =>
  app.request(`/consignment-orders/${docNo}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'CANCELLED' }),
  });

describe('PATCH /consignment-orders/:docNo/status is held to the caller\'s own orders', () => {
  test('a scoped rep CANNOT cancel another rep\'s order, and it stays CONFIRMED', async () => {
    const t = { consignment_sales_orders: orders(), staff: staffRows() };
    const res = await cancel(harness(t, repA, CO_A), OTHER_DOC);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
    // The write itself did not happen — a 404 that still mutated proves nothing.
    expect(t.consignment_sales_orders.find((r) => r.doc_no === OTHER_DOC)!.status).toBe('CONFIRMED');
  });

  test('a scoped rep CAN still cancel their OWN order', async () => {
    const t = { consignment_sales_orders: orders(), staff: staffRows() };
    const res = await cancel(harness(t, repA, CO_A), OWN_DOC);

    expect(res.status).toBe(200);
    expect(t.consignment_sales_orders.find((r) => r.doc_no === OWN_DOC)!.status).toBe('CANCELLED');
  });

  test('the view-all tier still cancels anyone\'s order', async () => {
    const t = { consignment_sales_orders: orders(), staff: staffRows() };
    const res = await cancel(harness(t, viewAllByPermission, CO_A), OTHER_DOC);

    expect(res.status).toBe(200);
    expect(t.consignment_sales_orders.find((r) => r.doc_no === OTHER_DOC)!.status).toBe('CANCELLED');
  });

  test('company scope is NOT replaced by the new one — B\'s order stays out of reach', async () => {
    const t = { consignment_sales_orders: orders(), staff: staffRows() };
    // REP_A owns B_CO_DOC, so only the company predicate can refuse this.
    const res = await cancel(harness(t, repA, CO_A), B_CO_DOC);

    expect(res.status).toBe(404);
    expect(t.consignment_sales_orders.find((r) => r.doc_no === B_CO_DOC)!.status).toBe('CONFIRMED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Structural — EVERY write verb carries the guard.
// ═══════════════════════════════════════════════════════════════════════════

/* A create has no existing row to scope, so the guard has nothing to decide
   there. It is exempt only because the route file SAYS so, and the assertion
   below checks that sentence is present: an exemption the reader cannot see is
   an exemption nobody re-checks, which is how this class survived four audits. */
const DOCUMENTED_EXEMPTIONS = new Map<string, string>([
  ["post('/'", 'NO selfScopedConsignmentBlocked HERE, deliberately'],
]);

const GUARD = 'selfScopedConsignmentBlocked(c, docNo)';
const WRITE_METHODS = new Set(['post', 'patch', 'put', 'delete']);

/** The source slice from `start` to the next top-level declaration. */
function blockFrom(start: number): string {
  const bounds = [
    routeSource.indexOf('\nconsignmentOrders.', start + 20),
    routeSource.indexOf('\nexport const ', start + 20),
    routeSource.indexOf('\nexport async function ', start + 20),
    routeSource.indexOf('\nasync function ', start + 20),
    routeSource.indexOf('\nconst ', start + 20),
  ].filter((i) => i > 0);
  return routeSource.slice(start, bounds.length > 0 ? Math.min(...bounds) : routeSource.length);
}

/** `body` is what runs; `documented` also carries the comment block ABOVE it,
 *  because a "why not" note is written in front of the handler, not inside it. */
type Verb = { anchor: string; body: string; documented: string };

/** Every write registration, resolved to the body that actually runs — a route
 *  registered as `patch('/x', someHandler)` is checked against someHandler. */
function writeVerbs(): Verb[] {
  const out: Verb[] = [];
  const re = /^consignmentOrders\.(get|post|patch|put|delete)\('([^']+)',\s*(\w+)?/gm;
  for (const m of routeSource.matchAll(re)) {
    const [, method, path, ident] = m;
    if (!WRITE_METHODS.has(method!)) continue;
    const anchor = `${method}('${path}'`;
    const at = ident && /Handler$/.test(ident)
      ? routeSource.indexOf(`const ${ident} = `)
      : m.index!;
    expect(at, `${anchor}: handler body not found`).toBeGreaterThan(0);
    const body = blockFrom(at);
    out.push({ anchor, body, documented: routeSource.slice(Math.max(0, at - 1600), at) + body });
  }
  return out;
}

describe('every consignment-order write verb carries the salesperson row scope', () => {
  test('the sweep actually found the verbs (a check over nothing must never pass)', () => {
    const verbs = writeVerbs();
    // 10 guarded + POST / (create). Not pinned to an exact list on purpose —
    // the per-verb assertion below is what a NEW verb has to satisfy.
    expect(verbs.length).toBeGreaterThanOrEqual(11);
    expect(verbs.map((v) => v.anchor)).toContain("post('/:docNo/payments'");
    expect(verbs.map((v) => v.anchor)).toContain("delete('/:docNo/payments/:id'");
  });

  for (const { anchor, body, documented } of writeVerbs()) {
    const exemption = DOCUMENTED_EXEMPTIONS.get(anchor);
    if (exemption) {
      test(`${anchor} is exempt, and says why in the source`, () => {
        expect(documented, `${anchor}: exemption is undocumented`).toContain(exemption);
        expect(body).not.toContain(`if (await ${GUARD})`);
      });
      continue;
    }
    test(`${anchor} refuses an order outside the caller's sales scope`, () => {
      expect(body, `${anchor}: missing ${GUARD}`).toContain(`if (await ${GUARD})`);
      // The refusal is the SO's, byte for byte — a 404 indistinguishable from
      // a nonexistent doc_no. Anything else confirms someone else's doc exists.
      expect(body).toContain(`if (await ${GUARD}) return c.json({ error: 'not_found' }, 404);`);
    });
  }

  test('the guard runs BEFORE the downstream lock, so authz is not reported as a conflict', () => {
    /* The SO's 2026-07-22 lesson, one document over: a caller who may not touch
       the order at all must not be told "cancel the Consignment Note first" —
       that sentence is an instruction to act, so the real reason never surfaces. */
    for (const { anchor, body } of writeVerbs()) {
      const lockAt = body.indexOf('coHasDownstream(sb, docNo)');
      if (lockAt < 0) continue;
      const guardAt = body.indexOf(`if (await ${GUARD})`);
      expect(guardAt, `${anchor}: missing guard`).toBeGreaterThan(0);
      expect(guardAt, `${anchor}: the downstream lock runs first, so a refusal reads as 409 co_has_downstream`).toBeLessThan(lockAt);
    }
  });

  test('the READ paths keep the scope they already had', () => {
    // Regression guard on the reads this change deliberately left alone.
    for (const anchor of ["get('/:docNo'", "get('/:docNo/audit-log'", "get('/:docNo/payments'"]) {
      const at = routeSource.indexOf(`consignmentOrders.${anchor}`);
      expect(at, `${anchor} not found`).toBeGreaterThan(0);
      expect(blockFrom(at)).toContain('salesDocOutOfScope(');
    }
  });
});
