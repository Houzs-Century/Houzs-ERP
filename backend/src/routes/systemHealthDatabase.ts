import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, type DB } from "../db/client";

// ---------------------------------------------------------------------------
// GET /api/admin/health/database — database load at a glance (DEV-35).
// Mounted inside systemHealth.ts, so the IT-pages gate there covers it.
//
// Every metric is ONE catalog read in its own short transaction with
// `SET LOCAL statement_timeout`, so a stalled catalog cannot hold a pooled
// connection, and a failed metric reports { ok:false, error } without
// aborting the others. SET LOCAL (never SET): Hyperdrive sits on the session
// pooler, and a plain SET would leak into the next request's session.
// ---------------------------------------------------------------------------

// The SG micro instance caps at 60 connections (backend/wrangler.toml, the
// [[hyperdrive]] comment). Reported beside max_connections; the verdict uses
// whichever is smaller.
export const POOLER_CONNECTION_CAP = 60;

export const LONG_TX_WARNING_SECONDS = 30;
export const LONG_TX_CRITICAL_SECONDS = 5 * 60;
export const LOCK_WAIT_WARNING_COUNT = 1;
export const LOCK_WAIT_CRITICAL_COUNT = 5;
export const LOCK_WAIT_CRITICAL_SECONDS = 60;
export const CONNECTION_WARNING_RATIO = 0.7;
export const CONNECTION_CRITICAL_RATIO = 0.9;

export type Verdict = "ok" | "warning" | "critical";

export function longTransactionVerdict(oldestSeconds: number | null): Verdict {
  if (oldestSeconds === null) return "ok";
  if (oldestSeconds > LONG_TX_CRITICAL_SECONDS) return "critical";
  if (oldestSeconds > LONG_TX_WARNING_SECONDS) return "warning";
  return "ok";
}

export function lockWaitVerdict(waiting: number, longestWaitSeconds: number | null): Verdict {
  if (waiting >= LOCK_WAIT_CRITICAL_COUNT) return "critical";
  if (longestWaitSeconds !== null && longestWaitSeconds > LOCK_WAIT_CRITICAL_SECONDS) return "critical";
  if (waiting >= LOCK_WAIT_WARNING_COUNT) return "warning";
  return "ok";
}

export function connectionVerdict(used: number, limit: number): Verdict {
  const ratio = used / limit;
  if (ratio > CONNECTION_CRITICAL_RATIO) return "critical";
  if (ratio > CONNECTION_WARNING_RATIO) return "warning";
  return "ok";
}

// What pg_stat_activity shows in `query` for a session this role may not
// inspect (no pg_read_all_stats). state, xact_start, wait_event_type and
// backend_type come back NULL for those rows.
const HIDDEN_QUERY = "<insufficient privilege>";

// Client sessions only. A hidden row has a NULL backend_type, so it is kept;
// datid IS NOT NULL drops background processes, which have no database.
const CLIENT_SESSIONS = sql`pid <> pg_backend_pid()
  AND datid IS NOT NULL
  AND (backend_type = 'client backend' OR backend_type IS NULL)`;

type MetricResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function measure<T extends object>(read: () => Promise<T>): Promise<MetricResult<T>> {
  try {
    return { ok: true, ...(await read()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function readRow<T extends Record<string, unknown>>(db: DB, query: SQL): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const rows = await tx.execute<T>(query);
    return rows[0] as T;
  });
}

type LongTxSession = { seconds: number; state: string | null; waitEventType: string | null; query: string | null };

async function longTransactions(db: DB) {
  const row = await readRow<{ hidden: number; count: number; top: string }>(
    db,
    sql`WITH s AS (
          SELECT state, wait_event_type, query, xact_start
          FROM pg_stat_activity WHERE ${CLIENT_SESSIONS}
        ), long AS (
          SELECT * FROM s
          WHERE state IS DISTINCT FROM 'idle'
            AND xact_start < now() - make_interval(secs => ${LONG_TX_WARNING_SECONDS})
        )
        SELECT
          (SELECT count(*) FROM s WHERE query = ${HIDDEN_QUERY})::int AS hidden,
          (SELECT count(*) FROM long)::int AS count,
          (SELECT coalesce(json_agg(t), '[]'::json)::text FROM (
            SELECT EXTRACT(EPOCH FROM now() - xact_start)::float8 AS seconds,
                   state, wait_event_type AS "waitEventType", left(query, 200) AS query
            FROM long ORDER BY xact_start LIMIT 5
          ) t) AS top`,
  );
  const sessions = JSON.parse(row.top) as LongTxSession[];
  return {
    value: row.count,
    limit: null,
    threshold: "Warning when a transaction has been open over 30 s, critical over 5 min",
    verdict: longTransactionVerdict(sessions[0]?.seconds ?? null),
    sessions,
    hiddenSessions: row.hidden,
  };
}

// pg_locks rather than pg_stat_activity.wait_event_type = 'Lock': the same
// set of sessions, but pg_locks is readable without pg_read_all_stats and
// carries waitstart, which pg_stat_activity has no column for.
async function lockWaits(db: DB) {
  const row = await readRow<{ count: number; longestWaitSeconds: number | null }>(
    db,
    sql`SELECT count(DISTINCT pid)::int AS count,
               max(EXTRACT(EPOCH FROM now() - waitstart))::float8 AS "longestWaitSeconds"
        FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()`,
  );
  return {
    value: row.count,
    limit: null,
    threshold: "Warning at 1 waiting session, critical at 5 or any wait over 60 s",
    verdict: lockWaitVerdict(row.count, row.longestWaitSeconds),
    longestWaitSeconds: row.longestWaitSeconds,
  };
}

async function connections(db: DB) {
  const row = await readRow<{ used: number; hidden: number; maxConnections: number }>(
    db,
    sql`SELECT count(*)::int AS used,
               count(*) FILTER (WHERE query = ${HIDDEN_QUERY})::int AS hidden,
               (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS "maxConnections"
        FROM pg_stat_activity
        WHERE datid IS NOT NULL AND (backend_type = 'client backend' OR backend_type IS NULL)`,
  );
  const limit = Math.min(row.maxConnections, POOLER_CONNECTION_CAP);
  return {
    value: row.used,
    limit,
    threshold: "Warning above 70% of the smaller limit, critical above 90%",
    verdict: connectionVerdict(row.used, limit),
    maxConnections: row.maxConnections,
    poolerCap: POOLER_CONNECTION_CAP,
    hiddenSessions: row.hidden,
  };
}

async function databaseSize(db: DB) {
  const row = await readRow<{ bytes: number; largest: string }>(
    db,
    sql`SELECT pg_database_size(current_database())::float8 AS bytes,
          (SELECT coalesce(json_agg(t), '[]'::json)::text FROM (
            SELECT n.nspname || '.' || c.relname AS name, pg_total_relation_size(c.oid)::float8 AS bytes
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'm')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg_toast%'
            ORDER BY bytes DESC LIMIT 5
          ) t) AS largest`,
  );
  return {
    value: row.bytes,
    limit: null,
    threshold: "Information only: no plan size limit is documented in the repo",
    verdict: "ok" as Verdict,
    largestTables: JSON.parse(row.largest) as Array<{ name: string; bytes: number }>,
  };
}

async function tempFiles(db: DB) {
  const row = await readRow<{ tempFiles: number; tempBytes: number; statsReset: string | null }>(
    db,
    sql`SELECT temp_files::float8 AS "tempFiles", temp_bytes::float8 AS "tempBytes",
               to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "statsReset"
        FROM pg_stat_database WHERE datname = current_database()`,
  );
  return {
    value: row.tempBytes,
    limit: null,
    threshold: "Information only: totals since the statistics were last reset",
    verdict: "ok" as Verdict,
    tempFiles: row.tempFiles,
    statsReset: row.statsReset,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.get("/database", async (c) => {
  let db: DB;
  try {
    db = getDb(c.env);
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
  }
  // Sequential on purpose: the client holds one connection (db/pg.ts, max 1).
  const longTx = await measure(() => longTransactions(db));
  const locks = await measure(() => lockWaits(db));
  const conns = await measure(() => connections(db));
  const size = await measure(() => databaseSize(db));
  const temp = await measure(() => tempFiles(db));

  const hidden = Math.max(longTx.ok ? longTx.hiddenSessions : 0, conns.ok ? conns.hiddenSessions : 0);
  return c.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    limitedVisibility: hidden > 0,
    visibilityNote:
      hidden > 0
        ? `The database account this server uses may not look inside ${hidden} other session(s). ` +
          "They are still counted as connections, and lock waits are read from a table everyone can see, " +
          "but a long-running transaction in one of those sessions cannot be detected, so that count may be low."
        : null,
    longTransactions: longTx,
    lockWaits: locks,
    connections: conns,
    databaseSize: size,
    tempFiles: temp,
  });
});

export default app;
