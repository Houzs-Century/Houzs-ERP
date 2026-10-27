import { describe, expect, test } from "vitest";
import { apiErrText } from "./FleetHealth";

// HC-0160: a Fleet Health refusal must say why, not "Could not save. Please try again."
const httpErr = (message: string, body: object) =>
  Object.assign(new Error(message), { isHttp: true, rawBody: JSON.stringify(body) });

describe("apiErrText", () => {
  test("reads the route's code from rawBody, with the last reading", () => {
    const e = httpErr("That conflicts with existing data. Please refresh and try again.", {
      error: "odometer_rollback", previousKm: 200000, deltaKm: -7813,
    });
    expect(apiErrText(e)).toBe(
      `That is lower than the last reading (${(200000).toLocaleString()} km). An odometer cannot go backwards.`,
    );
  });

  test("an unmapped code falls back to the already-human message", () => {
    const e = httpErr("You don't have permission to do that.", { error: "forbidden" });
    expect(apiErrText(e)).toBe("You don't have permission to do that.");
  });

  test("a non-HTTP failure never shows its raw message", () => {
    expect(apiErrText(new TypeError("Cannot read properties of undefined"))).toBe("Could not save. Please try again.");
  });
});
