import { describe, expect, test } from "vitest";
import { pinProblem } from "./PosCashiersTab";

describe("pinProblem", () => {
  test("a new cashier needs a PIN of 4 to 6 digits, typed twice the same", () => {
    expect(pinProblem("", "", true)).toMatch(/required/);
    expect(pinProblem("", "", false)).toBeNull();
    expect(pinProblem("123", "123", true)).toMatch(/4 to 6 digits/);
    expect(pinProblem("1234", "1235", true)).toMatch(/differ/);
    expect(pinProblem("123456", "123456", true)).toBeNull();
  });
});
