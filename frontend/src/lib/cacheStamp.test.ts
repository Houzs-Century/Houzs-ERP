/* 3 · The overviews said "as of today" over a copy up to 2 h old. */
import { describe, expect, test } from "vitest";
import { cacheStampLabel, oldestCachedAt, withFresh } from "./cacheStamp";

describe("cache stamp", () => {
  test("names the copy's time in Malaysia", () => {
    expect(cacheStampLabel("2026-11-10T06:05:00.000Z")).toBe("Updated 14:05");
    expect(cacheStampLabel(null)).toBeNull();
    expect(cacheStampLabel("not a date")).toBeNull();
  });

  test("a page of several copies is as old as its oldest", () => {
    expect(oldestCachedAt(["2026-11-10T06:05:00.000Z", "2026-11-10T04:00:00.000Z", undefined])).toBe("2026-11-10T04:00:00.000Z");
    expect(oldestCachedAt([undefined, null])).toBeNull();
  });

  test("Refresh asks for figures computed now", () => {
    expect(withFresh("/procurement-overview?from=a")).toBe("/procurement-overview?from=a&fresh=1");
    expect(withFresh("/api/projects/overview")).toBe("/api/projects/overview?fresh=1");
  });
});
