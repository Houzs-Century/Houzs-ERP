// ----------------------------------------------------------------------------
// acc/rebank-transaction — one receipt's bank move in ONE database transaction.
//
// Moving a receipt is two journal writes: the contra of the old entry, then the
// payment booked again on the new bank. Through PostgREST each write commits on
// its own, so a second write that failed left the money in no bank. This runs
// both over one postgres.js transaction (the runScmPgCommand pattern,
// scm/lib/pg-supabase-transaction.ts): the work commits when it resolves and
// rolls back, contra and all, when it throws.
//
// THE SWITCH — RECEIPT_REBANK_MODE (wrangler.toml [vars]):
//   "atomic" (the default; absent or any other value means this too)
//   "two-step" = the old path: reverse, then post, each committed on its own.
//                Kept for one release so the move can be rolled back without a
//                code change; remove it once the atomic path has run clean.
// ----------------------------------------------------------------------------

import type { Sql } from 'postgres';
import { getSql, resolveDatabaseUrl } from '../db/pg';
import { pgTransactionSupabase, settleScmStatements } from '../scm/lib/pg-supabase-transaction';
import { DOC_NO_COUNTER_RPC } from '../scm/lib/doc-no';
import type { postSoPayment } from './payments';

/** The client the journal engine and the payment posters take. */
type Db = Parameters<typeof postSoPayment>[0];

/** Runs `work` in one transaction: commits when it resolves, rolls back when it throws. */
export type RebankTx = <T>(work: (tx: Db) => Promise<T>) => Promise<T>;

export type RebankMode = 'atomic' | 'two-step';

export function rebankMode(env: unknown): RebankMode {
  const raw = env && typeof env === 'object' ? (env as { RECEIPT_REBANK_MODE?: unknown }).RECEIPT_REBANK_MODE : undefined;
  return String(raw ?? '').trim().toLowerCase() === 'two-step' ? 'two-step' : 'atomic';
}

/**
 * The PostgREST-shaped client the journal engine writes through, bound to one
 * transaction. Over the shared command client it adds the JE number counter
 * (scm.next_doc_no_n): the shared client refuses that RPC, and nextJeNo would
 * then mint from the live max, which two concurrent posts can both read. Here
 * the counter row is claimed inside the transaction, so a rollback returns it.
 */
export function rebankTxClient(tx: Sql) {
  const base = pgTransactionSupabase(tx);
  return {
    ...base,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      if (name !== DOC_NO_COUNTER_RPC) return base.rpc(name, args);
      await settleScmStatements(tx);
      const rows = await tx.unsafe<Array<{ n: number }>>(
        'SELECT scm.next_doc_no_n($1::text, $2::integer) AS n',
        [args.p_series, args.p_floor] as never[],
      );
      return { data: rows.at(0)?.n ?? null, error: null };
    },
  };
}

/** The runner over one postgres.js client: each call is its own transaction. */
export function rebankTxOver(sql: Sql): RebankTx {
  return async <T>(work: (tx: Db) => Promise<T>): Promise<T> => sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const out = await work(rebankTxClient(t));
    /* The last statement's RELEASE must be answered before COMMIT. */
    await settleScmStatements(t);
    return out;
  }) as Promise<T>;
}

/**
 * The transaction runner for this request, or null for the old two-step path.
 * No database URL = every move refuses with nothing written: the atomic path
 * never falls back to committing the two writes separately.
 */
export function rebankTxFor(env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string; RECEIPT_REBANK_MODE?: string }): RebankTx | null {
  if (rebankMode(env) === 'two-step') return null;
  let over: RebankTx | null = null;
  return async <T>(work: (tx: Db) => Promise<T>): Promise<T> => {
    const url = resolveDatabaseUrl(env);
    if (!url) throw new Error('the PostgreSQL transaction service is not configured');
    /* One client for the whole call: db/pg.ts builds one socket per request. */
    over ??= rebankTxOver(getSql(url));
    return over(work);
  };
}
