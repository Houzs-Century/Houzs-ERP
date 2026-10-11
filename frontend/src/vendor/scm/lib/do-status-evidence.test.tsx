/* PROOF OF DELIVERY MUST SURVIVE THE ROUTE IT TRAVELLED.
 *
 * NOTE, 2026-08-21: the customer SIGNATURE this file was originally written
 * around is retired (owner: 「签收签名不需要 先 delete掉」). The photo and the GPS
 * fix are kept, and everything below is now about those two. The structural
 * point is unchanged and is the reason this file survives the removal: evidence
 * has to be able to travel through the ONE shared writer, or the surfaces go
 * back to closing deliveries with nothing attached.
 *
 * A delivery order can be closed from four screens. Until this test existed,
 * exactly ONE of them attached the evidence and the GPS fix:
 *
 *   · frontend/src/mobile/MobilePOD.tsx            evidence — via a RAW fetch
 *   · frontend/src/mobile/MobileDeliveryPlanning.tsx   none  — raw fetch
 *   · frontend/src/pages/scm-v2/DeliveryOrderDetailV2.tsx   none — shared hook
 *   · frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx none — shared hook
 *
 * The cause was a TYPE, not four careless call sites.
 * `useUpdateMfgDeliveryOrderStatus` was declared `{ id, status }` and posted
 * `JSON.stringify({ status })`, so evidence could not travel through it even if
 * a caller held some. MobilePOD's bypass was therefore not sloppiness — it was
 * the only way to send proof at all, and every screen that used the shared hook
 * silently filed a delivery with no customer-side proof.
 *
 * So the fix widens the hook and the tests below pin BOTH halves:
 *
 *   1. evidence travels when given          (the capability that did not exist)
 *   2. absent evidence sends NO evidence keys (a plain status change must never
 *      blank a POD that is already on the row — the backend only writes these
 *      columns when present, and the client must not send empty strings that
 *      would defeat that)
 *   3. ONE writer                           (the root-cause guard)
 *
 * (3) is the one that keeps this fixed. Two raw fetches to the same endpoint is
 * how the divergence arose; a third would rebuild it. The scan strips comments
 * first, because this file and MobilePOD's header both NAME the endpoint in
 * prose and a naive grep would match its own documentation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useUpdateMfgDeliveryOrderStatus } from "./delivery-order-queries";

vi.mock("./dialog-service", () => ({ serviceNotify: vi.fn() }));

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("./authed-fetch", () => ({ authedFetch }));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

/** The body the hook actually PATCHed, parsed. */
function sentBody(): Record<string, unknown> {
  const [, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-1", status: "DELIVERED" } });
});

describe("useUpdateMfgDeliveryOrderStatus carries proof of delivery", () => {
  test("a photo and a GPS fix reach the endpoint", async () => {
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });

    await result.current.mutateAsync({
      id: "do-1",
      status: "DELIVERED",
      evidence: {
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
      podKey: "pod/2026/do-1.jpg",
      podLat: 3.139,
      podLng: 101.6869,
      podAccuracyM: 12,
      podLocatedAt: "2026-08-21T02:00:00.000Z",
    });
  });

  test("a partial capture sends only what was captured", async () => {
    /* A denied location permission, or a driver who takes the photo and moves
       off before the fix lands, must still close the delivery — the backend
       deliberately DROPS an out-of-range fix rather than refusing
       (delivery-orders-mfg.ts), so the client must never turn a missing reading
       into a sent one. */
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });

    await result.current.mutateAsync({
      id: "do-1",
      status: "DELIVERED",
      evidence: { podKey: "pod/2026/do-1.jpg" },
    });

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({
      status: "DELIVERED",
      podKey: "pod/2026/do-1.jpg",
    });
  });

  test("no evidence sends no evidence keys — a status change never blanks a POD", async () => {
    const { result } = renderHook(() => useUpdateMfgDeliveryOrderStatus(), { wrapper });

    await result.current.mutateAsync({ id: "do-1", status: "CANCELLED" });

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({ status: "CANCELLED" });
  });
});

// ── The root-cause guard ────────────────────────────────────────────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/* The writers that are ALLOWED to name this endpoint, and why each is here.
 * A file appearing that is not on this list is the divergence coming back.
 *
 *   delivery-order-queries.ts   THE writer. Every screen goes through it.
 *
 *   MobileModuleDetail.tsx      A DECLARATIVE action table shared by ~10
 *     document types — each row is `{ path, method, body }` run by one generic
 *     mutation, so it cannot call a DO-specific hook without special-casing the
 *     table. It is on this list rather than fixed because its DO ladder stops
 *     at SIGNED and never writes DELIVERED (`if (st === "CANCELLED" || st ===
 *     "DELIVERED" …) return out`), by an explicit decision recorded there:
 *     "DELIVERED is the POD screen's job, so it is never offered here."
 *
 *     KNOWN-OPEN, and deliberately not silent: SIGNED still counts as delivered
 *     everywhere downstream (it is in the `delivered` list bucket and satisfies
 *     the Sales-Invoice gate), so this rung closes a delivery with no evidence —
 *     the same class of hole, one rung lower. Logged as a bug entry rather than
 *     fixed in the same PR as the type change.
 *
 *     PARTLY ADDRESSED 2026-08-21. That rung was labelled "Mark Signed" and now
 *     reads "Mark delivered": with the signature retired, naming it for evidence
 *     the product cannot collect was the falsest part of it. It still writes
 *     SIGNED and still attaches nothing, so the entry stays OPEN — removing the
 *     rung or repointing it is the owner's call, not a unilateral fix.
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
    /* Comments are stripped first: MobilePOD's header and this file's own
       explain the endpoint in prose, and documentation is not a call site. */
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
