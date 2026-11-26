import type { SupabaseClient } from '@supabase/supabase-js';

export type SkuUsage = { where: string; doc: string | null };

/** Returned to callers when a usage probe could not be run. Callers refuse. */
export const USAGE_CHECK_FAILED = 'usage_check_failed';

/** "Used here", "provably unused", or "could not find out" — three states, never
 *  two. A caller cannot spend an unreadable probe as an absence. */
export type UsageVerdict =
  | { ok: true; usage: SkuUsage | null }
  | { ok: false; reason: string };

const CHECKS: Array<{ table: string; col: string; label: string; docCol: string | null }> = [
  { table: 'mfg_sales_order_items', col: 'item_code',    label: 'a sales order',    docCol: 'doc_no' },
  { table: 'purchase_order_items',  col: 'item_code',    label: 'a purchase order', docCol: null },
  { table: 'inventory_movements',   col: 'item_code', label: 'a stock movement', docCol: 'source_doc_no' },
];

/**
 * True only when a PostgREST error means the TABLE IS NOT THERE — a fresh
 * deployment that has not run every migration yet. Nothing can be recorded in a
 * table that does not exist, so this really is "no usage here". Every other
 * error (timeout, connection reset, RLS denial, column typo) means we did not
 * find out, and must not be read as an absence.
 *
 * PGRST205 = "Could not find the table ... in the schema cache".
 * 42P01     = Postgres undefined_table.
 */
export function isMissingTable(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'PGRST205' || err.code === '42P01') return true;
  return /could not find the table|relation .* does not exist/i.test(err.message ?? '');
}

/** First place a SKU code is referenced by a real document, or the reason we
 *  could not tell. `{ ok: true, usage: null }` means provably unused. */
export async function findSkuUsage(sb: SupabaseClient, code: string): Promise<UsageVerdict> {
  if (!code) return { ok: true, usage: null };
  for (const ch of CHECKS) {
    const sel = ch.docCol ?? ch.col;
    const { data, error } = await sb.from(ch.table).select(sel).eq(ch.col, code).limit(1);
    if (error) {
      if (isMissingTable(error)) continue;
      return { ok: false, reason: `${ch.table}: ${error.message}` };
    }
    if (data && data.length > 0) {
      const doc = ch.docCol ? ((data[0] as unknown as Record<string, unknown>)[ch.docCol] as string | null) : null;
      return { ok: true, usage: { where: ch.label, doc } };
    }
  }
  return { ok: true, usage: null };
}

/** First used SKU under a Model (with the place it's used), or the reason we
 *  could not tell. `{ ok: true, usage: null }` means the whole Model is provably
 *  unused and therefore safe to delete. */
export async function findModelUsage(
  sb: SupabaseClient,
  modelId: string,
): Promise<{ ok: true; usage: (SkuUsage & { code: string }) | null } | { ok: false; reason: string }> {
  const { data: skus, error } = await sb.from('mfg_products').select('code').eq('model_id', modelId);
  if (error) return { ok: false, reason: `mfg_products: ${error.message}` };
  for (const s of skus as Array<{ code: string }>) {
    const u = await findSkuUsage(sb, s.code);
    if (!u.ok) return u;
    if (u.usage) return { ok: true, usage: { ...u.usage, code: s.code } };
  }
  return { ok: true, usage: null };
}

/** The refusal body both delete routes return on an unreadable probe. A 409 the
 *  operator can retry is the right answer to "we could not check" — the same
 *  ruling downstream-lock.ts records for DOWNSTREAM_CHECK_FAILED. */
export const usageCheckFailedBody = (what: string, reason: string) => ({
  error: USAGE_CHECK_FAILED,
  reason:
    `Could not check whether this ${what} has been used, so it is kept rather than deleted `
    + `on an answer nobody verified — try again (${reason}).`,
});
