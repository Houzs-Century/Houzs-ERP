/**
 * Usage counters for /api/delivery-sheet — how often the HC Delivery sheet
 * calls each endpoint, and how many records it carried away.
 *
 * See the migration (20260924T2200_scm_sheet_sync_usage.sql) for WHY the ERP
 * has to count this itself. In short: the sheet's own log counts SCRIPT RUNS,
 * one run is several requests, and a script that stops logging vanishes from
 * it while still running.
 *
 * Two rules this module exists to keep:
 *
 *   1. A counter may never break the sync. Every write is best-effort — it
 *      runs after the response is decided, its failure is logged and
 *      swallowed, and it rides `waitUntil` where the runtime offers one.
 *   2. The label is the route PATTERN, never the URL. `?since=` is a
 *      timestamp and /feed-by-docnos carries order numbers; neither belongs
 *      in a key that is kept forever.
 */

/** Where the router is mounted, so a label reads as the full path. */
const MOUNT = "/api/delivery-sheet";

/** A label longer than this is a scanner, not the sheet — clamp it. */
const MAX_LABEL = 80;

export const SHEET_USAGE_UPSERT_SQL = `
  INSERT INTO scm.sheet_sync_usage (endpoint, day, calls, rows_out, errors, first_at, last_at)
  VALUES (?, (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 1, ?, ?, now(), now())
  ON CONFLICT (endpoint, day) DO UPDATE SET
    calls    = sheet_sync_usage.calls + 1,
    rows_out = sheet_sync_usage.rows_out + EXCLUDED.rows_out,
    errors   = sheet_sync_usage.errors + EXCLUDED.errors,
    last_at  = now()`;

/**
 * "GET /api/delivery-sheet/so-since" from the method and the matched Hono
 * pattern. A pattern that did not match a route still arrives as a raw
 * pathname, so it is clamped rather than trusted.
 */
export function sheetUsageEndpoint(method: string, routePath: string): string {
  const path = routePath.startsWith(MOUNT) ? routePath : `${MOUNT}${routePath.startsWith("/") ? "" : "/"}${routePath}`;
  return `${method.toUpperCase()} ${path}`.slice(0, MAX_LABEL);
}

type UsageDb = {
  prepare(sql: string): { bind(...binds: unknown[]): { run(): Promise<unknown> } };
};

/**
 * Add one call to today's counter. Never throws.
 *
 * @param rows  records the response carried (0 when it carried none)
 * @param errored  the response was >= 400
 */
export async function recordSheetUsage(
  db: UsageDb | undefined,
  endpoint: string,
  rows: number,
  errored: boolean,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(SHEET_USAGE_UPSERT_SQL)
      .bind(endpoint, Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0, errored ? 1 : 0)
      .run();
  } catch (e) {
    // A counter is not worth a 500. The sync's own outcome is already decided.
    console.error(`[sheet-usage] ${endpoint}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
