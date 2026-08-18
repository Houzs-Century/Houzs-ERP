import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "./authToken";
import { idempotentInit, useIdempotencyKey } from "./idempotency";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

/* Driven through the REAL fetch layer, because the property under test is what
   the OPERATOR ends up doing, and that is decided by the key the next request
   carries plus the sentence on the screen.

   The fake server is the middleware contract in miniature
   (backend/src/middleware/idempotency.ts): a claim is (key -> request hash +
   stored response); an identical payload REPLAYS; a claim whose handler has not
   answered yet is in_flight; a DIFFERENT payload against a FINISHED claim is
   idempotency_key_reused, carrying the status that claim finished with; and a
   route may release its own claim by proving it wrote nothing
   (markIdempotencyNoWrite). `writes` counts business writes, which is the
   figure that decides whether a document was booked twice.

   THE ONE THAT MATTERS. `idempotency_key_reused` is answered on a hash mismatch
   ALONE, so it is also what a caller gets after a COMMITTED 201. A first
   attempt at this bug had the client rotate its key on that code and told the
   operator "nothing was saved, press Save again" — which books a second GRN, a
   second stock IN and a second AutoCount enqueue. The dead end is fixed on the
   SERVER, by the route releasing its own claim; the client's job is to not
   invent a release it cannot prove. */

type Claim = { hash: string; status: number | null; body: string };
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
      // Status before hash — the middleware's own order since 2026-08-18.
      if (existing.status === null) {
        return new Response(JSON.stringify({ error: "idempotency_in_flight" }), { status: 409 });
      }
      if (existing.hash !== raw) {
        return new Response(
          JSON.stringify({
            error: "idempotency_key_reused",
            completed_status: existing.status,
            message: "An earlier submission under this key already finished with different data.",
          }),
          { status: 409 },
        );
      }
      return new Response(existing.body, {
        status: existing.status,
        headers: { "Idempotent-Replay": "true" },
      });
    }
    claims.set(key, { hash: raw, status: null, body: "" });
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

function serveWith(server: ReturnType<typeof fakeServer>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
    Promise.resolve(server.respond(init as RequestInit)),
  );
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
    serveWith(server);
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

  test("a CHANGED payload after a committed write cannot book a second document", async () => {
    /* THE BLOCKER, as a test. The operator saved, then edited the lines and
       pressed Save again — a real sequence on GrnNew, which stays mounted after
       success. The server answers idempotency_key_reused, and that code says
       nothing about whether the earlier request wrote; here it did. If the
       client rotates on it, this second intent gets a fresh key and books a
       SECOND GRN. The key must not move, and pressing Save again must keep
       being refused rather than quietly succeeding. */
    const server = fakeServer({ releaseClaimOnRefusal: true });
    serveWith(server);
    const { result } = renderHook(() => useIdempotencyKey());
    const key = result.current;

    await act(async () => {
      expect((await save(key, 88_00)).ok).toBe(true);
    });
    expect(server.state.writes).toBe(1);

    let refusal: SaveResult = { ok: true, message: "" };
    await act(async () => {
      refusal = await save(result.current, 99_00);
    });
    expect(refusal.ok).toBe(false);

    // ... and again, because a stubborn operator is the realistic one, and
    // because the refusal copy is what decides whether they try. Whether this
    // one is refused is not the assertion — what it did to the ledger is.
    await act(async () => {
      await save(result.current, 99_00);
    });
    // ONE document. This is the assertion the whole design serves.
    expect(server.state.writes).toBe(1);
    expect(server.state.grnNo).toBe(1);
    expect(result.current).toBe(key);
  });

  test("a route that keeps its claim sends the operator to CHECK, and never rotates the key", async () => {
    /* The client half standing alone: this server never releases a claim, so
       the corrected payload comes back idempotency_key_reused. The recovery is
       the SERVER releasing (the test above); what the client owes the operator
       here is a sentence that does not promise a clean slate — because from the
       client's side this is indistinguishable from the committed case above. */
    const server = fakeServer({ releaseClaimOnRefusal: false });
    serveWith(server);
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
    expect(refusal.message).toMatch(/refresh and check/i);
    expect(refusal.message).not.toMatch(/press save again|nothing was saved/i);
    expect(result.current).toBe(firstKey);
    expect(server.state.writes).toBe(0);
  });

  test("a SUCCEEDED write still replays on retry — the key must not rotate on success", async () => {
    /* THE ONE THAT PROTECTS THE MONEY. A step after the successful post fails
       (a refetch on bad signal), the operator re-presses, and the second submit
       must replay the first response rather than book a second document. */
    const server = fakeServer({ releaseClaimOnRefusal: true });
    serveWith(server);
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
});
