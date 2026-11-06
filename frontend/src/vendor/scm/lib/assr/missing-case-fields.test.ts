import { describe, expect, it } from "vitest";
import { missingCaseFields } from "./case-fields";

describe("a new service case", () => {
  it("names what is still empty, in form order", () => {
    expect(missingCaseFields([["SO", "HC-1"], ["Issue description", "  "], ["Issue category", ""]])).toEqual(["Issue description", "Issue category"]);
  });
  it("names nothing once every field is filled", () => {
    expect(missingCaseFields([["SO", "HC-1"], ["Issue category", "Colour rub"]])).toEqual([]);
  });
});
