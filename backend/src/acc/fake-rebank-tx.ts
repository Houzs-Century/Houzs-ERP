// Test double for acc/rebank-transaction's RebankTx over a fake-postgrest client:
// the work runs on the same in-memory tables, and a throw puts every table back
// as it was before the work began — the rollback a real transaction gives.
import type { RebankTx } from './rebank-transaction';

type Tables = Record<string, Array<Record<string, unknown>>>;

export function fakeRebankTx<S extends { tables: Tables }>(
  sb: S,
  /* Wraps the client the work sees: a test injects a failure or a concurrent write here. */
  wrap: ((db: S) => S) | null,
): RebankTx & { rollbacks: number } {
  const run = async <T>(work: (tx: S) => Promise<T>): Promise<T> => {
    const before = JSON.parse(JSON.stringify(sb.tables)) as Tables;
    try {
      return await work(wrap ? wrap(sb) : sb);
    } catch (e) {
      for (const k of Object.keys(sb.tables)) delete sb.tables[k];
      Object.assign(sb.tables, before);
      run.rollbacks += 1;
      throw e;
    }
  };
  run.rollbacks = 0;
  return run as unknown as RebankTx & { rollbacks: number };
}
