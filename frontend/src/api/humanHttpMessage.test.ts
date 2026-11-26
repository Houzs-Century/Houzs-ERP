import { describe, expect, test } from "vitest";
import { humanHttpMessage } from "./client";

describe("humanHttpMessage", () => {
  test("a curated error CODE maps to plain language, never the raw code", () => {
    const body = JSON.stringify({
      error: "idempotency_in_flight",
      message: "This request is already being processed.",
    });
    const msg = humanHttpMessage(409, body);
    expect(msg).not.toContain("idempotency_in_flight");
    expect(msg).not.toContain("_");
    expect(msg).toMatch(/already going through/i);
  });

  test("an UNcurated error code falls back to the body's human message", () => {
    const body = JSON.stringify({
      error: "some_unmapped_code",
      message: "The warehouse is on hold.",
    });
    expect(humanHttpMessage(409, body)).toBe("The warehouse is on hold.");
  });

  test("idempotency safety failures explain whether the write ran", () => {
    expect(
      humanHttpMessage(
        503,
        JSON.stringify({ error: "idempotency_unavailable", message: "fallback" }),
      ),
    ).toMatch(/nothing was sent/i);
    const reused = humanHttpMessage(
      409,
      JSON.stringify({ error: "idempotency_key_reused", message: "fallback" }),
    );
    expect(reused).toMatch(/refresh and check/i);
    expect(reused).not.toMatch(/nothing was saved|press save again/i);
    expect(
      humanHttpMessage(
        400,
        JSON.stringify({ error: "invalid_idempotency_key", message: "fallback" }),
      ),
    ).toMatch(/refresh the page/i);
    expect(
      humanHttpMessage(
        503,
        JSON.stringify({ error: "idempotency_outcome_unknown", message: "fallback" }),
      ),
    ).toMatch(/don't submit it again/i);
    expect(
      humanHttpMessage(
        409,
        JSON.stringify({ error: "idempotency_key_conflict", message: "fallback" }),
      ),
    ).toMatch(/another operation/i);
    expect(
      humanHttpMessage(
        413,
        JSON.stringify({ error: "idempotency_payload_too_large", message: "fallback" }),
      ),
    ).toMatch(/upload the file separately/i);
  });

  test("an uncurated code with no message falls through to the status map", () => {
    const msg = humanHttpMessage(409, JSON.stringify({ error: "some_unmapped_code" }));
    expect(msg).not.toContain("some_unmapped_code");
    expect(msg).toBe("That conflicts with existing data. Please refresh and try again.");
  });

  test("a sentence-shaped `error` is still surfaced as-is (historic behaviour)", () => {
    const body = JSON.stringify({ error: "That code is already in use." });
    expect(humanHttpMessage(400, body)).toBe("That code is already in use.");
  });

  test("a non-JSON body falls through to the status map", () => {
    expect(humanHttpMessage(500, "<html>502 Bad Gateway</html>")).toBe(
      "Something went wrong on our end. Please try again.",
    );
  });

  test("the 503 wording keeps the phrases isColdPool503 matches on", () => {
    expect(humanHttpMessage(503, "")).toMatch(/briefly unavailable|try again in a moment/i);
  });

  test("a frozen save reads as PAUSED, not as an outage — `reason` is read", () => {
    const body = JSON.stringify({
      error: "write_frozen",
      reason: "Saving is paused while the AutoCount data is brought across.",
      message: "Saving is paused while the AutoCount data is brought across.",
    });
    const msg = humanHttpMessage(503, body);
    expect(msg).toMatch(/paused/i);
    expect(msg).not.toMatch(/briefly unavailable|try again in a moment/i);
  });

  test("`reason` alone is enough — the SCM client's field is honoured here too", () => {
    const body = JSON.stringify({
      error: "write_frozen",
      reason: "Saving is paused while the AutoCount data is brought across.",
    });
    expect(humanHttpMessage(503, body)).toMatch(/paused/i);
  });

  test("a leaked SQLite/D1 constraint error is NOT shown — falls to the status map", () => {
    const body = JSON.stringify({
      error: "D1_ERROR: UNIQUE constraint failed: project_team.project_id, project_team.user_id",
    });
    const msg = humanHttpMessage(409, body);
    expect(msg).not.toMatch(/constraint|D1_ERROR|project_team/i);
    expect(msg).toBe("That conflicts with existing data. Please refresh and try again.");
  });

  test("a leaked Postgres error is NOT shown — falls to the status map", () => {
    const body = JSON.stringify({
      error: 'duplicate key value violates unique constraint "roles_pkey"',
    });
    const msg = humanHttpMessage(409, body);
    expect(msg).not.toMatch(/violates|constraint|duplicate key|roles_pkey/i);
    expect(msg).toBe("That conflicts with existing data. Please refresh and try again.");
  });

  test("a bare HTTP reason phrase is neutralised to the friendly status sentence", () => {
    expect(humanHttpMessage(404, JSON.stringify({ error: "Not found" }))).toBe(
      "We couldn't find what you were looking for.",
    );
    expect(humanHttpMessage(403, JSON.stringify({ error: "Forbidden" }))).toBe(
      "You don't have permission to do that.",
    );
    expect(humanHttpMessage(400, "Bad Request")).toBe(
      "Something in that request wasn't right. Please check and try again.",
    );
  });

  test("a genuine sentence that merely contains a number is still shown as-is", () => {
    const body = JSON.stringify({ error: "Order 12345 has already been invoiced." });
    expect(humanHttpMessage(409, body)).toBe("Order 12345 has already been invoiced.");
  });
});
