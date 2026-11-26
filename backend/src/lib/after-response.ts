import { AsyncLocalStorage } from "node:async_hooks";

type WaitUntil = (p: Promise<unknown>) => void;

const store = new AsyncLocalStorage<WaitUntil>();

/** Run a request's handler so afterResponse() inside it defers to `waitUntil`. */
export function withAfterResponse<T>(waitUntil: WaitUntil, fn: () => Promise<T>): Promise<T> {
  return store.run(waitUntil, fn);
}

/** Defer `task` past the response when inside a request; run it inline otherwise. */
export async function afterResponse(label: string, task: () => Promise<unknown>): Promise<void> {
  const run = () => task().then(() => undefined, (e: unknown) => {
    console.error(`[after-response] ${label} failed:`, e);
  });
  const waitUntil = store.getStore();
  if (!waitUntil) return run();
  waitUntil(run());
}
