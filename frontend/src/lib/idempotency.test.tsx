import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "./authToken";
import { idempotentInit, useIdempotencyKey } from "./idempotency";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

/* Both halves of the rotation rule, driven through the REAL fetch layer rather
   than by calling the rotate helper by hand — the whole point of the fix is
   that none of the 27 create forms has to remember it, so a test that poked the
   helper directly would still pass with the wiring removed.

   The fake server below is the middleware contract in miniature
   (backend/src/middleware/idempotency.ts): a claim is (key -> request hash +
   stored response); an identical payload REPLAYS; a different payload under a
   claimed key is refused with idempotency_key_reused; and a route may release
   its own claim by proving it wrote nothing (markIdempotencyNoWrite). `writes`
   counts business writes, which is the figure that decides whether money was
   booked twice. */

type Claim = { hash: string; status: number; body: string };
type SaveResult = { ok: boolean; message: string };

function fakeServer(options: { releaseClaimOnRefusal: boolean }) {
  const claims = new Map<string, Claim>();
  const state = { writes: 0, lastWrittenPrice: -1, grnNo: 0 };

  /* The zero-cost receipt guard: a deterministic refusal the operator is
     expected to correct and retry, decided before anything is committed. */
  const handler = (payload: { unitPrice: number }): { status: number; body: string } => {
    if (payload.unitPrice === 0) {
      return {
        status: 409,
        body: JSON.stringify({
          error: "zero_cost_receipt",
          message: "These lines would receive stock at zero cost.",
        }),
      };
    }
    state.writes += 1;
    state.lastWrittenPrice = payload.unitPrice;
    state.grnNo += 1;
    return { status: 201, body: JSON.stringify({ grnNumber: `GRN-${state.grnNo}` }) };
  };

  const respond = (init: RequestInit | undefined): Response => {
    // The fetch layer normalises headers to a Headers instance on the way out
    // (requestCorrelation.correlatedFetch), so read them the same way.
    const key = new Headers(init?.headers).get("Idempotency-Key");
    const raw = String(init?.body ?? "");
    const payload = JSON.parse(raw) as { unitPrice: number };
    if (!key) {
      const out = handler(payload);
      return new Response(out.body, { status: out.status });
    }
    const existing = claims.get(key);
    if (existing) {
      if (existing.hash !== raw) {
        return new Response(
          JSON.stringify({
            error: "idempotency_key_reused",
            message: "This request key was already used for different data.",
          }),
          { status: 409 },
        );
      }
      return new Response(existing.body, {
        status: existing.status,
        headers: { "Idempotent-Replay": "true" },
      });
    }
    claims.set(key, { hash: raw, status: 0, body: "" });
    const out = handler(payload);
    // markIdempotencyNoWrite: only a route that PROVED it wrote nothing.
    if (out.status === 409 && options.releaseClaimOnRefusal) claims.delete(key);
    else claims.set(key, { hash: raw, status: out.status, body: out.body });
    return new Response(out.body, { status: out.status });
  };

  return { state, respond };
}

/** One press of Save, and what the operator's screen was told. */
async function save(key: string, unitPrice: number): Promise<SaveResult> {
  try {
    await authedFetch(
      "/grns",
      idempotentInit(key, { method: "POST", body: JSON.stringify({ unitPrice }) }),
    );
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
});

describe("useIdempotencyKey", () => {
  test("the key is stable across re-renders — a per-render key would defeat the middleware", () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(first.length).toBeGreaterThan(10);
  });

  test("a rejected submit, corrected and resubmitted, SAVES — the route released its claim", async () => {
    const server = fakeServer({ releaseClaimOnRefusal: true });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve(server.respond(init as RequestInit)),
    );
    const { result } = renderHook(() => useIdempotencyKey());
    const key = result.current;

    // Submit 1 — the zero-cost guard refuses, exactly as it did in production.
    await act(async () => {
      expect((await save(key, 0)).ok).toBe(false);
    });
    expect(server.state.writes).toBe(0);

    // The operator types the unit price the guard asked for and presses Save
    // again. Nothing was reloaded, so this is still the mount's original key.
    await act(async () => {
      expect((await save(result.current, 88_00)).ok).toBe(true);
    });
    expect(result.current).toBe(key);
    expect(server.state.writes).toBe(1);
    expect(server.state.lastWrittenPrice).toBe(88_00);
  });

  test("a route that keeps its claim is recovered by rotation, not by a page reload", async () => {
    // The client half standing alone: this server never releases a claim, so
    // the corrected payload comes back idempotency_key_reused — the dead end
    // staff hit. The form must become usable again WITHOUT losing its state.
    const server = fakeServer({ releaseClaimOnRefusal: false });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve(server.respond(init as RequestInit)),
    );
    const { result } = renderHook(() => useIdempotencyKey());
    const firstKey = result.current;

    await act(async () => {
      expect((await save(firstKey, 0)).ok).toBe(false);
    });
    let refusal: SaveResult = { ok: true, message: "" };
    await act(async () => {
      refusal = await save(result.current, 88_00);
    });
    expect(refusal.ok).toBe(false);
    // The copy must not say "refresh" — refreshing is what loses the typing.
    expect(refusal.message).toMatch(/press Save again/i);
    expect(result.current).not.toBe(firstKey);
    expect(server.state.writes).toBe(0);

    // Save pressed again on the same screen, everything still typed in.
    await act(async () => {
      expect((await save(result.current, 88_00)).ok).toBe(true);
    });
    expect(server.state.writes).toBe(1);
    expect(server.state.lastWrittenPrice).toBe(88_00);
  });

  test("a SUCCEEDED write still replays on retry — the key must not rotate on success", async () => {
    /* THE ONE THAT PROTECTS THE MONEY. A step after the successful post fails
       (a refetch on bad signal), the operator re-presses, and the second submit
       must replay the first response rather than book a second document. */
    const server = fakeServer({ releaseClaimOnRefusal: true });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.resolve(server.respond(init as RequestInit)),
    );
    const { result } = renderHook(() => useIdempotencyKey());
    const key = result.current;

    await act(async () => {
      expect((await save(key, 88_00)).ok).toBe(true);
    });
    await act(async () => {
      expect((await save(result.current, 88_00)).ok).toBe(true);
    });

    expect(result.current).toBe(key);
    expect(server.state.writes).toBe(1);
  });

  test("in-flight and unconfirmed outcomes NEVER rotate — the write may have landed", async () => {
    const answers = [
      { status: 409, body: { error: "idempotency_in_flight" } },
      { status: 503, body: { error: "idempotency_outcome_unknown" } },
      { status: 503, body: { error: "idempotency_unavailable" } },
    ];
    let next = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const a = answers[Math.min(next++, answers.length - 1)]!;
      return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
    });
    const { result } = renderHook(() => useIdempotencyKey());
    const key = result.current;

    for (let i = 0; i < answers.length; i += 1) {
      await act(async () => {
        expect((await save(result.current, 88_00)).ok).toBe(false);
      });
      expect(result.current).toBe(key);
    }
  });

  test("a network failure NEVER rotates — aborting a fetch does not abort the Worker", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useIdempotencyKey());
    const key = result.current;

    await act(async () => {
      expect((await save(result.current, 88_00)).ok).toBe(false);
    });
    expect(result.current).toBe(key);
  });
});
