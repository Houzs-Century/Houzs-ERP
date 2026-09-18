import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
// @ts-expect-error — plain .mjs helper, no types; this is the SAME splitter
// pg-migrate.mjs uses, so the replay below is the real one and not a lookalike.
import { splitSqlStatements } from '../../scripts/lib/split-sql.mjs';

/* A PostgREST-SHAPED FACADE over a real connection — not a mock of the database.
 *
 * The production client is @supabase/supabase-js talking HTTP to PostgREST;
 * there is no way to run that here. What this replaces is the TRANSPORT, and
 * only the calls scm/lib/doc-no.ts makes: `.from().select().like().order()
 * .range()`, `.from().insert()`, and `.rpc()`. Every row, every lock and every
 * counter increment underneath is real PostgreSQL. The repo's own
 * pgTransactionSupabase would have been preferable and cannot be used: it has
 * no `.like()`, which is the whole floor read.
 *
 * SHARED, not copied. It started inside docNoCounter.pg.test.ts; the moment a
 * second doc-number suite needed it, a copy would have been two facades free to
 * drift — and a facade that drifts stops being evidence about the same code
 * path. Same reason lib/rpc-missing.ts is one function and not one per caller.
 */

export type PostgrestOverOptions = {
  /**
   * `false` makes `.rpc()` answer PGRST202 — the world BEFORE migration 0316,
   * where mintMonthlyDocNo degrades to max(suffix)+1 over the surviving rows.
   * That degradation is a REAL production state (between a merge and
   * pg-migrate), and it is what the concurrency suite races to show what the
   * counter is actually buying.
   */
  counter?: boolean;
};

const IDENT = /^[a-z_][a-z0-9_]*$/i;
const qi = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`postgrestOver: unsafe identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/** PostgREST's shape: an error is DATA on the result, never a throw. */
const asPostgrestError = (e: unknown): { code?: string; message: string } => {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined;
  return { code, message: e instanceof Error ? e.message : String(e) };
};

export function postgrestOver(sql: Sql, opts: PostgrestOverOptions = {}) {
  const counterOn = opts.counter !== false;
  return {
    from(table: string) {
      const q = {
        _cols: '*',
        _like: null as null | [string, string],
        _order: null as null | [string, boolean],
        _from: 0,
        _to: 999,
        _limit: null as null | number,
        select(cols: string) { q._cols = cols; return q; },
        like(col: string, pattern: string) { q._like = [col, pattern]; return q; },
        order(col: string, options?: { ascending?: boolean }) { q._order = [col, options?.ascending !== false]; return q; },
        limit(n: number) { q._limit = n; return q; },
        range(from: number, to: number) { q._from = from; q._to = to; return q; },
        /** The write half — `.from(t).insert(row)` is how every minter lands its
            header. Returns the result directly rather than a chainable builder:
            insertWithDocNoRetry awaits it and reads `.error`, and nothing in the
            doc-number path chains `.select()` off an insert. */
        async insert(row: Record<string, unknown>): Promise<{ data: unknown[] | null; error: { code?: string; message: string } | null }> {
          const cols = Object.keys(row);
          try {
            const rows = await sql.unsafe(
              `INSERT INTO scm.${qi(table)} (${cols.map(qi).join(', ')})`
              + ` VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
              cols.map((k) => row[k]) as never[],
            );
            return { data: [...(rows as unknown[])], error: null };
          } catch (e) {
            return { data: null, error: asPostgrestError(e) };
          }
        },
        async then(
          resolve: (v: { data: unknown[] | null; error: { code?: string; message: string } | null }) => void,
        ) {
          const [likeCol, likePattern] = q._like ?? ['', '%'];
          const take = q._limit ?? (q._to - q._from + 1);
          try {
            const rows = await sql.unsafe(
              `SELECT ${q._cols} FROM scm.${qi(table)}`
              + (q._like ? ` WHERE ${qi(likeCol)} LIKE $1` : '')
              + (q._order ? ` ORDER BY ${qi(q._order[0])}${q._order[1] ? '' : ' DESC'}` : '')
              + ` LIMIT ${take} OFFSET ${q._limit ? 0 : q._from}`,
              (q._like ? [likePattern] : []) as never[],
            );
            resolve({ data: [...(rows as unknown[])], error: null });
          } catch (e) {
            resolve({ data: null, error: asPostgrestError(e) });
          }
        },
      };
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'next_doc_no_n' || !counterOn) {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${name}` } };
      }
      try {
        const rows = await sql.unsafe<Array<{ n: number }>>(
          'SELECT scm.next_doc_no_n($1::text, $2::int) AS n',
          [args.p_series, args.p_floor] as never[],
        );
        return { data: rows[0]?.n ?? null, error: null };
      } catch (e) {
        return { data: null, error: asPostgrestError(e) };
      }
    },
  };
}

export type PostgrestOver = ReturnType<typeof postgrestOver>;

/* ─────────────── Replaying migration 0316 exactly as the deploy does ────────
   Shared for the same reason the facade is: two suites replaying the counter
   migration through two different loaders can disagree about what "the
   migration" is, and then neither is evidence. */

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations-pg/', import.meta.url));

/** By SUFFIX, never by number — parallel PRs renumber migrations routinely, and
    a number-pinned read would silently resolve to nothing and pass vacuously. */
async function docNoCounterMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_doc_number_counters.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_doc_number_counters.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

/** Replay exactly as pg-migrate.mjs does: split, then one transaction.
    Returns the statement count so a caller can assert the replay was real. */
export async function applyDocNoCounterMigration(sql: Sql): Promise<number> {
  const stmts = splitSqlStatements(await docNoCounterMigrationSql()) as string[];
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
  return stmts.length;
}

/** Refuse to point a destructive fixture at anything but the disposable local
    database. Copied from the suites that already do this, so a new suite cannot
    forget it. */
export function assertDisposableTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
}
