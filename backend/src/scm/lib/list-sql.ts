
import type { Sql } from 'postgres';
import { getSql, resolveDatabaseUrl } from '../../db/pg';
import { recordStep } from '../../lib/step-timing';
import { PgrestSqlUnsupported } from './pgrest-sql';

export const LIST_SQL_OFF_MS = 10 * 60_000;
const offUntil = new Map<string, number>();

export async function trySql<T>(
  env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string },
  label: string,
  run: (sql: Sql) => Promise<T>,
  now: () => number = Date.now,
): Promise<T | null> {
  const url = resolveDatabaseUrl(env);
  if (!url) return null;
  if (now() < (offUntil.get(label) ?? 0)) { recordStep(`sql-${label}-skip`, 0); return null; }
  const t0 = now();
  try {
    const out = await run(getSql(url));
    recordStep(`sql-${label}`, now() - t0);
    return out;
  } catch (e) {
    if (e instanceof PgrestSqlUnsupported) { recordStep(`sql-${label}-unsupported`, 0); return null; }
    offUntil.set(label, now() + LIST_SQL_OFF_MS);
    recordStep(`sql-${label}-error`, now() - t0);
    console.warn(`[list-sql] ${label} failed, using the PostgREST path:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Tests only. */
export function resetListSqlMemo(): void {
  offUntil.clear();
}

/** A SELECT's rows as PostgREST would serialise them: Postgres's own JSON for
 *  every type (dates stay 'YYYY-MM-DD' strings, arrays stay arrays), which is
 *  what PostgREST builds its response from. `inner` is a complete SELECT. */
export async function jsonRows<T>(sql: Sql, inner: string, values: readonly string[]): Promise<T[]> {
  const res = await sql.unsafe(`SELECT coalesce(json_agg(t), '[]'::json)::text AS body FROM (${inner}) t`, values as string[]);
  const body = (res[0] as { body?: string } | undefined)?.body ?? '[]';
  return JSON.parse(body) as T[];
}
