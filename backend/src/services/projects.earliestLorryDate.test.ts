import { describe, it, expect } from "vitest";
import { earliestLorryDate } from "./projects";

// Owner 2026-10-26: the Setup & Dismantle editor dropped the single shared date
// box — each lorry carries its own date under lorry_crew[].at. patchProject
// derives projects.setup_start_at / dismantle_start_at from the EARLIEST of them
// so the delivery board, the printed Event Summary and the stage stepper keep a
// representative window date. These cases pin that derivation.
describe("earliestLorryDate", () => {
  const crew = (lorries: Array<{ plate?: string; at?: string }>) =>
    JSON.stringify({ lorry_crew: lorries });

  it("returns null for empty / non-string / unparseable input", () => {
    expect(earliestLorryDate(null)).toBeNull();
    expect(earliestLorryDate(undefined)).toBeNull();
    expect(earliestLorryDate("")).toBeNull();
    expect(earliestLorryDate("{bad json")).toBeNull();
    expect(earliestLorryDate({ lorry_crew: [] } as unknown)).toBeNull(); // object, not the stored string
  });

  it("returns null when no lorry carries a date", () => {
    expect(earliestLorryDate(crew([]))).toBeNull();
    expect(earliestLorryDate(crew([{ plate: "VRH1" }, { plate: "VRH2" }]))).toBeNull();
    expect(earliestLorryDate(crew([{ plate: "VRH1", at: "  " }]))).toBeNull(); // blank is ignored
  });

  it("returns the lone lorry's date", () => {
    expect(earliestLorryDate(crew([{ plate: "VRH1", at: "2026-10-26T14:00" }]))).toBe("2026-10-26T14:00");
  });

  it("returns the EARLIEST across lorries, ignoring dateless ones", () => {
    expect(
      earliestLorryDate(
        crew([
          { plate: "VRH1", at: "2026-10-28T09:00" },
          { plate: "VRH2", at: "2026-10-26T14:00" },
          { plate: "VRH3" }, // no date — skipped, not treated as earliest
        ]),
      ),
    ).toBe("2026-10-26T14:00");
  });

  it("compares a same-day earlier TIME correctly (lexical = chronological)", () => {
    expect(
      earliestLorryDate(
        crew([
          { plate: "VRH1", at: "2026-10-26T14:00" },
          { plate: "VRH2", at: "2026-10-26T08:30" },
        ]),
      ),
    ).toBe("2026-10-26T08:30");
  });
});
