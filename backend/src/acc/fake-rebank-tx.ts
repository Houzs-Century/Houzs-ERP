import type { RebankTx } from './rebank-transaction';

type Tables = Record<string, Array<Record<string, unknown>>>;

export function fakeRebankTx<S extends { tables: Tables }>(
  sb: S,
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
