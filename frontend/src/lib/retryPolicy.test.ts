import { describe, it, expect } from "vitest";
import { retryUnlessClientError } from "./retryPolicy";

/* This predicate now governs 96 query hooks across every SCM document module,
   so the cases below are the contract, not a smoke test. The two error shapes
   are modelled verbatim:
     - api/client.ts HttpError            → Error with a numeric `status`
     - vendor/scm/lib/authed-fetch        → Error with a numeric `status`
     - a network-layer failure            → Error with NO `status`            */

function httpError(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("retryUnlessClientError", () => {
  it("does not retry a 403 — the decision the whole change exists for", () => {
    // The observed production symptom: /inventory/warehouses 403'd TWICE on one
    // SO Maintenance load. The second call cannot succeed.
    expect(retryUnlessClientError(0, httpError(403))).toBe(false);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not retry %i", (status) => {
    expect(retryUnlessClientError(0, httpError(status))).toBe(false);
  });

  it.each([408, 429])("DOES retry %i — the 4xx codes that mean 'try again'", (status) => {
    expect(retryUnlessClientError(0, httpError(status))).toBe(true);
  });

  it("retries a 5xx once — Hyperdrive cold start genuinely self-heals", () => {
    expect(retryUnlessClientError(0, httpError(503))).toBe(true);
    expect(retryUnlessClientError(0, httpError(500))).toBe(true);
  });

  it("retries a network-layer failure (no status) once", () => {
    expect(retryUnlessClientError(0, new Error("Failed to fetch"))).toBe(true);
  });

  it("stops after ONE retry — it must not become a retry storm", () => {
    expect(retryUnlessClientError(1, httpError(503))).toBe(false);
    expect(retryUnlessClientError(1, new Error("Failed to fetch"))).toBe(false);
    expect(retryUnlessClientError(5, httpError(503))).toBe(false);
  });

  it("treats a non-numeric status as 'no status' rather than trusting it", () => {
    // A malformed error must not accidentally read as a 4xx and suppress a
    // retry that a real network blip needs.
    const e = new Error("weird") as Error & { status: unknown };
    e.status = "403";
    expect(retryUnlessClientError(0, e)).toBe(true);
  });
});
