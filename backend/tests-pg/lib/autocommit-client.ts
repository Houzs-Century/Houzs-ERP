import type { Sql } from 'postgres';
import { pgTransactionSupabase, settleScmStatements } from '../../src/scm/lib/pg-supabase-transaction';

/* A PostgREST-SHAPED client over a real connection where EVERY STATEMENT IS ITS
 * OWN TRANSACTION, and a refused statement comes back as `{ error }` data, never
 * a throw: the production client's commit model (@supabase/supabase-js over
 * PostgREST), which is what the old "two-step" paths wrote through.
 *
 * It records the builder chain and replays it, at the terminal call, on the
 * repo's own pgTransactionSupabase inside a one-statement sql.begin. So the SQL
 * is the same SQL the atomic path sends; only the commit boundary differs. The
 * suites use it for the two-step rollback switch and for the after-commit
 * clean-up an atomic create runs when its transaction rolled back. */

type Call = [string, unknown[]];
type Terminal = 'then' | 'maybeSingle' | 'single';
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

export function autocommitClient(sql: Sql) {
  const run = (table: string, calls: Call[], terminal: Terminal): Promise<Result> =>
    sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- replaying a recorded builder chain
      let q: any = pgTransactionSupabase(t).from(table);
      for (const [method, args] of calls) q = q[method](...args);
      const out = (terminal === 'then' ? await q : await q[terminal]()) as Result;
      await settleScmStatements(t);
      return out;
    }).then(
      (r) => r as unknown as Result,
      (e: { message?: string; code?: string }) => ({ data: null, error: { message: e.message ?? String(e), code: e.code }, count: null }),
    );
  return {
    from(table: string): unknown {
      const calls: Call[] = [];
      const rec: unknown = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'then') {
            return (ok: (v: Result) => unknown, bad?: (e: unknown) => unknown) => run(table, calls, 'then').then(ok, bad);
          }
          if (prop === 'maybeSingle' || prop === 'single') return () => run(table, calls, prop);
          return (...args: unknown[]) => { calls.push([String(prop), args]); return rec; };
        },
      });
      return rec;
    },
  };
}
