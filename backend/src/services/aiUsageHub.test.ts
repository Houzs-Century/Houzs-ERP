import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHubUsageReport, lastUtcDays, sendAiUsageToHub, type HubAggRow } from "./aiUsageHub";
import type { Env } from "../types";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const row = (over: Partial<HubAggRow>): HubAggRow => ({
  day: "2026-10-27",
  companyCode: "HOUZS",
  feature: "scan_so",
  model: "claude-sonnet-4-6",
  calls: 1,
  ...zero,
  ...over,
});

describe("lastUtcDays", () => {
  it("ends with today's UTC date, oldest first", () => {
    expect(lastUtcDays(new Date("2026-10-28T01:30:00Z"), 3)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"]);
  });
});

describe("buildHubUsageReport", () => {
  const days = ["2026-10-26", "2026-10-27"];

  it("prices rows and adds models together per day, company and feature", () => {
    const r = buildHubUsageReport(days, [
      row({ inputTokens: 1_000_000, calls: 3 }),
      row({ model: "some-future-model", outputTokens: 100_000, calls: 2 }),
      row({ companyCode: "2990", inputTokens: 1_000_000 }),
      row({ feature: "assistant", outputTokens: 1_000_000 }),
    ]);
    const day = r.days.find((d) => d.day === "2026-10-27")!;
    expect(day.rows).toEqual(
      expect.arrayContaining([
        { company: "HOUZS", module: "scan_so", usd: 4.5, calls: 5 },
        { company: "2990", module: "scan_so", usd: 3, calls: 1 },
        { company: "HOUZS", module: "assistant", usd: 15, calls: 1 },
      ]),
    );
    expect(day.rows).toHaveLength(3);
  });

  it("sends every day in the window, an empty one too, and drops rows outside it", () => {
    const r = buildHubUsageReport(days, [row({ day: "2026-10-01", inputTokens: 1_000_000 })]);
    expect(r).toEqual({ vendor: "Anthropic", days: [{ day: "2026-10-26", rows: [] }, { day: "2026-10-27", rows: [] }] });
  });

  it("keeps calls with no company as company null", () => {
    const r = buildHubUsageReport(days, [row({ companyCode: null, feature: "cache_warm" })]);
    expect(r.days[1].rows).toEqual([{ company: null, module: "cache_warm", usd: 0, calls: 1 }]);
  });
});

describe("sendAiUsageToHub", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing when the hub address, company or key is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const now = new Date("2026-10-28T02:00:00Z");
    expect(await sendAiUsageToHub({} as Env, now)).toBeNull();
    expect(await sendAiUsageToHub({ IT_HUB_URL: "https://hub.example" } as Env, now)).toBeNull();
    expect(await sendAiUsageToHub({ IT_HUB_URL: "https://hub.example", IT_HUB_AI_USAGE_COMPANY: "HOUZS" } as Env, now)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
