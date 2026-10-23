// ---------------------------------------------------------------------------
// D1-compatibility shim over postgres.js.
//
// The backend has ~685 call sites using the D1 surface:
//     env.DB.prepare(sql).bind(...args).all() / .first() / .run()
// Rewriting all of them to postgres.js tagged templates in one pass is high
// risk. This shim exposes the same surface backed by Postgres, so the call
// sites keep their shape. It removes the mechanical churn (the `?` -> `$n`
// placeholder rewrite and the D1 result-shape) for ALL 685, leaving only the
// genuine dialect edits that must be done per query by hand:
//
//   * datetime('now')        -> now()                (86 lines)
//   * INSERT OR REPLACE      -> INSERT ... ON CONFLICT DO UPDATE   (8)
//   * .run() + last_row_id   -> rewrite to `RETURNING id` + .first()  (37)
//
// The shim CANNOT infer those — Postgres has no implicit rowid, and
// ON CONFLICT needs the conflict target. Convert those sites explicitly.
//
// Wiring (Phase 3): build `env.DB` from a per-request Postgres client so the
// existing `env.DB.prepare(...)` keeps working:
//     import { getSql } from "./pg";
//     import { d1Compat } from "./d1-compat";
//     const DB = d1Compat(getSql(resolveDatabaseUrl(env)));
//
// Keep this until routes are migrated. New code should prefer Drizzle
// (getDb) or postgres.js (getSql) directly — do not add new callers here.
// ---------------------------------------------------------------------------
import type { Sql } from "postgres";
import { recordStep } from "../lib/step-timing";

/**
 * Rewrite SQLite positional placeholders to Postgres `$n`.
 *
 * Two SQLite placeholder forms are supported, matching how the call sites
 * bind their argument array:
 *   * BARE  `?`   — anonymous; the Nth `?` binds the Nth array element. These
 *     map to a running `$1,$2,...` counter (D1 parity).
 *   * NUMBERED `?N` — explicit 1-based index into the SAME array; a repeated
 *     `?2` reuses the same value. SQLite numbered params map DIRECTLY to
 *     Postgres `$N` (both are 1-based positional), so `?2` -> `$2` and a reused
 *     `?2` correctly resolves to the same `$2`. The previous version replaced
 *     EVERY `?` with the bare counter, so `?1 ... ?1 ... ?1` wrongly became
 *     `$1 ... $2 ... $3` and 500'd (global search, uniqueProjectCode, etc).
 *
 * No query in the codebase mixes the two forms, so the bare counter and the
 * numbered indices never collide. Quote-aware: `?` inside single-quoted string
 * literals or double-quoted identifiers is left alone. Postgres `$n` are 1-based.
 */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "?" && !inSingle && !inDouble) {
      // `?N` (one or more digits) -> `$N` verbatim, preserving reuse.
      let j = i + 1;
      while (j < sql.length && sql[j] >= "0" && sql[j] <= "9") j++;
      if (j > i + 1) {
        out += "$" + sql.slice(i + 1, j);
        i = j - 1;
      } else {
        // bare `?` -> running counter (D1 parity)
        out += "$" + ++n;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

// ---- SQLite -> Postgres dialect rewriting for raw query TEXT --------------
// Applies to every string flowing through env.DB.prepare(). Quote-aware: never
// touches data inside string literals. Drizzle sql`` fragments bypass this and
// are fixed at the source.
//
//   datetime('now'[, mod...])  -> to_char(UTC now() ±interval, 'YYYY-MM-DD HH24:MI:SS')
//   date('now'[, mod...])      -> to_char(UTC now() ±interval, 'YYYY-MM-DD')
//   julianday(x)               -> (extract(epoch from (x)::timestamptz)/86400.0)
//   strftime(fmt, x)           -> to_char((x)::timestamptz, 'fmt')
//   instr(a, b)                -> strpos(a, b)   (same arg order)
//   char(n)                    -> chr(n)
//
// julianday is only ever used in DIFFERENCES here (julianday(a)-julianday(b)),
// so the constant Julian-day epoch offset cancels and the result is exact.
// Single-arg date(x)/single-arg casts are left alone — Postgres accepts
// date(expr) as a cast. NOT handled (fixed per query): INSERT OR REPLACE.

// UTC "now" wall-clock, matching SQLite's datetime('now'); intervals append to it.
const UTC_NOW = "timezone('UTC', now())";

// Balanced (...) group starting at index `open` (sql[open] must be '('). Returns
// the inner text and the index of the matching ')'. Quote-aware.
function matchParen(
  sql: string,
  open: number,
): { inner: string; end: number } | null {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inStr && sql[i + 1] === "'") {
        i++;
        continue;
      }
      inStr = !inStr;
    } else if (!inStr) {
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return { inner: sql.slice(open + 1, i), end: i };
      }
    }
  }
  return null;
}

// Split an arg list on top-level commas (ignores commas in nested parens/strings).
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      if (inStr && s[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      cur += c;
      continue;
    }
    if (!inStr) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

// SQLite date/time modifiers after the leading 'now' -> Postgres interval tail,
// e.g. ['-30 days'] -> " - interval '30 days'".
function modifiersToInterval(args: string[]): string {
  let tail = "";
  for (const raw of args) {
    const mod = raw.trim().replace(/^'/, "").replace(/'$/, "").trim();
    const m = mod.match(
      /^([+-])\s*(\d+)\s+(days?|hours?|months?|years?|minutes?|seconds?|weeks?)$/i,
    );
    if (m) {
      tail += ` ${m[1] === "-" ? "-" : "+"} interval '${m[2]} ${m[3].toLowerCase()}'`;
    }
  }
  return tail;
}

// SQLite strftime format -> Postgres to_char template. Unmapped letters become
// quoted literals so to_char treats them verbatim rather than as field codes.
function strftimeToPg(fmt: string): string {
  const map: Record<string, string> = {
    Y: "YYYY",
    m: "MM",
    d: "DD",
    H: "HH24",
    M: "MI",
    S: "SS",
    W: "IW",
    j: "DDD",
  };
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      out += map[fmt[i + 1]] ?? fmt[i + 1];
      i++;
    } else {
      out += /[A-Za-z]/.test(fmt[i]) ? `"${fmt[i]}"` : fmt[i];
    }
  }
  return out;
}

// Queries slower than this are logged to wrangler tail with their SQL.
const SLOW_QUERY_MS = 100;

// Cap the FIRST query attempt at ~12s so a hung Hyperdrive connection (one
// where the socket never errors, the postgres.js promise just never settles —
// the failure mode behind the recurring "Failed to fetch / server took too long
// to respond" reports) gets retried on a fresh client instead of riding the
// Workers runtime's ~30s hang-detector to a kill. The marker message is matched
// by isDeadConnError so the existing retry path catches it. The retry attempt
// is intentionally NOT timed — a genuinely slow-but-healthy query still
// completes; Workers' own cap is the backstop.
const FIRST_ATTEMPT_TIMEOUT_MS = 12_000;
const FIRST_ATTEMPT_TIMEOUT_MARKER =
  "d1-compat first attempt timed out — connection appears hung";

// Hyperdrive pools connections to the Supabase pooler origin-side. After a
// deploy (fresh pool) or a quiet period (pooler reaps idle conns) the first
// query can hit a dead/cold connection and fail with one of these. We retry
// ONCE on a FRESH client (a new postgres.js instance with its own slot — never
// the stuck one, which is what caused the old "waiting for an open slot" hang).
// A connection error means the query never reached the server, so re-running is
// safe (no double-write). Real query errors (constraints, syntax) don't match
// and propagate unchanged.
//
// "Cannot perform I/O on behalf of a different request" is also retried here as
// belt-and-suspenders: the root cause (a DB client shared across request
// contexts) is fixed in middleware/db.ts, but if any residual cross-context use
// slips through, the retry runs makeSql() to open a FRESH socket in the CURRENT
// request's context — which resolves it instead of surfacing a generic 500.
//
// SINGLE SOURCE OF TRUTH for "transient connection failure" — exported so
// index.ts humanizeError() classifies the SAME strings as a retryable 503
// (not a generic 500). The retry layer and the user-facing classifier must
// never drift apart. Every string here is a PRE-execution connection failure
// (the query never reached the server), so re-running is safe — no double-write.
// NEVER add a real SQL/logic error (constraint/syntax/column does not exist) —
// those must stay non-retryable so genuine bugs surface immediately.
export const TRANSIENT_CONN_RE =
  /CONNECTION_CLOSED|Network connection lost|ECONNRESET|ECONNREFUSED|connection closed|terminating connection|server closed the connection|EPIPE|Timed out .*pool|d1-compat first attempt timed out|Cannot perform I\/O on behalf of a different request|too many clients already|remaining connection slots are reserved|Connection terminated|ETIMEDOUT|fetch failed|socket hang up|MaxClientsInSessionMode/i;

function isDeadConnError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e ?? "");
  return TRANSIENT_CONN_RE.test(m);
}

export function rewriteDialect(sql: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inStr && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      out += c;
      continue;
    }
    if (inStr) {
      out += c;
      continue;
    }

    const rest = sql.slice(i);
    // Only start a keyword match on an identifier boundary, so longer names
    // (varchar(, mydate(, ...) are never mistaken for char(/date(.
    const atBoundary = i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]);

    if (atBoundary) {
      // date('now' ...) / datetime('now' ...) — only the 'now' form; a plain
      // date(col) cast is valid Postgres and left untouched.
      let m = rest.match(/^(datetime|date)\s*\(\s*'now'/i);
      if (m) {
        const open = i + m[0].indexOf("(");
        const grp = matchParen(sql, open);
        if (grp) {
          const args = splitArgs(grp.inner);
          const expr = UTC_NOW + modifiersToInterval(args.slice(1));
          const fmt =
            m[1].toLowerCase() === "date"
              ? "YYYY-MM-DD"
              : "YYYY-MM-DD HH24:MI:SS";
          out += `to_char(${expr}, '${fmt}')`;
          i = grp.end;
          continue;
        }
      }

      // julianday(x) -> fractional epoch-days (offset cancels in differences).
      m = rest.match(/^julianday\s*\(/i);
      if (m) {
        const open = i + m[0].length - 1;
        const grp = matchParen(sql, open);
        if (grp) {
          out += `(extract(epoch from (${rewriteDialect(grp.inner)})::timestamptz)/86400.0)`;
          i = grp.end;
          continue;
        }
      }

      // strftime(fmt, x) -> to_char((x)::timestamptz, 'fmt')
      m = rest.match(/^strftime\s*\(/i);
      if (m) {
        const open = i + m[0].length - 1;
        const grp = matchParen(sql, open);
        if (grp) {
          const args = splitArgs(grp.inner);
          const fmt = strftimeToPg(args[0].trim().replace(/^'/, "").replace(/'$/, ""));
          out += `to_char((${rewriteDialect(args.slice(1).join(","))})::timestamptz, '${fmt}')`;
          i = grp.end;
          continue;
        }
      }

      // LIKE -> ILIKE: SQLite LIKE is case-insensitive for ASCII; Postgres
      // LIKE is case-sensitive, which silently broke search after the
      // cutover. ILIKE restores the behaviour the call sites were written
      // against. "NOT LIKE" passes through as "NOT ILIKE"; ILIKE itself
      // can't re-match (the boundary check fails after the leading I).
      m = rest.match(/^like\b/i);
      if (m) {
        out += "ILIKE";
        i += m[0].length - 1;
        continue;
      }

      // instr(a, b) -> strpos(a, b) — identical argument order.
      m = rest.match(/^instr\s*\(/i);
      if (m) {
        out += "strpos(";
        i += m[0].length - 1;
        continue;
      }

      // group_concat(x[, sep]) -> string_agg((x)::text, sep). SQLite defaults
      // the separator to ','; Postgres string_agg REQUIRES it, so the 1-arg
      // form gets an explicit ','.
      m = rest.match(/^group_concat\s*\(/i);
      if (m) {
        const open = i + m[0].length - 1;
        const grp = matchParen(sql, open);
        if (grp) {
          const args = splitArgs(grp.inner);
          const sep = args.length > 1 ? rewriteDialect(args.slice(1).join(",")) : "','";
          out += `string_agg((${rewriteDialect(args[0])})::text, ${sep})`;
          i = grp.end;
          continue;
        }
      }

      // char(n) -> chr(n)
      if (rest.slice(0, 5).toLowerCase() === "char(") {
        out += "chr(";
        i += 4;
        continue;
      }
    }
    out += c;
  }
  return out;
}

// D1 row shapes the call sites expect back.
type D1Meta = {
  changes: number;
  last_row_id: number | null;
  rows_read?: number;
  rows_written?: number;
};
type D1Result<T> = { results: T[]; success: true; meta: D1Meta };

/** One prepared (sql + bound args) statement, executed lazily. */
class PreparedStatement {
  private args: unknown[] = [];
  constructor(
    private readonly sql: Sql,
    private readonly makeSql: () => Sql,
    private readonly query: string,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  // Run the (placeholder- and dialect-rewritten) statement. Returns the raw
  // postgres.js RowList — an array of rows that also carries `.count` (rows
  // affected for writes, rows returned for reads) and `.command`.
  private async exec<T = Record<string, unknown>>(
    textOverride?: string,
  ): Promise<T[]> {
    // postgres.js `unsafe` runs a dynamic string with positional params.
    // prepare:false is already set on the client (transaction pooler).
    const text = textOverride ?? toPgPlaceholders(rewriteDialect(this.query));
    const t0 = Date.now();
    let res: T[] & { count?: number };
    try {
      // First attempt: capped at FIRST_ATTEMPT_TIMEOUT_MS so a hung connection
      // (postgres.js promise never settles) fails fast and falls into the retry
      // path below instead of dragging the request to a Workers hang-kill.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(FIRST_ATTEMPT_TIMEOUT_MARKER)),
          FIRST_ATTEMPT_TIMEOUT_MS,
        );
      });
      try {
        res = (await Promise.race([
          this.sql.unsafe(text, this.args as never[]),
          timedOut,
        ])) as unknown as T[] & { count?: number };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (e) {
      if (!isDeadConnError(e)) throw e;
      // Cold/dead/hung Hyperdrive connection — retry on a FRESH client (its own
      // slot opens a new origin connection, so cold-pool windows self-heal). Up
      // to 3 tries with a short backoff: a login (or any query) right after an
      // idle period was the visible 503 — the first request warms the pool, so
      // absorbing the warm-up server-side means the user never sees the 503.
      // Each attempt is untimed (a slow-but-healthy query still fits Workers' cap).
      const RETRIES = 3;
      let ok: (T[] & { count?: number }) | undefined;
      let lastErr: unknown = e;
      for (let i = 0; i < RETRIES && ok === undefined; i++) {
        console.warn(`[db-retry ${i + 1}/${RETRIES}] ${String((lastErr as Error)?.message ?? lastErr).slice(0, 70)}`);
        try {
          ok = (await this.makeSql().unsafe(text, this.args as never[])) as unknown as T[] & { count?: number };
        } catch (e2) {
          lastErr = e2;
          if (!isDeadConnError(e2)) throw e2; // a REAL error on retry → surface it
          if (i < RETRIES - 1) await new Promise((r) => setTimeout(r, 250 + i * 400));
        }
      }
      if (ok === undefined) throw lastErr;
      res = ok;
    }
    // Every query in the app funnels through here — a single threshold log
    // turns `wrangler tail` into a slow-query dashboard (Hookka pattern).
    const ms = Date.now() - t0;
    // Per request: how many SQL round trips and their summed time (Server-Timing s-db-sql).
    recordStep("db-sql", ms);
    if (ms > SLOW_QUERY_MS) {
      console.warn(
        `[slow-query] ${ms}ms rows=${res.count ?? res.length} :: ${text.replace(/\s+/g, " ").slice(0, 180)}`,
      );
    }
    return res;
  }

  /** Execute on the transaction connection supplied by batch(). No retry is
   * allowed here: retrying on a fresh connection would escape the transaction
   * and recreate the partial-commit bug batch() is meant to prevent. */
  async execInTransaction<T = Record<string, unknown>>(tx: Sql): Promise<T[]> {
    const text = toPgPlaceholders(rewriteDialect(this.query));
    return tx.unsafe(text, this.args as never[]) as unknown as Promise<T[]>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = (await this.exec<T>()) as T[] & { count?: number };
    return {
      results: res as T[],
      success: true,
      meta: {
        changes: res.count ?? res.length,
        last_row_id: null,
        rows_read: res.length,
      },
    };
  }

  async first<T = Record<string, unknown>>(
    column?: string,
  ): Promise<T | null> {
    const rows = await this.exec<Record<string, unknown>>();
    const row = rows[0] ?? null;
    if (row == null) return null;
    return (column ? (row[column] as T) : (row as T));
  }

  // D1 parity for writes. Two fixes over the naive version:
  //   * changes  — postgres.js returns an EMPTY array for a non-RETURNING
  //     UPDATE/DELETE, so the old `rows.length` was always 0 and broke every
  //     `if (!meta.changes)` guard. The real affected-row count is `.count`.
  //   * last_row_id — synthesised by appending `RETURNING *` to INSERTs. This
  //     is safe for any table (returns the inserted row); `.id` is present on
  //     every identity-PK table the loader created and harmlessly undefined
  //     otherwise. Removes the ~37 manual `RETURNING id` rewrites.
  async run(): Promise<{ success: true; meta: D1Meta }> {
    let text = toPgPlaceholders(rewriteDialect(this.query));
    const isInsert = /^\s*insert\s/i.test(text);
    if (isInsert && !/\breturning\b/i.test(text)) {
      text = text.replace(/[\s;]*$/, "") + " RETURNING *";
    }
    const res = (await this.exec(text)) as Array<Record<string, unknown>> & {
      count?: number;
    };
    const changes = res.count ?? res.length;
    return {
      success: true,
      meta: {
        changes,
        last_row_id: isInsert ? ((res[0]?.id as number) ?? null) : null,
        rows_written: changes,
      },
    };
  }
}

export interface D1Like {
  prepare(query: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}

/** Wrap a postgres.js client in the D1 surface the routes already use.
 *  Takes a FACTORY (not a client) so exec() can retry a dead connection on a
 *  fresh client (cold-pool self-heal). postgres.js Sql is itself callable, so a
 *  factory is the only unambiguous shape. Callers with a fixed client pass
 *  `() => sql`. */
export function d1Compat(makeSql: () => Sql): D1Like {
  const sql = makeSql();
  return {
    prepare: (query: string) => new PreparedStatement(sql, makeSql, query),
    batch: (statements: PreparedStatement[]) =>
      sql.begin((tx) =>
        Promise.all(
          statements.map((statement) => statement.execInTransaction(tx as unknown as Sql)),
        ),
      ) as unknown as Promise<unknown[]>,
  };
}
