import { describe, expect, test } from "vitest";
import { applyPunch, closeOpenSegment, dayIsOpen, daySummary, MAX_PUNCH_PAIRS, normalizeSegments, type PunchMark, type Segment } from "./hr-attendance-segments";

const mk = (at: string): PunchMark => ({ at, source: "PHONE", lat: null, lng: null, accuracyM: null, geo: null, siteId: null, distanceM: null, photoKey: null });
const seg = (inAt: string, outAt: string | null): Segment => ({ in: mk(inAt), out: outAt ? mk(outAt) : null });

describe("applyPunch", () => {
  test("clock in on an empty day opens the first segment", () => {
    const r = applyPunch([], "CLOCK_IN", mk("T1"));
    expect(r).toEqual({ ok: true, segments: [seg("T1", null)] });
  });
  test("a second clock-in while on the clock is a no-op", () => {
    expect(applyPunch([seg("T1", null)], "CLOCK_IN", mk("T2"))).toEqual({ ok: false, reason: "already-in" });
  });
  test("clock out closes the open segment", () => {
    expect(applyPunch([seg("T1", null)], "CLOCK_OUT", mk("T2"))).toEqual({ ok: true, segments: [seg("T1", "T2")] });
  });
  test("clock out with nothing open is refused", () => {
    expect(applyPunch([seg("T1", "T2")], "CLOCK_OUT", mk("T3"))).toEqual({ ok: false, reason: "no-open-punch" });
    expect(applyPunch([], "CLOCK_OUT", mk("T1"))).toEqual({ ok: false, reason: "no-open-punch" });
  });
  test("clocking in again after clocking out opens clock 2 (multi-punch)", () => {
    const r = applyPunch([seg("T1", "T2")], "CLOCK_IN", mk("T3"));
    expect(r).toEqual({ ok: true, segments: [seg("T1", "T2"), seg("T3", null)] });
  });
  test(`a day already at ${MAX_PUNCH_PAIRS} pairs refuses a new clock-in`, () => {
    const full = [seg("A", "B"), seg("C", "D"), seg("E", "F"), seg("G", "H")];
    expect(full.length).toBe(MAX_PUNCH_PAIRS);
    expect(applyPunch(full, "CLOCK_IN", mk("I"))).toEqual({ ok: false, reason: "max-pairs" });
    expect(applyPunch([seg("A", "B"), seg("C", "D"), seg("E", "F"), seg("G", null)], "CLOCK_OUT", mk("H")).ok).toBe(true);
  });
  test("does not mutate the input array", () => {
    const input = [seg("T1", null)];
    applyPunch(input, "CLOCK_OUT", mk("T2"));
    expect(input).toEqual([seg("T1", null)]);
  });
});

describe("dayIsOpen / daySummary", () => {
  test("open while the last segment has no out", () => {
    expect(dayIsOpen([seg("T1", "T2"), seg("T3", null)])).toBe(true);
    expect(dayIsOpen([seg("T1", "T2")])).toBe(false);
    expect(dayIsOpen([])).toBe(false);
  });
  test("summary is the first in and last out; last out is null while open", () => {
    expect(daySummary([seg("A", "B"), seg("C", "D")])).toEqual({ firstIn: mk("A"), lastOut: mk("D"), open: false });
    expect(daySummary([seg("A", "B"), seg("C", null)])).toEqual({ firstIn: mk("A"), lastOut: null, open: true });
    expect(daySummary([])).toEqual({ firstIn: null, lastOut: null, open: false });
  });
});

describe("closeOpenSegment", () => {
  test("closes the open segment with the given out (e.g. an auto clock-out)", () => {
    expect(closeOpenSegment([seg("A", "B"), seg("C", null)], mk("D"))).toEqual([seg("A", "B"), seg("C", "D")]);
  });
  test("a day with nothing open is unchanged", () => {
    expect(closeOpenSegment([seg("A", "B")], mk("X"))).toEqual([seg("A", "B")]);
    expect(closeOpenSegment([], mk("X"))).toEqual([]);
  });
});

describe("normalizeSegments", () => {
  test("parses a stored array and drops bad entries", () => {
    const raw = [{ in: { at: "A", source: "PHONE" }, out: { at: "B" } }, { out: { at: "X" } }, "junk", null];
    const got = normalizeSegments(raw);
    expect(got.length).toBe(1);
    expect(got[0].in.at).toBe("A");
    expect(got[0].out?.at).toBe("B");
  });
  test("non-array is empty", () => {
    expect(normalizeSegments(null)).toEqual([]);
    expect(normalizeSegments({})).toEqual([]);
    expect(normalizeSegments("[]")).toEqual([]);
  });
});
