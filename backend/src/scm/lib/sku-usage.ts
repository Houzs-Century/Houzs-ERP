// sku-usage — "has this SKU / Model been used yet?" guard.
//
// Wei Siang 2026-06-08: once a SKU has been USED in a real document — sold on a
// Sales Order, ordered on a Purchase Order, or moved in stock (any inventory
// movement) — it must NOT be deletable, not even by force. Deleting it would
// orphan live order lines (which store item_code as a text snapshot, no FK) and
// destroy stock-movement history. A Model is locked the moment ANY of its SKUs
// is used. Before first use (setup phase) deletes stay allowed so a mistyped
// model can still be removed and re-created.
//
// ── A FAILED PROBE IS NOT "UNUSED" ─────────────────────────────────────────
// This is the guard whose whole job is to say NO, and it used to say YES when it
// could not look. `findSkuUsage` bound the PostgREST `error` and then threw it
// away with `if (error) continue`; `findModelUsage` did not bind it at all and
// read `skus ?? []`. Either way a five-second blip on mfg_sales_order_items came
// back as "this SKU has never been sold", which is the exact absence that
// authorises the delete — and on the force path, the delete that also wipes
// inventory_movements and the supplier bindings for that code. A failed read
// must never read as an absence when the absence is what authorises the write
// (the rule is downstream-lock.ts's, in its own words).
//
// The one tolerance the old comment was actually reaching for is kept, and only
// that one: a table that DOES NOT EXIST on a fresh deployment is genuinely "no
// usage recorded there", not a failure to look. That predicate is spelled out
// below for the same reason rpc-missing.ts spells out its own — "absent" and
// "failed" must be told apart with total precision, because the fallback taken
// on a real error is the bug.
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
      // Absent table on a fresh DB: genuinely nothing recorded there. Anything
      // else is a probe that did not run, and the SKU stays undeletable.
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
  /* The SKU list itself gates the loop below: an unreadable list means ZERO
     iterations, which returned "model unused" and let the delete through. */
  const { data: skus, error } = await sb.from('mfg_products').select('code').eq('model_id', modelId);
  if (error) return { ok: false, reason: `mfg_products: ${error.message}` };
  /* No `?? []`: the early return above is what makes `skus` an array, and
     folding a null back into an empty list here would rebuild the exact
     "unreadable list reads as no SKUs" path the comment above describes. */
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
