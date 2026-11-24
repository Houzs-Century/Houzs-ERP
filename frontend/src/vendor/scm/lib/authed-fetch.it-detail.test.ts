// HC-0256: an amendment approve answered 500 `apply_failed` with the real cause
// in `reason`, and the screen said only "The system hit a problem". IT had to
// guess. The friendly sentence stays; on a 5xx the server's own words follow
// it, labelled for IT.
import { describe, expect, test } from "vitest";
import { itDetailOf } from "./authed-fetch";

const apiError = (status: number, body: unknown) =>
  Object.assign(new Error("x"), { status, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("itDetailOf", () => {
  test("a 500 whose reason was hidden gives it back, labelled for IT", () => {
    const e = apiError(500, { error: "apply_failed", reason: "Unsupported structured value for PostgreSQL column before_lines" });
    expect(itDetailOf(e)).toBe(" Details for IT: Unsupported structured value for PostgreSQL column before_lines.");
  });

  test("nothing when the friendly sentence already said it", () => {
    expect(itDetailOf(apiError(500, { error: "x_failed", message: "The PO is locked, refresh and try again." }))).toBe("");
  });

  test("nothing for a 4xx, a non-JSON body, a JSON blob, or a plain Error", () => {
    expect(itDetailOf(apiError(409, { error: "conflict", reason: "column foo" }))).toBe("");
    expect(itDetailOf(apiError(500, "<html>Bad gateway</html>"))).toBe("");
    expect(itDetailOf(apiError(500, { error: "x", reason: '{"code":"session_not_found"}' }))).toBe("");
    expect(itDetailOf(new Error("offline"))).toBe("");
  });

  test("a long reason is cut to 300 characters", () => {
    const out = itDetailOf(apiError(500, { error: "apply_failed", reason: "column ".repeat(100) }));
    expect(out.length).toBeLessThanOrEqual(" Details for IT: ".length + 301);
  });
});
