// Cache-key identity for hooks/useQuery.
//
// The bug this pins: the key used to be `["uq", fetcher.toString(), ...deps]`.
// Two callsites whose fetcher bodies are textually identical therefore shared
// ONE cache entry, and one screen could render another's data. 50 of the app's
// 126 callsites had a textual twin; they survived only because every twin
// happened to want the same data. The first pair that didn't would have
// cross-fed silently.
//
// These tests drive a REAL QueryClient, so they assert cache behaviour rather
// than string equality of a key.
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { buildQueryKey, useQuery as useHouzsQuery } from "./useQuery";

/* Two callsites whose fetcher bodies are BYTE-IDENTICAL but which mean
   different things and return different data — `fetchA.toString() ===
   fetchB.toString()` while `fetchA() !== fetchB()`.

   A factory is the honest model of the real hazard. In the app the two bodies
   are identical because they were TYPED identically in two files; here they are
   identical because they came from one factory. Either way the source text is
   the same and the closure is not, which is precisely what a source-text key
   cannot see. */
const makeIdenticalFetchers = () => {
  const make = (payload: string) => () => Promise.resolve(payload);
  return { fetchA: make("A-DATA"), fetchB: make("B-DATA") };
};

describe("useQuery cache keys", () => {
  test("the two fetchers really are textually identical (guards the premise)", () => {
    const { fetchA, fetchB } = makeIdenticalFetchers();
    expect(fetchA.toString()).toBe(fetchB.toString());
  });

  test("distinct callsites with identical fetcher bodies get DISTINCT cache entries", async () => {
    const { fetchA, fetchB } = makeIdenticalFetchers();
    const qc = new QueryClient();

    await qc.fetchQuery({ queryKey: buildQueryKey("screen-a"), queryFn: fetchA });
    await qc.fetchQuery({ queryKey: buildQueryKey("screen-b"), queryFn: fetchB });

    // Each screen sees its OWN data. Under the old source-text key both of
    // these read "A-DATA": one key, one entry, first writer wins.
    expect(qc.getQueryData(buildQueryKey("screen-a"))).toBe("A-DATA");
    expect(qc.getQueryData(buildQueryKey("screen-b"))).toBe("B-DATA");
    expect(qc.getQueryCache().getAll()).toHaveLength(2);
  });

  test("the OLD source-text scheme really did collide (regression witness)", async () => {
    const { fetchA, fetchB } = makeIdenticalFetchers();
    const qc = new QueryClient();
    const legacyKey = (f: () => Promise<string>) => ["uq", f.toString()];

    // staleTime mirrors the app's global 30s (lib/queryClient.ts) — a warm
    // cache is the normal state, and it is exactly when the wrong data is
    // handed over: screen B's fetcher never even runs.
    await qc.fetchQuery({ queryKey: legacyKey(fetchA), queryFn: fetchA, staleTime: 60_000 });
    const servedToB = await qc.fetchQuery({
      queryKey: legacyKey(fetchB), queryFn: fetchB, staleTime: 60_000,
    });

    // One entry for two unrelated callsites, and screen B is served screen A's
    // data. This is the bug, reproduced.
    expect(qc.getQueryCache().getAll()).toHaveLength(1);
    expect(servedToB).toBe("A-DATA");
  });

  test("callsites that SHARE a key still share an entry (request dedup preserved)", async () => {
    // Deliberate sharing is why the mail-center and projects lookups are cheap:
    // four screens ask for /api/mail-center/addresses and one fetch serves all.
    const qc = new QueryClient();
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(["a@x.my"]);
    };

    const key = buildQueryKey("/api/mail-center/addresses");
    await qc.fetchQuery({ queryKey: key, queryFn: load, staleTime: 60_000 });
    await qc.fetchQuery({ queryKey: key, queryFn: load, staleTime: 60_000 });

    expect(qc.getQueryCache().getAll()).toHaveLength(1);
    expect(calls).toBe(1); // second read served from cache, not refetched
  });

  test("deps still separate one callsite's parameters", () => {
    expect(buildQueryKey("/api/assr/:", ["case-1"]))
      .not.toEqual(buildQueryKey("/api/assr/:", ["case-2"]));
  });

  test("array keys compose, and stay namespaced under uq", () => {
    expect(buildQueryKey("assr-list", [1])).toEqual(["uq", "assr-list", 1]);
    expect(buildQueryKey(["assr-list", "export"], [1])).toEqual(["uq", "assr-list", "export", 1]);
  });

  test("the uq namespace cannot collide with the app's named TanStack roots", () => {
    // sharedInvalidate.ts invalidates roots like ["grns-paged", ...]. A wrapper
    // callsite keyed "grns-paged" must NOT land on that root's entry.
    expect(buildQueryKey("grns-paged")[0]).toBe("uq");
    expect(buildQueryKey("grns-paged")).not.toEqual(["grns-paged"]);
  });
});

describe("query cancellation", () => {
  test("TanStack aborts a superseded request signal", async () => {
    const qc = new QueryClient();
    let firstSignal: AbortSignal | undefined;
    const pending = qc.fetchQuery({
      queryKey: buildQueryKey("search", ["A"]),
      queryFn: ({ signal }) => {
        firstSignal = signal;
        return new Promise<string>(() => undefined);
      },
    });

    await Promise.resolve();
    await qc.cancelQueries({ queryKey: buildQueryKey("search", ["A"]), exact: true });

    expect(firstSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeTruthy();
  });

  test("the real wrapper cancels A when rerendered with A1 and only exposes A1", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const signals = new Map<string, AbortSignal>();
    const resolvers = new Map<string, (value: string) => void>();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) => useHouzsQuery(
        "live-search",
        (signal) => new Promise<string>((resolve, reject) => {
          signals.set(term, signal!);
          resolvers.set(term, resolve);
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
        [term],
      ),
      { initialProps: { term: "A" }, wrapper },
    );

    await waitFor(() => expect(signals.has("A")).toBe(true));
    rerender({ term: "A1" });
    await waitFor(() => expect(signals.get("A")?.aborted).toBe(true));
    await waitFor(() => expect(signals.has("A1")).toBe(true));
    resolvers.get("A1")?.("A1 results");

    await waitFor(() => expect(result.current.data).toBe("A1 results"));
    expect(result.current.error).toBeNull();
    expect(qc.getQueryData(buildQueryKey("live-search", ["A"]))).toBeUndefined();
  });
});
