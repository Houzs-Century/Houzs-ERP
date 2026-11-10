// 2026-11-10: a crew save that succeeded, then a board reload that timed out or
// came back stale, showed "— none —". The save's own answer stays on the row
// until a board read agrees with it.
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetSavedCrew, rememberSavedCrew, withSavedCrew } from './saved-crew';
import type { PlanningOrder } from './delivery-planning-queries';

const row = (doId: string, crew: PlanningOrder['crew']) =>
  ({ so_doc_no: '2990-SO-2610-009', delivery_orders: [{ id: 'old-do' }, { id: doId }], crew }) as unknown as PlanningOrder;
const SAVED = { driver_1_name: 'SHAMSUL', driver_1_ic: '930428-10-5331', driver_1_contact: '+601131928090', lorry_plate: 'VQE9058' };

beforeEach(() => forgetSavedCrew());

describe('withSavedCrew', () => {
  it('lays the saved crew over a stale board read of the same DO', () => {
    rememberSavedCrew('do-1', SAVED, 1_000);
    const out = withSavedCrew({ orders: [row('do-1', null)] }, 2_000);
    expect(out.orders[0]!.crew).toMatchObject({ driver_1_name: 'SHAMSUL', driver_1_ic: '930428-10-5331', lorry_plate: 'VQE9058' });
  });

  it('lets the board win once it returns the same people, and forgets the override', () => {
    rememberSavedCrew('do-1', SAVED, 1_000);
    const fresh = { orders: [row('do-1', { ...withSavedCrew({ orders: [row('do-1', null)] }, 1_500).orders[0]!.crew!, driver_1_contact: '+60 11-3192 8090' })] };
    expect(withSavedCrew(fresh, 2_000)).toBe(fresh);
    // Forgotten: a later read that clears the driver (someone removed it) is shown as is.
    const cleared = { orders: [row('do-1', null)] };
    expect(withSavedCrew(cleared, 3_000)).toBe(cleared);
  });

  it('only touches the row whose LAST DO was saved, and expires', () => {
    rememberSavedCrew('do-1', SAVED, 0);
    const other = { orders: [row('do-2', null)] };
    expect(withSavedCrew(other, 1)).toBe(other);
    const late = { orders: [row('do-1', null)] };
    expect(withSavedCrew(late, 6 * 60_000)).toBe(late);
  });
});
