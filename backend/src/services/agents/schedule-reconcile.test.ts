import { describe, it, expect } from "vitest";
import { normDate, venueMatch, reconcileSchedule, type ProjRow, type SchedExtract } from "./schedule-reconcile";

describe("normDate", () => {
  it("normalises DD/MM/YYYY, D/M/YY, and passes YYYY-MM-DD", () => {
    expect(normDate("13/03/2026")).toBe("2026-03-13");
    expect(normDate("5/7/26")).toBe("2026-07-05");
    expect(normDate("2026-4-9")).toBe("2026-04-09");
    expect(normDate("")).toBeNull();
    expect(normDate("next week")).toBeNull();
  });
});

describe("venueMatch", () => {
  it("matches on canonical containment, ignoring case/punctuation/truncation", () => {
    expect(venueMatch("Sutera Mall", "SUTERA MALL")).toBe(true);
    expect(venueMatch("The Commune Kulai", "COMMUNE KULAI")).toBe(true);
    expect(venueMatch("Pavilion Bukit Jali", "Pavilion Bukit Jalil")).toBe(true); // truncated
    expect(venueMatch("Sutera Mall", "IOI Mall")).toBe(false);
    expect(venueMatch("", "x")).toBe(false);
  });
});

// IN HOME EXPO example: 2 venues. System has both projects; the organizer's new
// schedule postpones Sutera (date change), keeps Commune, and drops a 3rd venue.
const projects: ProjRow[] = [
  { id: 1, code: "P-CMN", name: "IN HOME @ Commune", venue: "The Commune Kulai", startDate: "13/03/2026", endDate: "15/03/2026", stage: "draft" },
  { id: 2, code: "P-SUT", name: "IN HOME @ Sutera", venue: "Sutera Mall", startDate: "03/04/2026", endDate: "05/04/2026", stage: "draft" },
  { id: 3, code: "P-OLD", name: "IN HOME @ Old Venue", venue: "Dropped Mall", startDate: "20/05/2026", endDate: "22/05/2026", stage: "confirmed" },
];

const extract: SchedExtract = {
  organizer: "IN HOME EXPO",
  events: [
    { venue: "The Commune Kulai", startDate: "2026-03-13", endDate: "2026-03-15" }, // unchanged
    { venue: "Sutera Mall", startDate: "2026-04-10", endDate: "2026-04-12" },       // postponed a week
    { venue: "New Venue Mall", startDate: "2026-06-05", endDate: "2026-06-07" },    // brand-new event
  ],
};

describe("reconcileSchedule", () => {
  const rows = reconcileSchedule(extract, projects);
  const byVenue = (v: string) => rows.find((r) => r.venue === v)!;

  it("MATCH when the schedule dates equal the project dates (format-insensitive)", () => {
    expect(byVenue("The Commune Kulai").status).toBe("MATCH");
    expect(byVenue("The Commune Kulai").project?.id).toBe(1);
  });

  it("DATE_CHANGED when the schedule moved the dates", () => {
    const r = byVenue("Sutera Mall");
    expect(r.status).toBe("DATE_CHANGED");
    expect(r.project?.id).toBe(2);
    expect(r.scheduleStart).toBe("2026-04-10"); // vs project 03/04
  });

  it("NEW when the schedule has a venue with no project", () => {
    expect(byVenue("New Venue Mall").status).toBe("NEW");
    expect(byVenue("New Venue Mall").project).toBeNull();
  });

  it("MISSING for a live project the latest schedule dropped (postponed/cancelled?)", () => {
    const r = rows.find((x) => x.status === "MISSING")!;
    expect(r.project?.id).toBe(3);
  });

  it("does not flag an already-cancelled/closed project as MISSING", () => {
    const withClosed = [...projects, { id: 4, code: "P-DONE", name: "done", venue: "Gone Mall", startDate: "01/01/2026", endDate: "02/01/2026", stage: "closed" }];
    const r2 = reconcileSchedule(extract, withClosed);
    expect(r2.some((x) => x.status === "MISSING" && x.project?.id === 4)).toBe(false);
  });
});
