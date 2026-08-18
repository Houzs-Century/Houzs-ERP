import { describe, expect, test } from "vitest";
import {
  assembleDayView,
  type AssembleInput, type RawTripRow, type RawStopRow,
  type StopEnrichment, type MasterName, type MasterLorry, type MasterWarehouse, type LatLng,
} from "../src/scm/lib/fleet-day-view";

/* PURE ASSEMBLER behind GET /trips/day (Fleet A4 day-view + run-sheet).
 *
 * The DB reads (trips, stops, do->so resolution, residence-rule windows, geocode
 * cache, masters) live in the route handler; this suite pins the deterministic
 * SHAPING they feed: grouping stops to trips, ordering by stop_no, drop/revenue
 * totals, the enrichment merge, depot resolution and the honest `geocoded` flag.
 * No DB, no Google key — everything below is data in, model out. */

function baseInput(over: Partial<AssembleInput> = {}): AssembleInput {
  const empty = {
    trips: [] as RawTripRow[],
    stops: [] as RawStopRow[],
    driversById: new Map<string, MasterName>(),
    helpersById: new Map<string, MasterName>(),
    lorriesById: new Map<string, MasterLorry>(),
    warehousesById: new Map<string, MasterWarehouse>(),
    enrichByStopId: new Map<string, StopEnrichment>(),
    geoByStopId: new Map<string, LatLng>(),
    depotByWarehouseId: new Map<string, LatLng>(),
  };
  return { ...empty, ...over };
}

const trip = (over: Partial<RawTripRow> & { id: string }): RawTripRow => ({
  trip_no: over.id, trip_date: "2026-07-26", status: "PLANNED", is_outsourced: false,
  lorry_id: null, driver_id: null, helper_1_id: null, helper_2_id: null,
  warehouse_id: null, total_distance_km: null, ...over,
});

const stop = (over: Partial<RawStopRow> & { id: string; trip_id: string }): RawStopRow => ({
  stop_no: 1, stop_type: "DELIVERY", do_id: null, so_id: null,
  customer_name: null, address: null, revenue_sen: 0, eta_offset_s: null, leg_distance_m: null,
  ...over,
});

const noEnrich: StopEnrichment = { phone: null, houseType: null, earliestTime: null, latestTime: null, accessNote: null };

describe("assembleDayView", () => {
  test("groups stops to their trip and orders by stop_no (null sorts last)", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1" })],
      stops: [
        stop({ id: "s3", trip_id: "T1", stop_no: 3 }),
        stop({ id: "s1", trip_id: "T1", stop_no: 1 }),
        stop({ id: "sN", trip_id: "T1", stop_no: null }),
        stop({ id: "s2", trip_id: "T1", stop_no: 2 }),
      ],
    }));
    expect(out.trips).toHaveLength(1);
    expect(out.trips[0].stops.map((s) => s.id)).toEqual(["s1", "s2", "s3", "sN"]);
    // A null stop_no is renumbered by position, never dropped.
    expect(out.trips[0].stops[3].stop_no).toBe(4);
  });

  test("total_drops counts DELIVERY stops only; revenue sums every stop", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1" })],
      stops: [
        stop({ id: "d1", trip_id: "T1", stop_no: 1, stop_type: "DELIVERY", revenue_sen: 10_00 }),
        stop({ id: "p1", trip_id: "T1", stop_no: 2, stop_type: "SUPPLIER_PICKUP", revenue_sen: 5_00 }),
        stop({ id: "d2", trip_id: "T1", stop_no: 3, stop_type: "DELIVERY", revenue_sen: 20_00 }),
      ],
    }));
    expect(out.trips[0].total_drops).toBe(2);
    expect(out.trips[0].total_revenue_sen).toBe(3500);
  });

  test("negative / non-finite revenue is floored to 0 per stop", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1" })],
      stops: [
        stop({ id: "a", trip_id: "T1", stop_no: 1, revenue_sen: -100 }),
        stop({ id: "b", trip_id: "T1", stop_no: 2, revenue_sen: null }),
        stop({ id: "c", trip_id: "T1", stop_no: 3, revenue_sen: 12_34 }),
      ],
    }));
    expect(out.trips[0].total_revenue_sen).toBe(1234);
    expect(out.trips[0].stops[0].revenue_sen).toBe(0);
  });

  test("merges enrichment (phone / house type / window / access note) onto stops", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1" })],
      stops: [stop({ id: "s1", trip_id: "T1", customer_name: "Ali", address: "12 Jln A" })],
      enrichByStopId: new Map([["s1", {
        phone: "012-3456789", houseType: "Condo",
        earliestTime: "10:00", latestTime: "17:00", accessNote: "Lift booking required",
      }]]),
    }));
    const s = out.trips[0].stops[0];
    expect(s).toMatchObject({
      customer_name: "Ali", address: "12 Jln A", phone: "012-3456789",
      house_type: "Condo", earliest_time: "10:00", latest_time: "17:00", access_note: "Lift booking required",
    });
  });

  test("a stop with no enrichment keeps its snapshot and shows blanks", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1" })],
      stops: [stop({ id: "s1", trip_id: "T1", customer_name: "Bob", address: "9 Jln B" })],
    }));
    const s = out.trips[0].stops[0];
    expect(s.customer_name).toBe("Bob");
    expect(s.phone).toBeNull();
    expect(s.house_type).toBeNull();
    expect(s.earliest_time).toBeNull();
  });

  test("geocoded flag + lat/lng only when a point resolved (no fabricated 0,0)", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1" })],
      stops: [
        stop({ id: "hit", trip_id: "T1", stop_no: 1 }),
        stop({ id: "miss", trip_id: "T1", stop_no: 2 }),
      ],
      geoByStopId: new Map([["hit", { lat: 3.1, lng: 101.6 }]]),
    }));
    const [a, b] = out.trips[0].stops;
    expect(a).toMatchObject({ geocoded: true, lat: 3.1, lng: 101.6 });
    expect(b).toMatchObject({ geocoded: false, lat: null, lng: null });
  });

  test("resolves lorry / driver / helpers / warehouse / depot from the masters", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({
        id: "T1", lorry_id: "L1", driver_id: "D1", helper_1_id: "H1", helper_2_id: "H2", warehouse_id: "W1",
      })],
      lorriesById: new Map([["L1", { id: "L1", plate: "WXY 1234" }]]),
      driversById: new Map([["D1", { id: "D1", name: "Driver One" }]]),
      helpersById: new Map([["H1", { id: "H1", name: "Helper One" }], ["H2", { id: "H2", name: "Helper Two" }]]),
      warehousesById: new Map([["W1", { id: "W1", name: "KL Depot", code: "KL" }]]),
      depotByWarehouseId: new Map([["W1", { lat: 3.0, lng: 101.5 }]]),
    }));
    const t = out.trips[0];
    expect(t.lorry).toEqual({ id: "L1", plate: "WXY 1234" });
    expect(t.driver).toEqual({ id: "D1", name: "Driver One" });
    expect(t.helpers.map((h) => h.name)).toEqual(["Helper One", "Helper Two"]);
    expect(t.warehouse).toEqual({ id: "W1", name: "KL Depot", code: "KL" });
    expect(t.depot).toEqual({ lat: 3.0, lng: 101.5 });
  });

  test("unknown / missing master ids resolve to null, never throw", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1", lorry_id: "ghost", driver_id: null, warehouse_id: "nope" })],
    }));
    const t = out.trips[0];
    expect(t.lorry).toBeNull();
    expect(t.driver).toBeNull();
    expect(t.helpers).toEqual([]);
    expect(t.warehouse).toBeNull();
    expect(t.depot).toBeNull();
  });

  test("trips come back ordered by trip_no (deterministic for colour assignment)", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "TRIP-2607-003" }), trip({ id: "TRIP-2607-001" }), trip({ id: "TRIP-2607-002" })],
    }));
    expect(out.trips.map((t) => t.trip_no)).toEqual(["TRIP-2607-001", "TRIP-2607-002", "TRIP-2607-003"]);
  });

  test("status and is_outsourced are normalised", () => {
    const out = assembleDayView(baseInput({
      trips: [trip({ id: "T1", status: "in_progress", is_outsourced: true })],
    }));
    expect(out.trips[0].status).toBe("IN_PROGRESS");
    expect(out.trips[0].is_outsourced).toBe(true);
  });
});
