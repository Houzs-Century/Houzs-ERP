/* The DESKTOP Delivery Planning board's "Convert to DO" carried no
 * Idempotency-Key while the MOBILE board's identical call
 * (MobileDeliveryPlanning.tsx) carried one. Same endpoint, same stock
 * consequence, protection on one side only — the divergence class this repo
 * keeps closing.
 *
 * SCOPE, HONESTLY. `POST /from-sos` is not defenceless: a SEQUENTIAL duplicate
 * is refused by the Phase-B `over_remaining` check, and a CONCURRENT pair is
 * caught after insert by the Edge #E recheck, which rolls the second DO back
 * BEFORE `deductInventoryForDo` runs. So this key is depth, not the only wall —
 * and depth is worth having on the surface that fires the call from a bulk bar
 * four SOs at a time. What the key adds that neither server guard does is a
 * decision the CLIENT can make: the retry replays the first answer instead of
 * racing for a rollback whose losing side can be BOTH requests (Edge #E rolls
 * back every over-committed insert, so a true tie converts nothing at all).
 *
 * The fake server is the middleware contract in miniature — the same shape
 * src/lib/idempotency.test.tsx uses — and it counts DOs created, because that
 * is the figure that decides whether stock left the building twice.
 *
 * NOTE ON THE KEY'S SHAPE. Mobile mints ONE key per mount, and says in its own
 * comment why that is safe there: the board is behind an early return, so a
 * mount is exactly one stop, i.e. one Sales Order — "If that early return is
 * ever replaced ... this key MUST move onto the order identity". The desktop
 * board IS that case: one mount converts many SOs. So the key moves onto the
 * order identity, exactly as instructed, rather than being copied per-mount —
 * a single per-mount key here would hand SO #2 a claim minted for SO #1's
 * payload and answer `idempotency_key_reused`, breaking bulk convert outright.
 * The last test pins that.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useConvertSosToDo } from "./delivery-planning-queries";

vi.mock("./dialog-service", () => ({ serviceNotify: vi.fn() }));
vi.mock("./sales-order-queries", () => ({ invalidateSoLists: vi.fn() }));

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("./authed-fetch", () => ({ authedFetch }));

type Claim = { hash: string; status: number | null; body: unknown };

/** The idempotency middleware + the from-sos create, reduced to what matters. */
function fakeServer(lines: Array<{ soItemId: string; docNo: string; remaining: number }>) {
  const claims = new Map<string, Claim>();
  const state = { dosCreated: 0, keysSeen: [] as Array<string | undefined>, reused: 0 };

  const create = () => {
    state.dosCreated += 1;
    return { id: `do-${state.dosCreated}`, doNumber: `HC-DO-26-${state.dosCreated}` };
  };

  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/delivery-orders-mfg/deliverable-so-lines")) return { lines };

    if (url.startsWith("/delivery-orders-mfg/from-sos")) {
      const key = new Headers(init?.headers as HeadersInit | undefined).get("Idempotency-Key") ?? undefined;
      state.keysSeen.push(key);
      const raw = String(init?.body ?? "");

      if (!key) return create(); // middleware is a pass-through without a key

      const existing = claims.get(key);
      if (existing) {
        if (existing.hash !== raw) {
          state.reused += 1;
          throw new Error("idempotency_key_reused");
        }
        return existing.body; // replay, verbatim
      }
      const body = create();
      claims.set(key, { hash: raw, status: 201, body });
      return body;
    }
    return {};
  });

  return state;
}

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => { authedFetch.mockReset(); });

describe("Delivery Planning — Convert to DO is idempotent", () => {
  test("two concurrent converts of ONE Sales Order cut ONE Delivery Order", async () => {
    /* The dispatcher double-clicks Convert, or the first response is slow and
       they press again. Both attempts read `deliverable-so-lines` before either
       writes, so both see the full remaining qty — the read-then-write race. */
    const server = fakeServer([{ soItemId: "sl-1", docNo: "2990-SO-2606-019", remaining: 1 }]);
    const { result } = renderHook(() => useConvertSosToDo(), { wrapper });

    const [a, b] = await Promise.all([
      result.current.mutateAsync({ docNos: ["2990-SO-2606-019"] }),
      result.current.mutateAsync({ docNos: ["2990-SO-2606-019"] }),
    ]);

    // ONE document. This is the assertion the whole thing serves.
    expect(server.dosCreated).toBe(1);
    // Both callers are told about the SAME DO — the second replayed the first.
    expect(a.converted[0]?.doNumber).toBe(b.converted[0]?.doNumber);
    expect(server.keysSeen.every((k) => typeof k === "string" && k.length > 10)).toBe(true);
  });

  test("a retry of the same conversion reuses the key rather than minting a new one", async () => {
    const server = fakeServer([{ soItemId: "sl-1", docNo: "2990-SO-2606-019", remaining: 1 }]);
    const { result } = renderHook(() => useConvertSosToDo(), { wrapper });

    await result.current.mutateAsync({ docNos: ["2990-SO-2606-019"] });
    await result.current.mutateAsync({ docNos: ["2990-SO-2606-019"] });

    expect(server.dosCreated).toBe(1);
    const [first, second] = server.keysSeen;
    expect(second).toBe(first);
  });

  test("a BULK convert still raises one DO per Sales Order — keys are per order, not per mount", async () => {
    /* The failure mode of copying mobile's per-mount key literally: SO #2 would
       post under SO #1's claim with a different payload and be refused
       `idempotency_key_reused`, so a 4-at-a-time bulk bar would convert one SO
       and fail the rest. */
    const server = fakeServer([
      { soItemId: "sl-1", docNo: "SO-A", remaining: 1 },
      { soItemId: "sl-2", docNo: "SO-B", remaining: 2 },
      { soItemId: "sl-3", docNo: "SO-C", remaining: 3 },
    ]);
    const { result } = renderHook(() => useConvertSosToDo(), { wrapper });

    let out!: Awaited<ReturnType<typeof result.current.mutateAsync>>;
    await waitFor(async () => {
      out = await result.current.mutateAsync({ docNos: ["SO-A", "SO-B", "SO-C"] });
    });

    expect(out.converted).toHaveLength(3);
    expect(out.failed).toHaveLength(0);
    expect(server.dosCreated).toBe(3);
    expect(server.reused).toBe(0);
    // Three distinct keys — one per order identity.
    expect(new Set(server.keysSeen).size).toBe(3);
  });
});
