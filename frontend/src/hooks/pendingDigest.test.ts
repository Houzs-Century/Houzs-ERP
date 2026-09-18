import { describe, it, expect } from "vitest";
import { buildDigest, localToday, seenKey, tierFor, type PendingRow } from "./pendingDigest";

const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  id: 1,
  name: "PULAU PINANG [DUNLOPILLO] HOMELOVE @ SETIA SPICE",
  start_date: "2026-09-20",
  end_date: "2026-09-22",
  ...over,
});

const TODAY = "2026-09-09";

describe("tierFor — the event's own dates decide the bucket", () => {
  it("an event that already ENDED is the worst bucket", () => {
    // The owner's case: "kalau dah lepas event dia still x buat".
    expect(tierFor(row({ start_date: "2026-09-01", end_date: "2026-09-03" }), TODAY))
      .toBe("past_event");
  });

  it("an event ending TODAY is not past yet", () => {
    // Local date, not UTC — a same-day event must not read as finished.
    expect(tierFor(row({ start_date: "2026-09-07", end_date: TODAY }), TODAY)).toBe("this_week");
  });

  it("starting within 7 days is the urgent bucket, day 8 is not", () => {
    expect(tierFor(row({ start_date: "2026-09-16", end_date: "2026-09-18" }), TODAY))
      .toBe("this_week");
    expect(tierFor(row({ start_date: "2026-09-17", end_date: "2026-09-19" }), TODAY))
      .toBe("later");
  });

  it("falls back to start_date when the event has no end", () => {
    expect(tierFor(row({ start_date: "2026-09-01", end_date: null }), TODAY)).toBe("past_event");
  });
});

describe("buildDigest", () => {
  it("orders groups worst-first and reports the worst tier", () => {
    const d = buildDigest(
      [
        row({ id: 1, start_date: "2026-10-20", end_date: "2026-10-22" }), // later
        row({ id: 2, start_date: "2026-08-30", end_date: "2026-09-01" }), // past
        row({ id: 3, start_date: "2026-09-11", end_date: "2026-09-13" }), // this week
      ],
      TODAY,
    );
    expect(d.groups.map((g) => g.tier)).toEqual(["past_event", "this_week", "later"]);
    expect(d.worst).toBe("past_event");
    expect(d.total).toBe(3);
  });

  it("collects the owed task titles, deduped across events", () => {
    const d = buildDigest(
      [
        row({ id: 1, my_pending_titles: "Stock In Transfer Record|Defect List" }),
        row({ id: 2, my_pending_titles: "Stock In Transfer Record" }),
      ],
      TODAY,
    );
    expect(d.groups[0].titles).toEqual(["Stock In Transfer Record", "Defect List"]);
  });

  it("survives a lane that sends no titles at all", () => {
    // my_pending_titles is only built for SOME lanes; the event must still count.
    const d = buildDigest([row({ my_pending_titles: null })], TODAY);
    expect(d.total).toBe(1);
    expect(d.groups[0].titles).toEqual([]);
  });

  it("nothing pending = nothing to nag about", () => {
    const d = buildDigest([], TODAY);
    expect(d.total).toBe(0);
    expect(d.worst).toBeNull();
    expect(d.mustAcknowledge).toBe(false);
  });

  it("past-event and this-week may NOT be postponed; later may", () => {
    const past = buildDigest([row({ start_date: "2026-09-01", end_date: "2026-09-02" })], TODAY);
    const soon = buildDigest([row({ start_date: "2026-09-11", end_date: "2026-09-13" })], TODAY);
    const later = buildDigest([row({ start_date: "2026-11-01", end_date: "2026-11-03" })], TODAY);
    expect(past.mustAcknowledge).toBe(true);
    expect(soon.mustAcknowledge).toBe(true);
    expect(later.mustAcknowledge).toBe(false);
  });
});

describe("seenKey — the reminder returns by itself tomorrow", () => {
  it("is per user AND per day", () => {
    expect(seenKey("pending-digest:u7:c1", "2026-09-09")).toBe("pending-digest:u7:c1:2026-09-09");
    expect(seenKey("pending-digest:u7:c1", "2026-09-10")).not.toBe(
      seenKey("pending-digest:u7:c1", "2026-09-09"),
    );
  });

  it("is null before the identity is known, so nothing is written anonymously", () => {
    expect(seenKey(null)).toBeNull();
  });
});

describe("localToday", () => {
  it("reads the LOCAL calendar date, not the UTC one", () => {
    // 2026-09-09 08:30 Malaysia is still 2026-09-09 00:30 UTC — same day here,
    // but the reverse (late evening MYT) is the case that used to slip a day.
    const lateEvening = new Date(2026, 8, 9, 23, 30, 0);
    expect(localToday(lateEvening)).toBe("2026-09-09");
  });
});
