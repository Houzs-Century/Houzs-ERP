// Global test setup — runs before every test file (vitest `setupFiles`).
//
// WHY THIS EXISTS. React Testing Library unmounts rendered trees automatically
// ONLY when a global `afterEach(cleanup)` is registered, which its Vitest entry
// (`@testing-library/react` under `globals: false`) does NOT do on its own — that
// auto-registration is keyed off `globalThis.afterEach`, absent when globals are
// off. Without it, every `render()` in the suite leaves its tree MOUNTED for the
// rest of the process. A mounted component keeps its effects alive, so any timer
// an effect scheduled (e.g. `useDebouncedValue`'s `window.setTimeout`) is never
// cleared — its cleanup only runs on unmount, which never comes. The callback
// then fires after the file's jsdom is gone, calls `setState`, React reaches for
// `window`, and the process throws `ReferenceError: window is not defined`.
//
// Vitest attributes that unhandled error to whatever test file happened to be
// running when the stray callback landed — usually an innocent one — and fails
// the whole `npm test`. On a deploy that SKIPS the frontend build+release step
// (see BUG-HISTORY: the leaked-timer entries), so the SPA silently does not ship.
// It is timing-dependent, so it passes locally and strikes CI at random.
//
// Registering cleanup here fixes it at the root for the ~22 test files that
// render without unmounting. `cleanup()` is idempotent, so the three files that
// already call it by hand (DataTable / ColumnsDrawer / DataTableLayoutSync) are
// unaffected. This does not paper over a leak — unmounting RUNS the effect
// cleanups, which is exactly where the timers are cleared.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetInVisitColFilters } from "./components/dataTableColFilterMemory";

afterEach(() => {
  cleanup();
  /* The in-visit funnel + search memory is module-scoped, so a search one test
     typed would narrow the next test's table in the same file. In the app that
     memory is the point; here each test starts as a fresh page load. */
  resetInVisitColFilters();
  /* A DataTable writes its column filters into the address (`cf.<tableId>`).
     jsdom keeps one address for a whole file, so a funnel one test sets would
     open the next test's table already filtered. In the app every page has
     its own address; here each test gets a clean one. (Node-environment
     files have no window at all.) */
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const stale = [...url.searchParams.keys()].filter((k) => k.startsWith("cf."));
  if (stale.length > 0) {
    for (const k of stale) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url);
  }
});
