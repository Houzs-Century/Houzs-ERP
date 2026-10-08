import { describe, expect, test } from "vitest";
import { vehiclePositionsFrom } from "./vehicle-positions";
import { mytClock, stopStatusByRef } from "./delivery-stop-status";

const fix = (tripId: string, recordedAt: string, lat = 3.1) =>
  ({ tripId, driverId: null, lat, lng: 101.6, accuracyM: 10, recordedAt, receivedAt: recordedAt });

describe("vehiclePositionsFrom", () => {
  test("one marker per run, at its newest fix, labelled with the plate", () => {
    const runs = [{ id: "t1", lorry: { id: "l1", plate: "VAA1234" } }, { id: "t2", lorry: null, driver: { name: "Ali" } }];
    const out = vehiclePositionsFrom([
      fix("t1", "2026-10-08T02:00:00Z", 3.0),
      fix("t1", "2026-10-08T02:05:00Z", 3.2),
      fix("t2", "2026-10-08T02:01:00Z"),
      fix("t-other", "2026-10-08T02:01:00Z"), // a run not on this page is not drawn
    ], runs);
    expect(out).toHaveLength(2);
    expect(out.find((v) => v.tripId === "t1")).toMatchObject({ key: "l1", lorryId: "l1", label: "VAA1234", lat: 3.2, source: "phone" });
    expect(out.find((v) => v.tripId === "t2")).toMatchObject({ lorryId: null, label: "Ali" });
  });
});

describe("stopStatusByRef", () => {
  test("uses Malaysia's clock, not the browser's", () => {
    // 16:30 UTC is 00:30 the next day in Malaysia
    expect(mytClock(new Date("2026-10-07T16:30:00Z"))).toEqual({ today: "2026-10-08", nowMinutes: 30 });
  });

  test("keys every stop by its board ref", () => {
    const rows = [
      { so_doc_no: "SO-1", delivery_orders: [{ status: "DELIVERED" }] },
      { so_doc_no: "DP:9", time_range: "9-12" },
    ];
    const m = stopStatusByRef(rows, (r) => (r.so_doc_no === "DP:9" ? { departed_at: "x" } : null), "2026-10-08", new Date("2026-10-08T06:00:00Z"));
    expect(m.get("SO-1")).toBe("done");
    expect(m.get("DP:9")).toBe("active");
  });
});
