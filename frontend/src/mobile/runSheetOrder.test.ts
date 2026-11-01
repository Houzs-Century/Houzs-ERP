import { describe, expect, test } from "vitest";
import { runSheetTieBreak, timeSlotStartMin, type RunStopOrder } from "./runSheetOrder";

const sortDocs = (rows: RunStopOrder[]) =>
  [...rows].sort(runSheetTieBreak).map((r) => r.so_doc_no);

describe("timeSlotStartMin", () => {
  // The office types these verbatim on the DO (real production values).
  test("reads the start of the office free-text window", () => {
    expect(timeSlotStartMin("TIME AROUND 1:30PM TO 3:30PM")).toBe(13 * 60 + 30);
    expect(timeSlotStartMin("TIME AROUND 11AM TO 1PM")).toBe(11 * 60);
    expect(timeSlotStartMin("TIME AROUND 12:30PM TO 2:30PM")).toBe(12 * 60 + 30);
    expect(timeSlotStartMin("TIME AROUND 3PM TO 5PM")).toBe(15 * 60);
    expect(timeSlotStartMin("TIME AROUND 6:30PM TO 8PM")).toBe(18 * 60 + 30);
  });
  test("12AM is midnight, 12PM is noon", () => {
    expect(timeSlotStartMin("12AM TO 2AM")).toBe(0);
    expect(timeSlotStartMin("12PM TO 1PM")).toBe(12 * 60);
  });
  test("also accepts a bare 24-hour clock", () => {
    expect(timeSlotStartMin("13:30-15:30")).toBe(13 * 60 + 30);
    expect(timeSlotStartMin("09:00")).toBe(9 * 60);
  });
  test("absent or timeless → null (sorts last)", () => {
    expect(timeSlotStartMin(null)).toBeNull();
    expect(timeSlotStartMin("")).toBeNull();
    expect(timeSlotStartMin("ANYTIME")).toBeNull();
  });
});

describe("runSheetTieBreak — stop order within a day", () => {
  test("with no trip sequence, earliest window first (real time_range strings)", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "LiPing", time_range: "TIME AROUND 1:30PM TO 3:30PM" },
      { so_doc_no: "Shaliza", time_range: "TIME AROUND 6:30PM TO 8PM" },
      { so_doc_no: "Alvin", time_range: "TIME AROUND 4:30PM TO 6:30PM" },
      { so_doc_no: "Wiyah", time_range: "TIME AROUND 3PM TO 5PM" },
      { so_doc_no: "Apple", time_range: "TIME AROUND 11AM TO 1PM" },
      { so_doc_no: "Oscar", time_range: "TIME AROUND 12:30PM TO 2:30PM" },
    ];
    expect(sortDocs(rows)).toEqual(["Apple", "Oscar", "LiPing", "Wiyah", "Alvin", "Shaliza"]);
  });

  test("untimed stops sink to the end", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "TRANSFER", time_range: null },
      { so_doc_no: "TIMED", time_range: "TIME AROUND 11AM TO 1PM" },
    ];
    expect(sortDocs(rows)).toEqual(["TIMED", "TRANSFER"]);
  });

  test("an explicit lorry-run sequence wins over the time slot", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "LATE-BUT-FIRST", trip_stop_no: 1, time_range: "TIME AROUND 6PM TO 8PM" },
      { so_doc_no: "EARLY-BUT-SECOND", trip_stop_no: 2, time_range: "TIME AROUND 9AM TO 11AM" },
    ];
    expect(sortDocs(rows)).toEqual(["LATE-BUT-FIRST", "EARLY-BUT-SECOND"]);
  });

  test("sequenced stops precede unsequenced ones", () => {
    const rows: RunStopOrder[] = [
      { so_doc_no: "NO-SEQ", time_range: "TIME AROUND 8AM TO 9AM" },
      { so_doc_no: "SEQ", trip_stop_no: 5, time_range: "TIME AROUND 10PM TO 11PM" },
    ];
    expect(sortDocs(rows)).toEqual(["SEQ", "NO-SEQ"]);
  });

  test("equal slot (or both untimed) falls back to doc number for stability", () => {
    expect(sortDocs([
      { so_doc_no: "DO-2", time_range: "TIME AROUND 10AM TO 12PM" },
      { so_doc_no: "DO-1", time_range: "TIME AROUND 10AM TO 12PM" },
    ])).toEqual(["DO-1", "DO-2"]);
    expect(sortDocs([
      { so_doc_no: "Z", time_range: null },
      { so_doc_no: "Y", time_range: null },
    ])).toEqual(["Y", "Z"]);
  });

  test("missing doc numbers compare as equal (no throw)", () => {
    expect(runSheetTieBreak(
      { time_range: "TIME AROUND 10AM TO 12PM" },
      { time_range: "TIME AROUND 10AM TO 12PM" },
    )).toBe(0);
  });
});
