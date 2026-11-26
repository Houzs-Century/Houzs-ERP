import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useCancelMfgDeliveryOrder, useUpdateMfgDeliveryOrderStatus } from "./delivery-order-queries";

vi.mock("./dialog-service", () => ({ serviceNotify: vi.fn() }));

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("./authed-fetch", () => ({ authedFetch }));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

function sentBody(): Record<string, unknown> {
  const [, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-1", status: "DELIVERED" } });
});

describe("useUpdateMfgDeliveryOrderStatus carries proof of delivery", () => {
  test("a signature and a GPS fix reach the endpoint", async () => {
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });

    await result.current.mutateAsync({
      id: "do-1",
      status: "DELIVERED",
      evidence: {
        signatureData: "data:image/png;base64,SIGNED",
        podKey: "pod/2026/do-1.jpg",
        podLat: 3.139,
        podLng: 101.6869,
        podAccuracyM: 12,
        podLocatedAt: "2026-08-21T02:00:00.000Z",
      },
    });

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/do-1/status");
    expect(init.method).toBe("PATCH");
    expect(sentBody()).toEqual({
      status: "DELIVERED",
      signatureData: "data:image/png;base64,SIGNED",
      podKey: "pod/2026/do-1.jpg",
      podLat: 3.139,
      podLng: 101.6869,
      podAccuracyM: 12,
      podLocatedAt: "2026-08-21T02:00:00.000Z",
    });
  });

  test("a partial capture sends only what was captured", async () => {
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });

    await result.current.mutateAsync({
      id: "do-1",
      status: "DELIVERED",
      evidence: { signatureData: "data:image/png;base64,SIGNED" },
    });

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({
      status: "DELIVERED",
      signatureData: "data:image/png;base64,SIGNED",
    });
  });

  test("no evidence sends no evidence keys — a status change never blanks a POD", async () => {
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });

    await result.current.mutateAsync({ id: "do-1", status: "IN_TRANSIT" });

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({ status: "IN_TRANSIT" });
  });
});

/* Owner 2026-09-14 (「DO cancel need pop out window for reason」): the server
   refuses a cancel without a reason, so the cancel hook's type REQUIRES one and
   sends it beside status CANCELLED, on the same endpoint as every other move. */
describe("useCancelMfgDeliveryOrder carries the reason", () => {
  test("status CANCELLED and the reason reach the status endpoint", async () => {
    const { result } = renderHook(() => useCancelMfgDeliveryOrder(), { wrapper });

    await result.current.mutateAsync({ id: "do-1", reason: "Customer postponed the delivery" });

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/do-1/status");
    expect(init.method).toBe("PATCH");
    expect(sentBody()).toEqual({ status: "CANCELLED", reason: "Customer postponed the delivery" });
  });
});


const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/* The writers that are ALLOWED to name this endpoint, and why each is here.
 * A file appearing that is not on this list is the divergence coming back.
 *
 *   delivery-order-queries.ts   THE writer. Every screen goes through it.
 *
 *   MobileModuleDetail.tsx      A DECLARATIVE action table shared by ~10
 *     document types — each row is `{ path, method, body }` run by one generic
 *     mutation, so it cannot call a DO-specific hook without special-casing the
 *     table. It is on this list rather than fixed because its DO ladder now stops
 *     at IN_TRANSIT ("Mark In Transit") and never writes SIGNED or DELIVERED
 *     (`if (st === "CANCELLED" || st === "DELIVERED" …) return out`). SIGNED /
 *     DELIVERED are the POD screen's job, which closes a delivery WITH a
 *     signature.
 *
 *     The "Mark Signed" rung that used to sit here (writing SIGNED with no
 *     evidence, the same class of hole one rung lower — bug 0481) was REMOVED on
 *     2026-08-21 (owner: drop "Mark signed" system-wide), which closes that hole.
 */
const ALLOWED_WRITERS = [
  "mobile/MobileModuleDetail.tsx",
  "vendor/scm/lib/delivery-order-queries.ts",
];

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

describe("the delivery-order status endpoint has ONE writer", () => {
  test("only the shared hook and the declared exception PATCH /delivery-orders-mfg/:id/status", () => {
    const writers = productionSources()
      .filter((path) => {
        const source = readFileSync(path, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        return /delivery-orders-mfg\/[^`'"]*\/status/.test(source);
      })
      .map((path) => relative(SRC, path).replaceAll("\\", "/"));

    expect(writers.sort()).toEqual(ALLOWED_WRITERS);
  });
});
