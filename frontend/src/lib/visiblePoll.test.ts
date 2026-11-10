/* The shared visible-only poll (lib/visiblePoll.ts). Pinned: a hidden tab is
   never polled; returning to it refetches once; however many readers register
   one key, a due key costs one request; a key refreshed by someone else in the
   meantime is not fetched again; a disabled query is not woken. */

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  POLL_TICK_MS,
  onPollVisibilityChange,
  pollTick,
  registerVisiblePoll,
  resetVisiblePollForTests,
} from "./visiblePoll";

let visibility: DocumentVisibilityState = "visible";
const KEY = ["badge", "x"] as const;

function setup(opts: { enabled?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fn = vi.fn(async () => ({ count: 1 }));
  const observer = new QueryObserver(client, { queryKey: KEY, queryFn: fn, enabled: opts.enabled ?? true });
  const unsubscribe = observer.subscribe(() => {});
  return { client, fn, unsubscribe };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  resetVisiblePollForTests();
  vi.restoreAllMocks();
});

describe("visible-only shared poll", () => {
  test("a due key is fetched once per tick, however many readers registered it", async () => {
    const { client, fn, unsubscribe } = setup();
    await settle();
    expect(fn).toHaveBeenCalledTimes(1); // the mount's own first read
    const offs = [registerVisiblePoll(KEY, 60_000, client), registerVisiblePoll(KEY, 60_000, client)];
    const loadedAt = client.getQueryState(KEY)!.dataUpdatedAt;

    pollTick(loadedAt + 30_000); // not due
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);

    pollTick(loadedAt + 60_000); // due: one request for both readers
    await settle();
    expect(fn).toHaveBeenCalledTimes(2);
    offs.forEach((off) => off());
    unsubscribe();
  });

  test("a hidden tab is never polled, and coming back refetches once", async () => {
    const { client, fn, unsubscribe } = setup();
    await settle();
    const off = registerVisiblePoll(KEY, 60_000, client);
    const loadedAt = client.getQueryState(KEY)!.dataUpdatedAt;

    visibility = "hidden";
    pollTick(loadedAt + 10 * 60_000);
    onPollVisibilityChange(loadedAt + 10 * 60_000);
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);

    visibility = "visible";
    onPollVisibilityChange(loadedAt + 10 * 60_000);
    await settle();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    unsubscribe();
  });

  test("returning within seconds of the last answer costs nothing", async () => {
    const { client, fn, unsubscribe } = setup();
    await settle();
    const off = registerVisiblePoll(KEY, 60_000, client);
    const loadedAt = client.getQueryState(KEY)!.dataUpdatedAt;
    onPollVisibilityChange(loadedAt + 5_000);
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    unsubscribe();
  });

  test("a key refreshed by someone else since (an invalidation) is not fetched again", async () => {
    const { client, fn, unsubscribe } = setup();
    await settle();
    const off = registerVisiblePoll(KEY, 60_000, client);
    const loadedAt = client.getQueryState(KEY)!.dataUpdatedAt;
    client.setQueryData(KEY, { count: 2 }, { updatedAt: loadedAt + 50_000 });
    pollTick(loadedAt + 60_000);
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    unsubscribe();
  });

  test("a disabled query is not woken by the poll", async () => {
    const { client, fn, unsubscribe } = setup({ enabled: false });
    const off = registerVisiblePoll(KEY, 60_000, client);
    pollTick(Date.now() + 10 * 60_000);
    await settle();
    expect(fn).not.toHaveBeenCalled();
    off();
    unsubscribe();
  });

  test("the timer runs only while something is registered", () => {
    vi.useFakeTimers();
    try {
      const { client, fn, unsubscribe } = setup({ enabled: false });
      const setSpy = vi.spyOn(globalThis, "setInterval");
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      const off = registerVisiblePoll(KEY, 60_000, client);
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), POLL_TICK_MS);
      off();
      off(); // twice is harmless
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(fn).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
