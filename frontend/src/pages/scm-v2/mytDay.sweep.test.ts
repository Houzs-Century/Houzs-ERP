/* Two scm-v2 date rules that read the device's own zone before:
   - Payment Corrections' month picker starts at THIS month. At 01:30 on 1 Dec
     (Malaysia) that is December, even on a machine whose clock zone is UTC.
   - The stock movement date filter buckets a movement by the day the WHEN
     column shows, which is the Malaysian day (fmtDateTime).
   Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentMonths } from "./PaymentCorrectionsTab";
import { filterMovements, movementDateKey, EMPTY_MOVEMENT_FILTER } from "./stockMovementFilter";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("Payment Corrections month list starts at the Malaysian month", () => {
  it("at 01:30 on 1 Dec (Malaysia) the first month is December", () => {
    vi.setSystemTime(new Date("2026-11-30T17:30:00Z"));
    expect(recentMonths().slice(0, 2)).toEqual(["2026-12", "2026-11"]);
  });
  it("at 23:59 on 30 Nov (Malaysia) it is still November", () => {
    vi.setSystemTime(new Date("2026-11-30T15:59:00Z"));
    expect(recentMonths()[0]).toBe("2026-11");
  });
  it("a passed day crosses the year", () => {
    expect(recentMonths("2027-01-05", 3)).toEqual(["2027-01", "2026-12", "2026-11"]);
  });
});

describe("stock movement filter buckets by the Malaysian day", () => {
  it("a movement at 01:30 on the 10th (Malaysia) is the 10th", () => {
    expect(movementDateKey("2026-11-09T17:30:00Z")).toBe("2026-11-10");
    expect(movementDateKey("2026-11-09T17:30:00+00:00")).toBe("2026-11-10");
  });
  it("23:59 on the 9th (Malaysia) is the 9th", () => {
    expect(movementDateKey("2026-11-09T15:59:00Z")).toBe("2026-11-09");
  });
  it("a From/To of the 10th keeps 00:30 on the 10th and drops 00:00 on the 11th", () => {
    const row = (id: string, created_at: string) =>
      ({ id, movement_type: "IN", warehouse_id: "kl", source_doc_no: null, created_at }) as const;
    const rows = [row("a", "2026-11-09T16:30:00Z"), row("b", "2026-11-10T16:00:00Z"), row("c", "2026-11-09T15:59:00Z")];
    const kept = filterMovements(rows, { ...EMPTY_MOVEMENT_FILTER, dateFrom: "2026-11-10", dateTo: "2026-11-10" });
    expect(kept.map((r) => r.id)).toEqual(["a"]);
  });
  it("an unreadable time is ''", () => {
    expect(movementDateKey("not-a-date")).toBe("");
    expect(movementDateKey(null)).toBe("");
  });
});
