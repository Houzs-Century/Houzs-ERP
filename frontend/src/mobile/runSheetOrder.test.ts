import { describe, expect, test } from "vitest";
import { runSheetTieBreak, timeSlotStartMin, type RunStopOrder } from "./runSheetOrder";

const sortDocs = (rows: RunStopOrder[]) =>
  [...rows].sort(runSheetTieBreak).map((r) => r.so_doc_no);

describe("timeSlotStartMin", () => {
  test("parses the window start, en-dash or hyphen", () => {
    expect(timeSlotStartMin("13:30–15:30")).toBe(13 * 60 + 30);
    expect(timeSlotStartMin("09:00-10:00")).toBe(9 * 60);
  });
  test("a single time is its own start", () => {
    expect(timeSlotStartMin("08:15")).toBe(8 * 60 + 15);
  });
  test("absent or unparseable → null (sorts last)", () => {
    expect(timeSlotStartMin(null)).toBeNull();
    expect(timeSlotStartMin("")).toBeNull();
    expect(timeSlotStartMin("anytime")).toBeNull();
  });
});

describe("runSheetTieBreak — stop order within a day", () => {
  test("with no trip sequence, earliest time slot comes first", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "C", time_range: "18:30–20:00" },
      { so_doc_no: "A", time_range: "13:30–15:30" },
      { so_doc_no: "B", time_range: "16:30–18:30" },
    ];
    expect(sortDocs(rows)).toEqual(["A", "B", "C"]);
  });

  test("untimed stops sink to the end", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "TRANSFER", time_range: null },
      { so_doc_no: "TIMED", time_range: "11:00–13:00" },
    ];
    expect(sortDocs(rows)).toEqual(["TIMED", "TRANSFER"]);
  });

  test("an explicit lorry-run sequence wins over the time slot", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "LATE-BUT-FIRST", trip_stop_no: 1, time_range: "18:00–20:00" },
      { so_doc_no: "EARLY-BUT-SECOND", trip_stop_no: 2, time_range: "09:00–11:00" },
    ];
    expect(sortDocs(rows)).toEqual(["LATE-BUT-FIRST", "EARLY-BUT-SECOND"]);
  });

  test("sequenced stops precede unsequenced ones", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "NO-SEQ", time_range: "08:00–09:00" },
      { so_doc_no: "SEQ", trip_stop_no: 5, time_range: "22:00–23:00" },
    ];
    expect(sortDocs(rows)).toEqual(["SEQ", "NO-SEQ"]);
  });

  test("equal slot (or both untimed) falls back to doc number for stability", () => {
    expect(sortDocs([
      { so_doc_no: "DO-2", time_range: "10:00–12:00" },
      { so_doc_no: "DO-1", time_range: "10:00–12:00" },
    ])).toEqual(["DO-1", "DO-2"]);
    expect(sortDocs([
      { so_doc_no: "Z", time_range: null },
      { so_doc_no: "Y", time_range: null },
    ])).toEqual(["Y", "Z"]);
  });

  test("missing doc numbers compare as equal (no throw)", () => {
    expect(runSheetTieBreak({ time_range: "10:00–12:00" }, { time_range: "10:00–12:00" })).toBe(0);
  });
});
