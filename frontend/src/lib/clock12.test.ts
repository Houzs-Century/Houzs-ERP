import { describe, expect, test } from "vitest";
import { clock12 } from "./clock12";

describe("clock12", () => {
  test("midnight, small hours, noon and night", () => {
    expect(clock12("00:00")).toBe("12:00 AM");
    expect(clock12("01:00")).toBe("1:00 AM");
    expect(clock12("12:00")).toBe("12:00 PM");
    expect(clock12("22:00")).toBe("10:00 PM");
    expect(clock12("23:30")).toBe("11:30 PM");
  });
  test("not a time: unchanged", () => {
    expect(clock12("late")).toBe("late");
    expect(clock12("25:00")).toBe("25:00");
  });
});
