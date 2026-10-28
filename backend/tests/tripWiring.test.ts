import { describe, expect, test } from "vitest";
import { tripFieldsFor, type TripWiring } from "../src/scm/routes/delivery-planning";

/* The schedule action commits the header date FIRST, then wires the order onto a
   trip. The wiring returned `{id,trip_no} | null`, and `null` was answering two
   opposite questions:

     "the coordinator did not ask for a trip"     -> correct, nothing to do
     "the coordinator asked and it blew up"       -> a lorry was picked, the date
                                                     is stored, and NO TRIP EXISTS

   Both arrive as `{ ok: true, trip: null }` — identical bytes. The coordinator
   reads that as scheduled, because that is exactly what a header-only schedule
   looks like. Nobody finds out until the lorry does not turn up.

   These tests exist because the collapse is invisible in the type: every state
   agrees on `trip`, so `trip` can never be the thing that tells them apart. */

describe("tripFieldsFor — WIRED", () => {
  test("returns the trip and reports no failure", () => {
    const r = tripFieldsFor({ state: "WIRED", trip: { id: "t1", trip_no: "TRIP-2607-001" } });
    expect(r.trip).toEqual({ id: "t1", trip_no: "TRIP-2607-001" });
    expect(r.tripWiring).toBeUndefined();
  });

  test("a blank trip_no is still WIRED — the echo read is not the wiring", () => {
    // The stop is written and the trip exists; only the label read came back
    // empty. Reporting a failure here would cry wolf about a trip that is fine.
    const r = tripFieldsFor({ state: "WIRED", trip: { id: "t1", trip_no: "" } });
    expect(r.trip).toEqual({ id: "t1", trip_no: "" });
    expect(r.tripWiring).toBeUndefined();
  });
});

describe("tripFieldsFor — NOT_REQUESTED", () => {
  test("trip is null and NOTHING is reported — this null is honest", () => {
    /* A header-only schedule (a date, no lorry). `trip: null` is the whole
       truth here, and the response must stay byte-identical to what it has
       always been, or every existing board client learns a new error. */
    const r = tripFieldsFor({ state: "NOT_REQUESTED" });
    expect(r.trip).toBeNull();
    expect(r.tripWiring).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r, "tripWiring")).toBe(false);
  });
});

describe("tripFieldsFor — FAILED", () => {
  test("trip is null AND the failure is reported", () => {
    const r = tripFieldsFor({ state: "FAILED", reason: "could not create the trip: deadlock detected" });
    expect(r.trip).toBeNull();
    expect(r.tripWiring).toEqual({ failed: true, reason: "could not create the trip: deadlock detected" });
  });

  test("the reason survives — it is the only thing that names what broke", () => {
    // The trip INSERT's `tErr` used to be discarded entirely. A coordinator
    // cannot act on "something went wrong"; they can act on which thing.
    const r = tripFieldsFor({ state: "FAILED", reason: "trip wiring failed: relation does not exist" });
    expect(r.tripWiring?.reason).toContain("relation does not exist");
  });
});

describe("the states never collapse", () => {
  test("NOT_REQUESTED and FAILED both yield trip:null and disagree on tripWiring", () => {
    /* THE TEST THIS FILE IS FOR — the whole bug in one assertion. Both are
       `trip: null`, which is exactly why collapsing them was so easy and so
       quiet. `tripWiring` is the only thing that separates them, so it is the
       only thing a caller may branch on. */
    const notAsked = tripFieldsFor({ state: "NOT_REQUESTED" });
    const failed = tripFieldsFor({ state: "FAILED", reason: "boom" });

    expect(notAsked.trip).toBeNull();
    expect(failed.trip).toBeNull();

    expect(notAsked.tripWiring).toBeUndefined();
    expect(failed.tripWiring).toBeDefined();
  });

  test("a success is never mistaken for a failure and vice versa", () => {
    const wired = tripFieldsFor({ state: "WIRED", trip: { id: "t1", trip_no: "TRIP-2607-002" } });
    const failed = tripFieldsFor({ state: "FAILED", reason: "boom" });
    expect(wired.trip).not.toBeNull();
    expect(failed.trip).toBeNull();
  });

  test("`tripWiring` present implies failed:true — there is no 'reported success'", () => {
    // A truthy `tripWiring` must never mean anything but a failure, or the FE
    // gains a third case to get wrong.
    const states: TripWiring[] = [
      { state: "WIRED", trip: { id: "t", trip_no: "n" } },
      { state: "NOT_REQUESTED" },
      { state: "FAILED", reason: "boom" },
    ];
    for (const s of states) {
      const r = tripFieldsFor(s);
      if (r.tripWiring) expect(r.tripWiring.failed).toBe(true);
    }
  });
});
