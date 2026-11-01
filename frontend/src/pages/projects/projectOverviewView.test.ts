/* What Project Overview remembers in its URL, and how its project table reads
   (owner 2026-10-21). */
import { describe, expect, it, vi } from "vitest";
import {
  VIEW_PARAMS, decodeDrill, encodeDrill, projectLines, projectBackTo, readView, rememberOpenedFrom, tableAmount, takeScroll, writeView,
} from "./projectOverviewView";

const TODAY = "2026-10-21";

describe("the overview's choices in the URL", () => {
  it("a plain URL — the menu link — is the defaults: Newest, no filter, the trend on this year by month", () => {
    expect(readView(new URLSearchParams(""), TODAY)).toEqual({
      sort: "start", brand: "", type: "", organizer: "", venue: "", state: "", stage: "", dim: "brand", pick: null, drill: { level: "yearMonths", year: 2026 },
    });
  });

  it("venue, state and stage are kept in the URL like the other filters (owner 2026-11-01)", () => {
    const p = writeView(new URLSearchParams(""), { venue: "MID VALLEY", state: "Selangor", stage: "" }, TODAY);
    expect(readView(p, TODAY)).toMatchObject({ venue: "MID VALLEY", state: "Selangor", stage: "" });
    expect(p.has(VIEW_PARAMS.stage)).toBe(false);
  });

  it("each choice is written, and a default is left out so the URL stays plain", () => {
    let p = writeView(new URLSearchParams("view=finances&af_from=2026-09-01&af_to=2026-09-30"), { sort: "np", brand: "AKEMI", pick: "MID VALLEY" }, TODAY);
    expect(p.get(VIEW_PARAMS.sort)).toBe("np");
    expect(readView(p, TODAY)).toMatchObject({ sort: "np", brand: "AKEMI", pick: "MID VALLEY" });
    expect(p.get("af_from")).toBe("2026-09-01");
    p = writeView(p, { sort: "start", brand: "", pick: null, drill: { level: "yearMonths", year: 2026 } }, TODAY);
    expect(p.toString()).toBe("view=finances&af_from=2026-09-01&af_to=2026-09-30");
  });

  it("an unknown value reads as its default", () => {
    expect(readView(new URLSearchParams("ao_sort=bogus&ao_dim=x&ao_drill=zz"), TODAY)).toMatchObject({ sort: "start", dim: "brand", drill: { level: "yearMonths", year: 2026 } });
  });

  it("every trend level survives the URL", () => {
    for (const d of [
      { level: "years" }, { level: "quarters", year: 2025 }, { level: "yearMonths", year: 2026 },
      { level: "months", year: 2026, quarter: 4 }, { level: "weeks", month: "2026-10" },
    ] as const) {
      expect(decodeDrill(encodeDrill(d), TODAY)).toEqual(d);
    }
  });

  /* Owner 2026-10-21: 我点9月的project，按 back 后又跳回10月，然后会跑回最上面 —
     the project's Back button went to the bare /projects. */
  const SEPT = "/projects?view=finances&af_from=2026-09-01&af_to=2026-09-30&ao_sort=sales";

  it("opening a project notes the address it came from — its Back goes there, period and sort included", () => {
    rememberOpenedFrom(303, SEPT, { page: 640, table: 120, tableLeft: 300 });
    expect(projectBackTo(303)).toBe(SEPT);
    expect(projectBackTo(304)).toBe("/projects");   // a project opened some other way: the list
  });

  it("the place you were looking at is given back once, at that address", () => {
    rememberOpenedFrom(303, SEPT, { page: 640, table: 120, tableLeft: 300 });
    expect(takeScroll("/projects?view=finances")).toBeNull();
    expect(takeScroll(SEPT)).toEqual({ page: 640, table: 120, tableLeft: 300 });
    expect(takeScroll(SEPT)).toBeNull();
  });

  it("only a recent, same-site /projects address is trusted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T06:00:00Z"));
    rememberOpenedFrom(303, SEPT, { page: 0, table: 0, tableLeft: 0 });
    vi.setSystemTime(new Date("2026-10-21T06:31:00Z"));
    expect(projectBackTo(303)).toBe("/projects");
    vi.useRealTimers();
    rememberOpenedFrom(305, "//evil.example/projects", { page: 0, table: 0, tableLeft: 0 });
    expect(projectBackTo(305)).toBe("/projects");
  });
});

describe("the project table", () => {
  it("the name on two lines: brand and organizer, then place, state and dates", () => {
    expect(projectLines({
      name: "Selangor [AKEMI] MYHOME @ SUNWAY PYRAMID CONVENTION CENTRE", brand: "AKEMI", organizer: "MYHOME",
      venue: "SUNWAY PYRAMID CONVENTION CENTRE", state: "Selangor", startDate: "2026-10-16", endDate: "2026-10-18",
    })).toEqual({ title: "[AKEMI] MYHOME", detail: "SUNWAY PYRAMID CONVENTION CENTRE · Selangor · 10/16 - 10/18" });
    expect(projectLines({ name: "Odd one", brand: null, organizer: "MLE", venue: null, state: null, startDate: null, endDate: null }))
      .toEqual({ title: "Odd one", detail: "" });
  });

  it("amounts without RM, a dash for nothing", () => {
    expect(tableAmount(0)).toBe("–");
    expect(tableAmount(0.001)).toBe("–");
    expect(tableAmount(138358)).toBe("138,358.00");
    expect(tableAmount(-10713.76)).toBe("-10,713.76");
  });
});
