import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "./authToken";
import { idempotentInit, useIdempotencyKey } from "./idempotency";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";


type Claim = { hash: string; status: number | null; body: string };
type SaveResult = { ok: boolean; message: string };

function fakeServer(options: { releaseClaimOnRefusal: boolean }) {
  const claims = new Map<string, Claim>();
  const state = { writes: 0, lastWrittenPrice: -1, grnNo: 0 };

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
    const key = new Headers(init?.headers).get("Idempotency-Key");
    const raw = String(init?.body ?? "");
    const payload = JSON.parse(raw) as { unitPrice: number };
    if (!key) {
      const out = handler(payload);
      return new Response(out.body, { status: out.status });
    }
    const existing = claims.get(key);
    if (existing) {
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
    if (out.status === 409 && options.releaseClaimOnRefusal) claims.delete(key);
    else claims.set(key, { hash: raw, status: out.status, body: out.body });
    return new Response(out.body, { status: out.status });
  };

  return { state, respond };
}

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

    await act(async () => {
      expect((await save(key, 0)).ok).toBe(false);
    });
    expect(server.state.writes).toBe(0);

    await act(async () => {
      expect((await save(result.current, 88_00)).ok).toBe(true);
    });
    expect(result.current).toBe(key);
    expect(server.state.writes).toBe(1);
    expect(server.state.lastWrittenPrice).toBe(88_00);
  });

  test("a CHANGED payload after a committed write cannot book a second document", async () => {
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

    await act(async () => {
      await save(result.current, 99_00);
    });
    expect(server.state.writes).toBe(1);
    expect(server.state.grnNo).toBe(1);
    expect(result.current).toBe(key);
  });

  test("a route that keeps its claim sends the operator to CHECK, and never rotates the key", async () => {
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
