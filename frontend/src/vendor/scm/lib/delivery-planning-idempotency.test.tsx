import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useConvertSosToDo } from "./delivery-planning-queries";

vi.mock("./dialog-service", () => ({ serviceNotify: vi.fn() }));
vi.mock("./sales-order-queries", () => ({ invalidateSoLists: vi.fn() }));

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("./authed-fetch", () => ({ authedFetch }));

type Claim = { hash: string; status: number | null; body: unknown };

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

      if (!key) return create();

      const existing = claims.get(key);
      if (existing) {
        if (existing.hash !== raw) {
          state.reused += 1;
          throw new Error("idempotency_key_reused");
        }
        return existing.body;
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
    const server = fakeServer([{ soItemId: "sl-1", docNo: "2990-SO-2606-019", remaining: 1 }]);
    const { result } = renderHook(() => useConvertSosToDo(), { wrapper });

    const [a, b] = await Promise.all([
      result.current.mutateAsync({ docNos: ["2990-SO-2606-019"] }),
      result.current.mutateAsync({ docNos: ["2990-SO-2606-019"] }),
    ]);

    expect(server.dosCreated).toBe(1);
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
    expect(new Set(server.keysSeen).size).toBe(3);
  });
});
