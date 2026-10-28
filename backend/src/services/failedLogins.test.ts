import { describe, expect, it } from "vitest";
import { loginsVerdict } from "./failedLogins";

describe("loginsVerdict", () => {
  it("is ok with nothing, or with a few failures spread out", () => {
    expect(loginsVerdict(0, [])).toBe("ok");
    expect(loginsVerdict(100, [9, 9, 5])).toBe("ok");
  });

  it("warns when one email reaches 10 in 24 h", () => {
    expect(loginsVerdict(12, [10, 2])).toBe("warning");
  });

  it("warns when the 24 h total passes 100, even with no single hot email", () => {
    expect(loginsVerdict(101, [3, 3])).toBe("warning");
  });

  it("is critical when one email reaches 30, whatever the total", () => {
    expect(loginsVerdict(30, [30])).toBe("critical");
    expect(loginsVerdict(500, [12, 31])).toBe("critical");
  });
});
