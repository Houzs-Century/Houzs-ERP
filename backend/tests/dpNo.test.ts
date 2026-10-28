import { describe, expect, test } from "vitest";
import { plateLetters, dpDatePart, dpNoPrefix, nextDpSeq, formatDpNo, mintDpNo } from "../src/scm/lib/dp-no";

/* DP number = DP-YYMMDD-<plateLetters><NN> (owner 2026-07-18, example
   DP-260718-WPX01). The number encodes the date + the lorry + a per-(date,lorry)
   running count, so two things must hold: the sequence must be max+1 (never
   count+1, the POS-outage rule), and it must be scoped to the exact date+plate so
   two lorries on one day never share a run. */

describe("plateLetters — the alpha part of the plate", () => {
  test("takes the leading letters, uppercased", () => {
    expect(plateLetters("WPX 4471")).toBe("WPX");
    expect(plateLetters("jhr8820")).toBe("JHR");
    expect(plateLetters("VBT 8888 A")).toBe("VBT");
  });
  test("falls back to letters anywhere, then XX", () => {
    expect(plateLetters("1234 ABC")).toBe("ABC");
    expect(plateLetters("9999")).toBe("XX");
    expect(plateLetters("")).toBe("XX");
    expect(plateLetters(null)).toBe("XX");
  });
});

describe("dpDatePart — YYMMDD without a Date object", () => {
  test("slices the ISO date, no timezone shift", () => {
    expect(dpDatePart("2026-07-18")).toBe("260718");
    expect(dpDatePart("2026-07-01")).toBe("260701");
    expect(dpDatePart("2026-12-31T00:00:00Z")).toBe("261231");
  });
  test("a malformed date is 000000, not a crash", () => {
    expect(dpDatePart("")).toBe("000000");
    expect(dpDatePart(null)).toBe("000000");
  });
});

describe("dpNoPrefix", () => {
  test("assembles DP-YYMMDD-LETTERS", () => {
    expect(dpNoPrefix("2026-07-18", "WPX 4471")).toBe("DP-260718-WPX");
  });
});

describe("nextDpSeq — max+1, scoped to the exact prefix", () => {
  test("first of the day for a lorry is 1", () => {
    expect(nextDpSeq([], "DP-260718-WPX")).toBe(1);
  });
  test("max+1, ignoring gaps (never count+1)", () => {
    // Two exist but numbered 01 and 05 (03 was cancelled). Next is 06, NOT 03.
    expect(nextDpSeq(["DP-260718-WPX01", "DP-260718-WPX05"], "DP-260718-WPX")).toBe(6);
  });
  test("a different lorry the same day has its OWN run", () => {
    const all = ["DP-260718-WPX01", "DP-260718-WPX02", "DP-260718-JHR01"];
    expect(nextDpSeq(all, "DP-260718-JHR")).toBe(2);
    expect(nextDpSeq(all, "DP-260718-WPX")).toBe(3);
  });
  test("the same lorry a different DAY starts fresh", () => {
    const all = ["DP-260718-WPX01", "DP-260718-WPX02"];
    expect(nextDpSeq(all, "DP-260719-WPX")).toBe(1);
  });
});

describe("formatDpNo + mintDpNo", () => {
  test("pads the sequence to 2 digits", () => {
    expect(formatDpNo("DP-260718-WPX", 1)).toBe("DP-260718-WPX01");
    expect(formatDpNo("DP-260718-WPX", 12)).toBe("DP-260718-WPX12");
  });
  test("mintDpNo end-to-end matches the owner's example", () => {
    expect(mintDpNo("2026-07-18", "WPX 4471", [])).toBe("DP-260718-WPX01");
  });
  test("mintDpNo advances past the existing max for that day+plate", () => {
    const existing = ["DP-260718-WPX01", "DP-260718-WPX02", "DP-260714-JHR09"];
    expect(mintDpNo("2026-07-18", "WPX 4471", existing)).toBe("DP-260718-WPX03");
  });
});
