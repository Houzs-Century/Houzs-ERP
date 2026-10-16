/* One crew per lorry run (owner 2026-10-07): Delivery Planning, Last Mile and
   the driver's phone must agree on who drives a run. */
import { describe, expect, test } from 'vitest';
import { makeFakePostgrest, type Row } from './fakePostgrest';
import {
  applyScheduleCrew, assignSoCrew, latestLiveDoIdForSo, propagateDoCrewToTrip, setAssrLegCrew, staleRunOfSo, syncTripCrewToDos,
} from '../src/scm/lib/trip-crew-sync';

function db(extra: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    trips: [{ id: 't1', company_id: 1, trip_date: '2026-10-08', status: 'PLANNED', lorry_id: 'l1', driver_id: 'd1', helper_1_id: 'h1', helper_2_id: null }],
    trip_stops: [
      { id: 's1', trip_id: 't1', do_id: 'do-a', stop_type: 'DELIVERY', created_at: '1' },
      { id: 's2', trip_id: 't1', do_id: 'do-b', stop_type: 'DELIVERY', created_at: '2' },
      { id: 's3', trip_id: 't1', do_id: 'do-x', stop_type: 'DELIVERY', created_at: '3' },
    ],
    delivery_orders: [
      { id: 'do-a', company_id: 1, so_doc_no: 'SO-1', status: 'CONFIRMED', created_at: '1' },
      { id: 'do-b', company_id: 1, so_doc_no: 'SO-2', status: 'CONFIRMED', created_at: '1' },
      // another company's DO riding the same run is never written
      { id: 'do-x', company_id: 2, so_doc_no: 'SO-9', status: 'CONFIRMED', created_at: '1' },
      { id: 'do-old', company_id: 1, so_doc_no: 'SO-1', status: 'CANCELLED', created_at: '0' },
    ],
    delivery_order_crew: [],
    drivers: [
      { id: 'd1', name: 'Ali', ic_number: '900101', phone: '0123456789', vehicle: null },
      { id: 'd2', name: 'Bala', ic_number: null, phone: null, vehicle: null },
    ],
    helpers: [{ id: 'h1', name: 'Chong', contact: null }, { id: 'h2', name: 'Dev', contact: null }],
    lorries: [{ id: 'l1', plate: 'VAA1234' }],
    ...extra,
  };
  return makeFakePostgrest(tables, []);
}
const crewOf = (f: ReturnType<typeof db>, doId: string) => {
  const rows = f.tables.delivery_order_crew!.filter((r) => r.do_id === doId);
  return rows[rows.length - 1];
};

describe('trip crew sync', () => {
  test('the latest live DO of an order is found, never a cancelled one', async () => {
    expect(await latestLiveDoIdForSo(db(), 1, 'SO-1')).toBe('do-a');
    expect(await latestLiveDoIdForSo(db(), 1, 'SO-404')).toBeNull();
  });

  test("a run's crew lands on every DO it carries of the run's own company", async () => {
    const f = db();
    expect(await syncTripCrewToDos(f, 't1', null, 'stf-1')).toBe(2);
    expect(crewOf(f, 'do-a')).toMatchObject({ driver_1_id: 'd1', driver_1_name: 'Ali', helper_1_name: 'Chong', lorry_plate: 'VAA1234' });
    expect(crewOf(f, 'do-b')).toMatchObject({ driver_1_id: 'd1' });
    expect(crewOf(f, 'do-x')).toBeUndefined();
    expect(f.tables.delivery_orders!.find((d) => d.id === 'do-a')).toMatchObject({ driver_id: 'd1', driver_name: 'Ali' });
  });

  test('a DO crew edit moves the run and the other DOs on it', async () => {
    const f = db();
    const seats = { driver1Id: 'd2', driver2Id: null, helper1Id: 'h2', helper2Id: null, lorryId: 'l1' };
    expect(await propagateDoCrewToTrip(f, 'do-a', seats, 'stf-1')).toBe('t1');
    expect(f.tables.trips![0]).toMatchObject({ driver_id: 'd2', helper_1_id: 'h2' });
    expect(crewOf(f, 'do-b')).toMatchObject({ driver_1_id: 'd2', helper_1_name: 'Dev' });
    expect(crewOf(f, 'do-a')).toBeUndefined(); // the caller already wrote its own DO
  });

  test('a DO on no run changes nothing else', async () => {
    const f = db({ trip_stops: [] });
    const seats = { driver1Id: 'd2', driver2Id: null, helper1Id: null, helper2Id: null, lorryId: null };
    expect(await propagateDoCrewToTrip(f, 'do-a', seats, null)).toBeNull();
    expect(f.tables.trips![0]!.driver_id).toBe('d1');
  });

  test('a driver picked on Delivery Planning (no lorry) goes to the order DO and its run, keeping the other seats', async () => {
    const f = db({ delivery_order_crew: [{ do_id: 'do-a', driver_1_id: 'd1', driver_2_id: null, helper_1_id: 'h1', helper_2_id: null, lorry_id: 'l1' }] });
    expect(await assignSoCrew(f, 1, 'SO-1', { driverId: 'd2' }, 'stf-1')).toEqual({ doId: 'do-a', tripId: 't1' });
    expect(crewOf(f, 'do-a')).toMatchObject({ driver_1_id: 'd2', helper_1_id: 'h1', lorry_id: 'l1' });
    expect(f.tables.trips![0]!.driver_id).toBe('d2');
    expect(crewOf(f, 'do-b')).toMatchObject({ driver_1_id: 'd2' });
  });

  test('an order with no DO has no crew to write', async () => {
    expect(await assignSoCrew(db(), 1, 'SO-404', { driverId: 'd2' }, null)).toBeNull();
  });

  test('a schedule naming a driver sets it on an existing run too, then the run reaches its DOs', async () => {
    const f = db();
    await applyScheduleCrew(f, 't1', { driverId: 'd2' }, 'stf-1');
    expect(f.tables.trips![0]!.driver_id).toBe('d2');
    expect(crewOf(f, 'do-a')).toMatchObject({ driver_1_id: 'd2', helper_1_id: 'h1' });
  });

  test('a Service Case driver edit changes only the run carrying that leg', async () => {
    const f = db({
      trips: [
        { id: 'tp', company_id: 1, driver_id: null, helper_1_id: null, helper_2_id: null },
        { id: 'td', company_id: 1, driver_id: null, helper_1_id: null, helper_2_id: null },
      ],
      trip_stops: [
        { id: 'a', trip_id: 'tp', assr_case_id: 31, stop_type: 'PICKUP', created_at: '1' },
        { id: 'b', trip_id: 'td', assr_case_id: 31, stop_type: 'SERVICE', created_at: '1' },
      ],
    });
    expect(await setAssrLegCrew(f, 31, 'delivery', { driverId: 'd1' })).toBe('td');
    expect(f.tables.trips!.find((t) => t.id === 'td')!.driver_id).toBe('d1');
    expect(f.tables.trips!.find((t) => t.id === 'tp')!.driver_id).toBeNull();
    expect(await setAssrLegCrew(f, 31, 'inspection', { driverId: 'd1' })).toBeNull();
  });

  test('a date moved off the run day carries the lorry, and the crew only when that lorry has no run that day', async () => {
    expect(await staleRunOfSo(db(), 1, 'SO-1', '2026-10-08')).toBeNull();
    expect(await staleRunOfSo(db(), 1, 'SO-1', '2026-10-09')).toEqual({ lorryId: 'l1', driverId: 'd1', helper1Id: 'h1', helper2Id: null });
    const busy = db();
    busy.tables.trips!.push({ id: 't2', company_id: 1, trip_date: '2026-10-09', status: 'PLANNED', lorry_id: 'l1', driver_id: 'd2' });
    expect(await staleRunOfSo(busy, 1, 'SO-1', '2026-10-09')).toEqual({ lorryId: 'l1' });
  });
});
