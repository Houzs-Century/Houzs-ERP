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
      let j = i + 1;
      while (j < sql.length && sql[j] >= "0" && sql[j] <= "9") j++;
      if (j > i + 1) {
        out += "$" + sql.slice(i + 1, j);
        i = j - 1;
      } else {
        out += "$" + ++n;
      }
    } else {
      out += ch;
    }
  }
  return out;
}


const UTC_NOW = "timezone('UTC', now())";

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

const SLOW_QUERY_MS = 100;

const FIRST_ATTEMPT_TIMEOUT_MS = 12_000;
const FIRST_ATTEMPT_TIMEOUT_MARKER =
  "d1-compat first attempt timed out — connection appears hung";

export const TRANSIENT_CONN_RE =
  /CONNECTION_CLOSED|Network connection lost|ECONNRESET|ECONNREFUSED|connection closed|terminating connection|server closed the connection|EPIPE|Timed out .*pool|d1-compat first attempt timed out|Cannot perform I\/O on behalf of a different request|too many clients already|remaining connection slots are reserved|Connection terminated|ETIMEDOUT|fetch failed|socket hang up|MaxClientsInSessionMode|EMAXCONNSESSION|max clients reached/i;

const POOL_FULL_RE = /EMAXCONNSESSION|max clients reached|MaxClientsInSessionMode/i;

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
    const atBoundary = i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]);

    if (atBoundary) {
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

      m = rest.match(/^like\b/i);
      if (m) {
        out += "ILIKE";
        i += m[0].length - 1;
        continue;
      }

      m = rest.match(/^instr\s*\(/i);
      if (m) {
        out += "strpos(";
        i += m[0].length - 1;
        continue;
      }

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

type D1Meta = {
  changes: number;
  last_row_id: number | null;
  rows_read?: number;
  rows_written?: number;
};
type D1Result<T> = { results: T[]; success: true; meta: D1Meta };

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

  private async exec<T = Record<string, unknown>>(
    textOverride?: string,
  ): Promise<T[]> {
    const text = textOverride ?? toPgPlaceholders(rewriteDialect(this.query));
    const t0 = Date.now();
    let res: T[] & { count?: number };
    try {
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
      const RETRIES = 3;
      let ok: (T[] & { count?: number }) | undefined;
      let lastErr: unknown = e;
      for (let i = 0; i < RETRIES && ok === undefined; i++) {
        console.warn(`[db-retry ${i + 1}/${RETRIES}] ${String((lastErr as Error)?.message ?? lastErr).slice(0, 70)}`);
        if (i === 0 && POOL_FULL_RE.test(lastErr instanceof Error ? lastErr.message : String(lastErr))) {
          await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
        }
        try {
          ok = (await this.makeSql().unsafe(text, this.args as never[])) as unknown as T[] & { count?: number };
        } catch (e2) {
          lastErr = e2;
          if (!isDeadConnError(e2)) throw e2;
          if (i < RETRIES - 1) await new Promise((r) => setTimeout(r, 250 + i * 400));
        }
      }
      if (ok === undefined) throw lastErr;
      res = ok;
    }
    const ms = Date.now() - t0;
    recordStep("db-sql", ms);
    if (ms > SLOW_QUERY_MS) {
      console.warn(
        `[slow-query] ${ms}ms rows=${res.count ?? res.length} :: ${text.replace(/\s+/g, " ").slice(0, 180)}`,
      );
    }
    return res;
  }

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
