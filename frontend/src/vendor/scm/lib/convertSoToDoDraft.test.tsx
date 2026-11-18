/* Convert to DO Draft (owner 2026-11-18) — the shared hook behind the desktop
 * right-click and the phone button. It must post /from-sos with asDraft: true
 * (omitting it ships the DO and deducts stock) for every line with something
 * left to deliver, at its remaining qty, and must refuse rather than post an
 * empty DO when nothing is left. */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("./authed-fetch", async (orig) => ({ ...(await orig<typeof import("./authed-fetch")>()), authedFetch }));

import { soDraftPicks, useConvertSoToDoDraft } from "./delivery-order-queries";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("soDraftPicks", () => {
  it("takes every line with a remainder, at its remaining qty", () => {
    expect(soDraftPicks([
      { soItemId: "a", remaining: 2 },
      { soItemId: "b", remaining: 0 },
      { soItemId: "c", remaining: 1 },
    ])).toEqual([{ soItemId: "a", qty: 2 }, { soItemId: "c", qty: 1 }]);
  });
});

describe("useConvertSoToDoDraft", () => {
  beforeEach(() => authedFetch.mockReset());

  it("posts a DRAFT with the remaining lines and an idempotency key", async () => {
    authedFetch.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/delivery-orders-mfg/deliverable-so-lines")) {
        return { lines: [{ soItemId: "a", remaining: 2 }, { soItemId: "b", remaining: 0 }] };
      }
      return { id: "do-9", doNumber: "HC-DO-9" };
    });
    const { result } = renderHook(() => useConvertSoToDoDraft(), { wrapper });
    const res = await result.current.mutateAsync("HC-SO-1");
    expect(res).toEqual({ id: "do-9", doNumber: "HC-DO-9" });
    expect(authedFetch.mock.calls[0]![0]).toBe("/delivery-orders-mfg/deliverable-so-lines?docNos=HC-SO-1");
    const [url, init] = authedFetch.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/from-sos");
    expect(JSON.parse(String(init.body))).toEqual({ asDraft: true, picks: [{ soItemId: "a", qty: 2 }] });
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("refuses with a plain sentence when nothing is left to deliver", async () => {
    authedFetch.mockResolvedValue({ lines: [{ soItemId: "a", remaining: 0 }] });
    const { result } = renderHook(() => useConvertSoToDoDraft(), { wrapper });
    result.current.mutate("HC-SO-1");
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toMatch(/Nothing is left to deliver on HC-SO-1/);
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });
});
