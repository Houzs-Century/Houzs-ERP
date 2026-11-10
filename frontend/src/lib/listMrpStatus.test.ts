import { describe, expect, it } from "vitest";
import { combineListMrpMeta, listMrpLabel, withListMrpRefresh, type ListMrpMeta } from "./listMrpStatus";

/* The lists read the 15-min stored MRP plan and say how old it is (owner
   2026-11-10). A page fetches in chunks; these pin the one line it shows. */

const snap = (asOf: string): ListMrpMeta => ({ asOf, source: "snapshot", fallback: null, failed: false });

describe("combineListMrpMeta", () => {
  it("is null until a chunk answers (or the backend predates the field)", () => {
    expect(combineListMrpMeta([])).toBeNull();
    expect(combineListMrpMeta([undefined, null])).toBeNull();
  });

  it("shows the OLDEST time across chunks", () => {
    const got = combineListMrpMeta([snap("2026-11-10T06:15:00.000Z"), snap("2026-11-10T06:00:00.000Z")]);
    expect(got).toEqual(snap("2026-11-10T06:00:00.000Z"));
  });

  it("a stale chunk wins: the page must say it computed live", () => {
    const stale: ListMrpMeta = { asOf: "2026-11-10T06:20:00.000Z", source: "live", fallback: "stale", failed: false };
    const got = combineListMrpMeta([snap("2026-11-10T06:00:00.000Z"), stale]);
    expect(got).toEqual({ asOf: "2026-11-10T06:00:00.000Z", source: "live", fallback: "stale", failed: false });
  });

  it("any failed chunk marks the page failed", () => {
    const failed: ListMrpMeta = { asOf: null, source: "live", fallback: "missing", failed: true };
    expect(combineListMrpMeta([snap("2026-11-10T06:00:00.000Z"), failed])?.failed).toBe(true);
  });
});

describe("listMrpLabel", () => {
  const at = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

  it("a fresh snapshot or a refresh reads 'MRP as of hh:mm'", () => {
    expect(listMrpLabel(snap("2026-11-10T06:05:00.000Z"))).toEqual({ text: `MRP as of ${at("2026-11-10T06:05:00.000Z")}`, warn: false });
    expect(listMrpLabel({ asOf: "2026-11-10T06:05:00.000Z", source: "live", fallback: "refresh", failed: false }).warn).toBe(false);
  });

  it("a live fallback says why, as a warning", () => {
    expect(listMrpLabel({ asOf: "2026-11-10T06:05:00.000Z", source: "live", fallback: "stale", failed: false }))
      .toEqual({ text: `MRP live at ${at("2026-11-10T06:05:00.000Z")} (stored plan over 30 min old)`, warn: true });
    expect(listMrpLabel({ asOf: "2026-11-10T06:05:00.000Z", source: "live", fallback: "missing", failed: false }))
      .toEqual({ text: `MRP live at ${at("2026-11-10T06:05:00.000Z")} (no stored plan)`, warn: true });
  });

  it("a failed run says the columns may be blank", () => {
    expect(listMrpLabel({ asOf: null, source: "live", fallback: "missing", failed: true }).warn).toBe(true);
  });
});

describe("withListMrpRefresh", () => {
  it("adds refresh=1 only while a Refresh is in flight", () => {
    expect(withListMrpRefresh("/x?poIds=a", false)).toBe("/x?poIds=a");
    expect(withListMrpRefresh("/x?poIds=a", true)).toBe("/x?poIds=a&refresh=1");
  });
});
