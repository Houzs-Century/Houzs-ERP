/* Symptom: a delivery shipped before its stock arrived was never back-charged when the goods were received
     (22 live delivery lines on production, Sep-Nov 2026), and drop-ship receipts never costed their DOs.
   Cause: PostgREST matches an RPC by argument NAMES. 0307 renamed the columns but kept the functions'
     parameter p_product_code; the app sent p_item_code from 18 Aug 2026, every call answered "function not
     found", and the caller read that as "migration not applied yet" and stayed silent.
   Fix: send the names the newest migration declares. This test reads them out of that migration. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reconcileUncostedOuts } from '../src/scm/lib/oversell-retrocost';
import { reconcileDropshipBatches } from '../src/scm/lib/inventory-movements';

const dir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/** Parameter names of the newest CREATE OR REPLACE of scm.<fn> across the migrations, in file order. */
function sqlArgNames(fn: string): string[] {
  let last: string | null = null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const re = new RegExp(`CREATE OR REPLACE FUNCTION scm\\.${fn}\\(([^)]*)\\)`, 'gi');
    for (const m of text.matchAll(re)) last = m[1]!;
  }
  if (last === null) throw new Error(`${fn} not found`);
  const names = last.split(',').map((a) => a.trim().split(/\s+/)[0]!.toLowerCase());
  if (!names.every((n) => n.startsWith('p_'))) throw new Error(`${fn}: newest definition has unnamed parameters: ${last}`);
  return names.sort();
}

function rpcRecorder() {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const sb = {
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: 0, error: null }; },
  };
  return { sb, calls };
}

describe('the retro-cost RPCs send the parameter names the SQL functions declare', () => {
  it('fn_reconcile_uncosted_out', async () => {
    const { sb, calls } = rpcRecorder();
    await reconcileUncostedOuts(sb, [{ warehouse_id: 'w', item_code: 'A', variant_key: '' }], new Date().toISOString(), null);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.args).sort()).toEqual(sqlArgNames('fn_reconcile_uncosted_out'));
  });

  it('fn_reconcile_dropship_batch', async () => {
    const { sb, calls } = rpcRecorder();
    await reconcileDropshipBatches(sb, [{ warehouse_id: 'w', item_code: 'A', variant_key: '', batch_no: 'B1' }], null);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.args).sort()).toEqual(sqlArgNames('fn_reconcile_dropship_batch'));
  });
});
