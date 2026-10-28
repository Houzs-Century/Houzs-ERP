import { describe, expect, test } from "vitest";
import {
  buildDirectionsUrl,
  parseOptimizedRoute,
  optimizeRoute,
  type RouteStop,
} from "../src/scm/lib/maps";

/* Route optimisation for a delivery trip. The two things that must hold: without
   an API key NOTHING calls Google (no billing), and the parser must reorder the
   stops by Google's waypoint_order and attach the right per-stop ETA — an ETA
   pinned to the wrong stop is worse than no ETA. */

const stops: RouteStop[] = [
  { ref: "s1", address: "A" },
  { ref: "s2", address: "B" },
  { ref: "s3", address: "C" },
];

describe("buildDirectionsUrl", () => {
  test("round trip: all stops are optimised waypoints, destination = origin", () => {
    const url = buildDirectionsUrl("Depot", stops, "KEY", true);
    expect(url).toContain("origin=Depot");
    expect(url).toContain("destination=Depot");
    expect(url).toContain("waypoints=optimize:true|A|B|C");
    expect(url).toContain("key=KEY");
  });

  test("one-way: the last stop is the destination, not a waypoint", () => {
    const url = buildDirectionsUrl("Depot", stops, "KEY", false);
    expect(url).toContain("destination=C");
    expect(url).toContain("waypoints=optimize:true|A|B");
    expect(url).not.toContain("|C");
  });

  test("addresses are URL-encoded", () => {
    const url = buildDirectionsUrl("Depot One", [{ ref: "s", address: "12 Jalan A&B" }], "KEY");
    expect(url).toContain("Depot%20One");
    expect(url).toContain("12%20Jalan%20A%26B");
  });
});

describe("parseOptimizedRoute — reorders by waypoint_order and pins the ETA", () => {
  const body = {
    status: "OK",
    routes: [{
      // Google says visit them C, A, B (indices 2,0,1), then back to depot.
      waypoint_order: [2, 0, 1],
      legs: [
        { distance: { value: 1000 }, duration: { value: 600 } },  // depot -> C
        { distance: { value: 2000 }, duration: { value: 900 } },  // C -> A
        { distance: { value: 1500 }, duration: { value: 300 } },  // A -> B
        { distance: { value: 3000 }, duration: { value: 1200 } }, // B -> depot (round trip)
      ],
    }],
  };

  test("stops come back in the optimised order", () => {
    const r = parseOptimizedRoute(body, stops, true);
    expect(r.ok).toBe(true);
    expect(r.stops.map((s) => s.ref)).toEqual(["s3", "s1", "s2"]);
    expect(r.stops.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  test("ETA is cumulative drive time to each stop, in order", () => {
    const r = parseOptimizedRoute(body, stops, true);
    expect(r.stops[0].etaSecondsFromDepart).toBe(600);          // depot->C
    expect(r.stops[1].etaSecondsFromDepart).toBe(600 + 900);    // +C->A
    expect(r.stops[2].etaSecondsFromDepart).toBe(600 + 900 + 300);
  });

  test("the leg that ARRIVES at a stop is attached to that stop", () => {
    const r = parseOptimizedRoute(body, stops, true);
    expect(r.stops[1].legDistanceMetres).toBe(2000); // C -> A leg on stop A
    expect(r.stops[1].legDurationSeconds).toBe(900);
  });

  test("round trip totals INCLUDE the leg back to the depot", () => {
    const r = parseOptimizedRoute(body, stops, true);
    expect(r.totalDistanceMetres).toBe(1000 + 2000 + 1500 + 3000);
    expect(r.totalDurationSeconds).toBe(600 + 900 + 300 + 1200);
  });

  test("a non-OK status is ok:false, never a garbage order", () => {
    const r = parseOptimizedRoute({ status: "ZERO_RESULTS", routes: [] }, stops, true);
    expect(r.configured).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.stops).toEqual([]);
    expect(r.reason).toContain("ZERO_RESULTS");
  });
});

describe("optimizeRoute — gated behind the key (no billing without it)", () => {
  test("no API key → configured:false and NO fetch", async () => {
    let fetched = false;
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => { fetched = true; return new Response("{}"); };
    try {
      const r = await optimizeRoute({}, { originAddress: "Depot", stops });
      expect(r.configured).toBe(false);
      expect(r.ok).toBe(false);
      expect(fetched).toBe(false); // the whole point: Google is never called
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("with a key but no stops with an address → ok:false, still no fetch", async () => {
    let fetched = false;
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => { fetched = true; return new Response("{}"); };
    try {
      const r = await optimizeRoute({ GOOGLE_MAPS_API_KEY: "KEY" }, { originAddress: "Depot", stops: [{ ref: "s", address: "  " }] });
      expect(r.configured).toBe(true);
      expect(r.ok).toBe(false);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
