/* The pay-rules worked example divides by the days of THIS month. At 01:30 on
   1 Dec (Malaysia), on a machine whose clock zone is UTC, it used November's
   30 instead of December's 31. Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DEFAULT_PAY_RULES } from "../../vendor/shared/hr-pay-rules";
import { Explainer } from "./PayRulesTab";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dayRateLine = () => {
  const { container } = render(<Explainer r={{ ...DEFAULT_PAY_RULES, dayRateDivisorMode: "calendarDays" }} />);
  return container.textContent;
};

describe("pay-rules example uses the Malaysian month", () => {
  it("at 01:30 on 1 Dec (Malaysia) the month has 31 days", () => {
    vi.setSystemTime(new Date("2026-11-30T17:30:00Z"));
    expect(dayRateLine()).toContain("2,050 / 31");
  });

  it("at 23:59 on 30 Nov (Malaysia) it has 30", () => {
    vi.setSystemTime(new Date("2026-11-30T15:59:00Z"));
    expect(dayRateLine()).toContain("2,050 / 30");
  });
});
