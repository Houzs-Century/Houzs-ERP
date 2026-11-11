// ----------------------------------------------------------------------------
// scm/lib/stock-post-tx — a stock write's core in ONE database transaction.
//
// Posting a GRN (status -> POSTED, stock IN, PO received recount, landed-cost
// allocation) and shipping a DO (status -> LOADED, stock OUT) used to be a row of
// separate PostgREST calls, each committed on its own. A failure part-way left a
// POSTED GRN with no stock (HC-GRN-2609-118) or a shipped DO with no OUT
// (HC-DO-2610-319). This runs the core over one postgres.js transaction, the
// runScmPgCommand pattern (pgTransactionSupabase over sql.begin): it commits when
// the work answers ok and rolls everything back when the work answers !ok or a
// statement throws. The FIFO trigger fires on the movement insert, so it runs in
// the same transaction.
//
// THE SWITCHES (wrangler.toml [vars]): GRN_POST_MODE, DO_SHIP_MODE,
// DELIVERY_RETURN_MODE (lib/delivery-return-stock.ts), PURCHASE_RETURN_MODE
// (lib/purchase-return-stock.ts)
//   "atomic"   the default; absent or any other value means this too
//   "two-step" the old path, each write committed on its own. Kept for one
//              release as the rollback switch; remove once atomic has run clean.
// ----------------------------------------------------------------------------

import type { Sql } from 'postgres';
import { getSql, resolveDatabaseUrl } from '../../db/pg';
import { pgTransactionSupabase, settleScmStatements } from './pg-supabase-transaction';

export type StockPostSwitch = 'GRN_POST_MODE' | 'DO_SHIP_MODE' | 'DELIVERY_RETURN_MODE' | 'PURCHASE_RETURN_MODE';
export type StockPostMode = 'atomic' | 'two-step';

/** The client the core writes through: PostgREST-shaped, bound to the transaction. */
export type StockTxClient = ReturnType<typeof pgTransactionSupabase>;

/** Why an atomic post wrote nothing. Every one of these left the database as it was. */
export const STOCK_TX_UNAVAILABLE = 'stock_tx_unavailable';
export const STOCK_TX_ROLLED_BACK = 'stock_tx_rolled_back';

export type StockTxFailure = { ok: false; reason: string; status: number; rolledBack: true; detail?: string };

/**
 * Runs `work` in one transaction. `{ ok: true }` commits; `{ ok: false }` rolls
 * back and is handed back as it was; a throw rolls back and answers a failure.
 */
export type StockTx = <R extends { ok: boolean }>(
  work: (tx: StockTxClient) => Promise<R>,
) => Promise<R | StockTxFailure>;

type EnvLike = {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  GRN_POST_MODE?: string;
  DO_SHIP_MODE?: string;
  DELIVERY_RETURN_MODE?: string;
  PURCHASE_RETURN_MODE?: string;
} | null | undefined;

export function stockPostMode(env: EnvLike, key: StockPostSwitch): StockPostMode {
  return String(env?.[key] ?? '').trim().toLowerCase() === 'two-step' ? 'two-step' : 'atomic';
}

class Rollback<R> {
  constructor(readonly outcome: R) {}
}

/** The runner over one postgres.js client: each call is its own transaction. */
export function stockTxOver(sql: Sql): StockTx {
  return async <R extends { ok: boolean }>(work: (tx: StockTxClient) => Promise<R>): Promise<R | StockTxFailure> => {
    try {
      return await sql.begin(async (tx) => {
        const t = tx as unknown as Sql;
        const out = await work(pgTransactionSupabase(t));
        /* The last statement's RELEASE must be answered before COMMIT: a COMMIT
           on an aborted transaction rolls back and still reports success. */
        await settleScmStatements(t);
        if (!out.ok) throw new Rollback(out);
        return out;
      }) as unknown as R;
    } catch (error) {
      if (error instanceof Rollback) return error.outcome as R;
      console.error('[stock-post-tx] rolled back:', error);
      return {
        ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, rolledBack: true,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * The transaction runner for this request, or null for the old two-step path.
 * No database URL = the post refuses with nothing written: the atomic path never
 * falls back to committing the writes one by one.
 */
export function stockTxFor(env: EnvLike, key: StockPostSwitch): StockTx | null {
  if (stockPostMode(env, key) === 'two-step') return null;
  let over: StockTx | null = null;
  return async <R extends { ok: boolean }>(work: (tx: StockTxClient) => Promise<R>): Promise<R | StockTxFailure> => {
    const url = env ? resolveDatabaseUrl(env) : '';
    if (!url) {
      return { ok: false, reason: STOCK_TX_UNAVAILABLE, status: 503, rolledBack: true, detail: 'the PostgreSQL transaction service is not configured' };
    }
    /* One client for the whole request: db/pg.ts builds one socket per request. */
    over ??= stockTxOver(getSql(url));
    return over(work);
  };
}

/** What the operator reads when an atomic post wrote nothing. */
export function stockTxFailureBody(what: 'posted' | 'shipped' | 'received' | 'returned' | 'cancelled', failure: { reason: string; detail?: string }) {
  return {
    error: failure.reason,
    message: `Nothing was ${what}: the change was rolled back as a whole. Please try again.`,
    ...(failure.detail ? { detail: failure.detail } : {}),
  };
}

export const isStockTxFailure = (r: { ok: boolean; reason?: string }): boolean =>
  !r.ok && (r.reason === STOCK_TX_ROLLED_BACK || r.reason === STOCK_TX_UNAVAILABLE);
