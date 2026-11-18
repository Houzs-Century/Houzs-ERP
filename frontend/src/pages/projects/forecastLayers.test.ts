/* The forecast line keys live twice, across the FE/BE boundary: the server's
 * rules (backend/src/services/eventForecast.ts, which accepts and stores them)
 * and this page's copy (forecastLayers.ts, which names and saves them). They
 * cannot share a module, so this pins them equal, in order. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FORECAST_LINES, FORECAST_LINE_LABELS, parseForecastInput, sourceTag } from "./forecastLayers";

const HERE = dirname(fileURLToPath(import.meta.url));
const backend = readFileSync(resolve(HERE, "../../../../backend/src/services/eventForecast.ts"), "utf8");

describe("forecast lines — one list on both sides", () => {
  it("the page's FORECAST_LINES equal the server's, in the same order", () => {
    const m = /export const FORECAST_LINES = \[([\s\S]*?)\] as const;/.exec(backend);
    expect(m).not.toBeNull();
    const serverLines = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(serverLines.length).toBeGreaterThan(0);
    expect([...FORECAST_LINES]).toEqual(serverLines);
    expect(Object.keys(FORECAST_LINE_LABELS).sort()).toEqual([...FORECAST_LINES].sort());
  });
});

describe("forecast input and tags", () => {
  it("reads RM with commas; blank clears; refuses negatives and junk", () => {
    expect(parseForecastInput("12,500.5")).toEqual({ ok: true, amount: 12500.5 });
    expect(parseForecastInput("  ")).toEqual({ ok: true, amount: null });
    expect(parseForecastInput("-1").ok).toBe(false);
    expect(parseForecastInput("abc").ok).toBe(false);
  });

  it("an actual carries no tag", () => {
    expect(sourceTag("actual")).toBeNull();
    expect(sourceTag("forecast")).toBe("Forecast");
    expect(sourceTag("last_event")).toBe("Last event");
  });
});
