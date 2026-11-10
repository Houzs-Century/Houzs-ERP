// after-response — run a best-effort task AFTER the response is sent.
//
// Some work a request triggers must not make the user wait, but sits deep in a
// helper that has no Hono context (the DO source/rack stamp is called from the
// ship chokepoint, five call sites away from `c`). The request middleware in
// index.ts runs every request inside `withAfterResponse(waitUntil, ...)`;
// `afterResponse(task)` then hands the task to the request's waitUntil and
// returns at once. Outside a request (cron, scripts, tests) there is no
// response to protect, so the task simply runs and is awaited.
//
// The task must be safe to lose: waitUntil work can be cut off. A failure is
// logged, never thrown.
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
