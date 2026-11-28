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
 *  sb.from('drivers').select('id, vehicle, name').eq('user_id', n) and the same
 *  for 'helpers' → {data,error}. Driver rows may carry `vehicle` / `name`, which
 *  feed the login's own lorry-plate(s). */
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

describe('resolveDeliveryScope — Outsource Transporter (3PL POD driver, owner 2026-11-28)', () => {
  const outsourceCaller = (id: number) => ({
    id, position_name: 'Outsource Transporter', department_name: 'Operation',
  });

  test('a LINKED Outsource Transporter is scoped to its own driver id (sees + PODs only its own stops)', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'drv-3pl', user_id: 42 }] }),
      outsourceCaller(42),
    );
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect([...scope.driverIds]).toEqual(['drv-3pl']);
      expect(scopeMatchesAssignment(scope, { driverIds: ['drv-3pl'], helperIds: [] })).toBe(true);
      expect(scopeMatchesAssignment(scope, { driverIds: ['drv-other'], helperIds: [] })).toBe(false);
    }
  });

  test('an UNLINKED Outsource Transporter fails CLOSED — empty self scope, NOT the whole board', async () => {
    // It is a fleet position (FLEET_POSITIONS / position_policy.is_fleet=true), so an
    // unlinked one gets an empty self scope that matches nothing — never the whole fleet.
    const scope = await resolveDeliveryScope(fakeSb({ drivers: [], helpers: [] }), outsourceCaller(42));
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect(scope.driverIds.size).toBe(0);
      expect(scopeMatchesAssignment(scope, { driverIds: ['drv-9'], helperIds: ['hlp-9'] })).toBe(false);
    }
  });
});

describe('resolveDeliveryScope — LORRY-PLATE arm (owner 2026-11-28, one phone per lorry)', () => {
  // The lorry account is named after its PLATE and linked to its own scm.drivers
  // row; production stores the name spaced ("MCF 3084") and scm.lorries.plate
  // canonical ("MCF3084"), so canonicalisation (normalizePlate) must bridge them.
  const outsourceCaller = (id: number) => ({
    id, position_name: 'Outsource Transporter', department_name: 'Operation',
  });

  test('a lorry account derives its plate from the account NAME when vehicle is unset', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'drv-mcf', user_id: 50, vehicle: null, name: 'MCF 3084' }] }),
      outsourceCaller(50),
    );
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect([...scope.lorryPlates]).toEqual(['MCF3084']); // canonicalised
      // Matches a stop on its plate even though the assigned DRIVER is a different person.
      expect(scopeMatchesAssignment(scope, { driverIds: ['someone-else'], helperIds: [], lorryPlate: 'mcf 3084' })).toBe(true);
      expect(scopeMatchesAssignment(scope, { driverIds: ['someone-else'], helperIds: [], lorryPlate: 'MCF3084' })).toBe(true);
      // Does NOT match another lorry's stop, nor a stop with no lorry plate.
      expect(scopeMatchesAssignment(scope, { driverIds: ['someone-else'], helperIds: [], lorryPlate: 'W 1591 T' })).toBe(false);
      expect(scopeMatchesAssignment(scope, { driverIds: ['someone-else'], helperIds: [], lorryPlate: null })).toBe(false);
      expect(scopeMatchesAssignment(scope, { driverIds: ['someone-else'], helperIds: [], lorryPlate: '' })).toBe(false);
      expect(scopeMatchesAssignment(scope, { driverIds: ['someone-else'], helperIds: [] })).toBe(false);
    }
  });

  test('vehicle overrides name as the plate key when set', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'drv-x', user_id: 51, vehicle: 'W 1591 T', name: 'Some Account' }] }),
      outsourceCaller(51),
    );
    if (scope.mode === 'self') {
      expect([...scope.lorryPlates]).toEqual(['W1591T']);
      expect(scopeMatchesAssignment(scope, { driverIds: [], helperIds: [], lorryPlate: 'W1591T' })).toBe(true);
    }
  });

  test('the driver-id arm still matches alongside the plate arm', async () => {
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'drv-mcf', user_id: 52, vehicle: null, name: 'MCF 3084' }] }),
      outsourceCaller(52),
    );
    if (scope.mode === 'self') {
      // Matched by its own driver id (the linked DRV-017 case), no plate on the stop.
      expect(scopeMatchesAssignment(scope, { driverIds: ['drv-mcf'], helperIds: [] })).toBe(true);
    }
  });

  test('an in-house person driver gets a plate key that matches NO delivery plate', async () => {
    // normalizePlate("ABD KHALID BIN TA ARIF") is a non-plate string; it must not
    // widen a person driver by accident. Driver-id scoping is unchanged.
    const scope = await resolveDeliveryScope(
      fakeSb({ drivers: [{ id: 'drv-person', user_id: 53, vehicle: null, name: 'ABD KHALID BIN TA ARIF' }] }),
      { id: 53, position_name: 'Driver', department_name: 'Operation' },
    );
    if (scope.mode === 'self') {
      expect(scopeMatchesAssignment(scope, { driverIds: ['other'], helperIds: [], lorryPlate: 'MCF3084' })).toBe(false);
      expect(scopeMatchesAssignment(scope, { driverIds: ['drv-person'], helperIds: [] })).toBe(true);
    }
  });

  test('an UNLINKED fleet login has NO plates and matches nothing (still fail-closed)', async () => {
    const scope = await resolveDeliveryScope(fakeSb({ drivers: [], helpers: [] }), outsourceCaller(99));
    expect(scope.mode).toBe('self');
    if (scope.mode === 'self') {
      expect(scope.lorryPlates.size).toBe(0);
      expect(scopeMatchesAssignment(scope, { driverIds: ['x'], helperIds: [], lorryPlate: 'MCF3084' })).toBe(false);
    }
  });
});

describe('scopeMatchesAssignment', () => {
  const selfScope: DeliveryScope = {
    mode: 'self',
    driverIds: new Set(['drv-1']),
    helperIds: new Set(['hlp-1', 'hlp-2']),
    lorryPlates: new Set(),
  };

  test('lorry-plate arm: a plate in scope matches a job on that plate (canonicalised)', () => {
    const plateScope: DeliveryScope = {
      mode: 'self', driverIds: new Set(), helperIds: new Set(), lorryPlates: new Set(['MCF3084']),
    };
    expect(scopeMatchesAssignment(plateScope, { driverIds: [], helperIds: [], lorryPlate: 'MCF 3084' })).toBe(true);
    expect(scopeMatchesAssignment(plateScope, { driverIds: [], helperIds: [], lorryPlate: 'W1591T' })).toBe(false);
    expect(scopeMatchesAssignment(plateScope, { driverIds: [], helperIds: [], lorryPlate: null })).toBe(false);
  });

  test('a job plate never matches a scope with no plates (person driver)', () => {
    expect(scopeMatchesAssignment(selfScope, { driverIds: ['x'], helperIds: [], lorryPlate: 'MCF3084' })).toBe(false);
  });

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
