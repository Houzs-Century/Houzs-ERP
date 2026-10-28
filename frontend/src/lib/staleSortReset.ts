// ----------------------------------------------------------------------------
// staleSortReset — clear the one sort every browser is stuck on, once, silently.
//
// WHY. Owner, 2026-08-05: "为什么你不是后台 reset 呢？基本上我们只会 reset 一次，
// 所以你把这个 button remove 掉，然后只 reset 一次就可以了".
//
// He is right, and the previous answer was a chore dressed as a fix. DataTable
// persists each table's sort in `dt:sort:<tableId>` and replays it on mount, so
// a column clicked once — months ago — became that browser's permanent ORDER BY
// and the backend's newest-first default never applied. `resetLayout()` now
// clears it (#1603), but only for someone who knows to open the Columns drawer
// and press Reset, on every list page, on every device they use. Nobody will,
// and nobody should have to.
//
// A one-shot migration is the honest shape: the stale values were written by a
// bug, so removing them is cleanup, not a preference change.
//
// WHAT IT DOES NOT TOUCH. Only `dt:sort:*`. Column visibility, order, widths,
// pinning and the mobile card/table choice are all real user preferences that
// nobody complained about — wiping those would be taking something away to fix
// something else.
//
// RUNS EXACTLY ONCE per browser, guarded by its own marker key. A second run
// would undo a sort the user deliberately chose AFTER the fix landed, which is
// the difference between cleaning up a bug and overriding a person.
// ----------------------------------------------------------------------------

/** Bump ONLY if a future bug makes another one-shot clear necessary. Reusing the
 *  same marker for a new purpose would skip the browsers that already ran it. */
const MARKER = 'dt:sort-reset:2026-08-05';
const SORT_PREFIX = 'dt:sort:';

/**
 * Remove every persisted DataTable sort, once. Safe to call on every boot.
 *
 * Returns the number of keys removed — 0 on every run after the first, and 0 in
 * a browser that never had one. Never throws: private mode and a full quota both
 * make localStorage hostile, and a telemetry-grade cleanup must not take the app
 * down with it.
 */
export function clearStaleTableSorts(): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    if (localStorage.getItem(MARKER)) return 0;

    /* Collect first, delete after: removing while iterating by index shifts
       every later key down and silently skips half of them. */
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SORT_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);

    localStorage.setItem(MARKER, '1');
    return doomed.length;
  } catch {
    /* Private mode / quota — the sort simply stays until the user resets it by
       hand. Strictly better than a boot that throws. */
    return 0;
  }
}
