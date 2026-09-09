import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAnnouncementSkip,
  mergeAndWriteAnnouncementAcks,
  readAnnouncementAcks,
  readAnnouncementSkips,
  recordAnnouncementSkip,
  sanitizeAnnouncementAcks,
  sanitizeAnnouncementSkips,
  skipLimitReached,
  writeAnnouncementSkips,
  type AnnouncementSkips,
} from "./announcementLocalAcks";

describe("announcement local acknowledgements", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  test("removes invalid timestamps and keeps only the newest 200", () => {
    const input = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`a${i}`, i + 1]));
    const result = sanitizeAnnouncementAcks({ ...input, bad: Infinity, future: 2_000_000 }, 1_000_000);
    expect(Object.keys(result)).toHaveLength(200);
    expect(result.a204).toBe(205);
    expect(result.a0).toBeUndefined();
    expect(result.bad).toBeUndefined();
    expect(result.future).toBeUndefined();
  });

  test("re-reads and merges another tab's acknowledgement before writing", () => {
    localStorage.setItem("acks", JSON.stringify({ first: 100 }));
    const merged = mergeAndWriteAnnouncementAcks("acks", { second: 200 });
    expect(merged).toEqual({ second: 200, first: 100 });
    expect(readAnnouncementAcks("acks")).toEqual(merged);
  });
});

describe("announcement skip counter", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  test("one postponement is allowed, the second appearance is acknowledge-only", () => {
    let skips: AnnouncementSkips = {};
    expect(skipLimitReached(skips, "ann-1")).toBe(false);
    skips = recordAnnouncementSkip(skips, "ann-1", 1_000);
    expect(skips["ann-1"]).toEqual({ n: 1, at: 1_000 });
    expect(skipLimitReached(skips, "ann-1")).toBe(true);
    // A second record (a surface that missed the gate) still counts, and the
    // limit stays reached — it never re-opens.
    skips = recordAnnouncementSkip(skips, "ann-1", 2_000);
    expect(skips["ann-1"]).toEqual({ n: 2, at: 2_000 });
    expect(skipLimitReached(skips, "ann-1")).toBe(true);
    expect(skipLimitReached(skips, "ann-2")).toBe(false);
  });

  test("acknowledging clears the count so a Remind re-pop starts fresh", () => {
    let skips = recordAnnouncementSkip(
      recordAnnouncementSkip({}, "ann-1", 1_000),
      "ann-1",
      2_000,
    );
    skips = clearAnnouncementSkip(skips, "ann-1");
    expect(skips["ann-1"]).toBeUndefined();
    expect(skipLimitReached(skips, "ann-1")).toBe(false);
    expect(clearAnnouncementSkip(skips, "missing")).toBe(skips);
  });

  test("sanitize drops malformed entries and keeps only the newest 200", () => {
    const big = Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [`a${i}`, { n: 1, at: i + 1 }]),
    );
    const result = sanitizeAnnouncementSkips(
      {
        ...big,
        zero: { n: 0, at: 500 },
        negative: { n: -2, at: 500 },
        fractional: { n: 1.5, at: 500 },
        future: { n: 1, at: 2_000_000 },
        absurd: { n: 5_000, at: 500 },
        wrongShape: 3,
      },
      1_000_000,
    );
    expect(Object.keys(result)).toHaveLength(200);
    expect(result.a204).toEqual({ n: 1, at: 205 });
    expect(result.a0).toBeUndefined();
    expect(result.zero).toBeUndefined();
    expect(result.negative).toBeUndefined();
    expect(result.fractional).toBeUndefined();
    expect(result.future).toBeUndefined();
    expect(result.absurd?.n).toBe(99);
    expect(result.wrongShape).toBeUndefined();
  });

  test("write is a plain overwrite, so a cleared entry stays cleared", () => {
    writeAnnouncementSkips("skips", { "ann-1": { n: 2, at: 100 } });
    expect(readAnnouncementSkips("skips")).toEqual({ "ann-1": { n: 2, at: 100 } });
    writeAnnouncementSkips("skips", {});
    expect(readAnnouncementSkips("skips")).toEqual({});
  });

  test("no bound identity: reads are empty and writes keep the in-memory result", () => {
    expect(readAnnouncementSkips(null)).toEqual({});
    expect(writeAnnouncementSkips(null, { "ann-1": { n: 1, at: 50 } })).toEqual({
      "ann-1": { n: 1, at: 50 },
    });
  });
});
