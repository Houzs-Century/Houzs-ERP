// Unit tests for the Delivery / TMS per-assignee row scope (lib/deliveryScope).
// Route-level coverage is not possible in this harness (scm rides Supabase
// Postgres; the harness rebuilds only the D1 side), so these pin the pure
// resolution + matching rules the board / trips / step-submit paths rely on.
import { describe, expect, test } from 'vitest';
import {
  resolveDeliveryScope,
  scopeMatchesAssignment,
  type DeliveryScope,
} from '../src/scm/lib/deliveryScope';

type Row = Record<string, unknown>;

/** Minimal fake of the two lookups resolveDeliveryScope performs:
 *  sb.from('drivers'|'helpers').select('id').eq('user_id', n) → {data,error}. */
function fakeSb(opts: { drivers?: Row[]; helpers?: Row[]; error?: boolean }) {
  const q = (rows: Row[]) => ({
    select() { return this; },
    eq(_col: string, val: unknown) {
      if (opts.error) return Promise.resolve({ data: null, error: { message: 'boom' } });
      return Promise.resolve({ data: rows.filter((r) => r.user_id === val), error: null });
    },
  });
  return {
    from: (t: string) => q(t === 'drivers' ? (opts.drivers ?? []) : (opts.helpers ?? [])),
  };
}

const driverCaller = (id: number) => ({ id, position_name: 'Driver', department_name: 'Operation' });
const helperCaller = (id: number) => ({ id, position_name: 'Helper', department_name: 'Operation' });

describe('resolveDeliveryScope — INTENT gate (positionPolicy cohort)', () => {
  test('wildcard caller is never scoped', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'd1', user_id: 7 }] }),
      { id: 7, position_name: 'Driver', permissions_set: new Set(['*']) },
    );
    expect(scope.mode).toBe('all');
  });

  test('a non-restricted position (Operation Manager) sees the whole board even with a stray fleet row', async () => {
    // Ops must NEVER be narrowed by accident — the policy gate wins over a link.
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'd1', user_id: 9 }] }),
      { id: 9, position_name: 'Operation Manager', department_name: 'Operation' },
    );
    expect(scope.mode).toBe('all');
  });

  test('a Sales position is not scoped by this module', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({}),
      { id: 3, position_name: 'Sales Executive', department_name: 'Sales' },
    );
    expect(scope.mode).toBe('all');
  });
});

describe('resolveDeliveryScope — IDENTITY gate (fleet link)', () => {
  test('a Driver with a linked scm.drivers row is scoped to that driver id', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'drv-7', user_id: 7 }] }),
      driverCaller(7),
    );
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect([...scope.driverIds]).toEqual(['drv-7']);
      expect([...scope.helperIds]).toEqual([]);
    }
  });

  test('a Helper with a linked scm.helpers row is scoped to that helper id', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ helpers: [{ id: 'hlp-8', user_id: 8 }] }),
      helperCaller(8),
    );
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect([...scope.helperIds]).toEqual(['hlp-8']);
      expect([...scope.driverIds]).toEqual([]);
    }
  });

  test('an UNLINKED Driver fails CLOSED — empty self scope, sees no board', async () => {
    // 2026-08-25 (owner: 只能看到分配给自己的). Fleet personnel with no link get
    // an empty self scope, which matches no assignment — not the whole fleet.
    const scope = await resolveDeliveryScope(fakeSb({ drivers: [], helpers: [] }), driverCaller(7));
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect(scope.driverIds.size).toBe(0);
      expect(scope.helperIds.size).toBe(0);
      // Proof it is closed, not open: an empty self matches nothing.
      expect(scopeMatchesAssignment(scope, { driverIds: ['drv-9'], helperIds: ['hlp-9'] })).toBe(false);
    }
  });

  test('an UNLINKED Helper also fails CLOSED', async () => {
    const scope = await resolveDeliveryScope(fakeSb({ drivers: [], helpers: [] }), helperCaller(7));
    expect(scope.mode).toBe('self');
  });

  test('a Storekeeper (restricted but NOT fleet) with no link keeps the whole board', async () => {
    // The delivery board is a coordination surface for the warehouse, not a run
    // sheet — storekeepers are not narrowed even without a fleet row.
    const sk = await resolveDeliveryScope(fakeSb({ drivers: [], helpers: [] }), {
      id: 5, position_name: 'Storekeeper', department_name: 'Operation',
    });
    expect(sk.mode).toBe('all');
    const sup = await resolveDeliveryScope(fakeSb({ drivers: [], helpers: [] }), {
      id: 6, position_name: 'Storekeeper Supervisor', department_name: 'Operation',
    });
    expect(sup.mode).toBe('all');
  });

  test('a fleet lookup ERROR fails OPEN (a DB fault is not a lockout)', async () => {
    const scope = await resolveDeliveryScope(fakeSb({ error: true }), driverCaller(7));
    expect(scope.mode).toBe('all');
  });

  test('a caller with no id fails OPEN (cannot resolve a fleet identity at all)', async () => {
    const scope = await resolveDeliveryScope(fakeSb({}), { id: null, position_name: 'Driver' });
    expect(scope.mode).toBe('all');
  });
});

describe('scopeMatchesAssignment', () => {
  const selfScope: DeliveryScope = {
    mode: 'self',
    driverIds: new Set(['drv-1']),
    helperIds: new Set(['hlp-1', 'hlp-2']),
  };

  test('an `all` scope matches every job, including unassigned', () => {
    expect(scopeMatchesAssignment({ mode: 'all' }, { driverIds: [], helperIds: [] })).toBe(true);
  });

  test('self matches when the job driver is the caller', () => {
    expect(scopeMatchesAssignment(selfScope, { driverIds: ['drv-1'], helperIds: [] })).toBe(true);
  });

  test('self matches when the job helper is the caller', () => {
    expect(scopeMatchesAssignment(selfScope, { driverIds: ['drv-x'], helperIds: ['hlp-2'] })).toBe(true);
  });

  test('self does NOT match another crew’s job', () => {
    expect(scopeMatchesAssignment(selfScope, { driverIds: ['drv-9'], helperIds: ['hlp-9'] })).toBe(false);
  });

  test('self does NOT match an unassigned job (no driver / helper)', () => {
    expect(scopeMatchesAssignment(selfScope, { driverIds: [null, undefined], helperIds: [] })).toBe(false);
  });
});
