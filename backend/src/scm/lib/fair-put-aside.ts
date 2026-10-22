// ----------------------------------------------------------------------------
// fair-put-aside — an order Finance or PMS has put aside on Fair Links (owner
// 2026-10-21: 「还有一些我看了是 service 要 put aside 的」).
//
// A person looked at it and decided it needs no fair — a service charge, say.
// While put aside it leaves every Fair Links group (fair-pending.ts, fair-
// checks.ts) and the menu's red count, and waits in a folded "Put aside" group
// at the bottom of the page until someone brings it back. Linking it to a fair
// by hand brings it back too (the settle route and fair-transfer.ts clear it):
// the person has decided it IS a fair sale.
//
// Two columns on the order (migration 20261021T1800): when, and by whom. The
// order's History has the same, as a row of its own.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { FAIR_PENDING_COLUMNS, type FairPendingRow, type FairPendingScope } from './fair-pending';
import { recordSoAudit } from './so-audit';

const PUT_ASIDE_COLUMNS = `${FAIR_PENDING_COLUMNS}, fair_put_aside_at, fair_put_aside_by`;

export type PutAsideRow = FairPendingRow & { fair_put_aside_at: string; fair_put_aside_by: string | null };

/** The columns a hand-made link clears, so the order is listed again. */
export const NOT_PUT_ASIDE = { fair_put_aside_at: null, fair_put_aside_by: null } as const;

/** The put-aside orders, most recently put aside first. A failed read is a
 *  failure — never an empty group. */
export async function loadFairPutAside(
  sb: SupabaseClient,
  scope: FairPendingScope,
  limit: number,
): Promise<{ ok: true; rows: PutAsideRow[] } | { ok: false }> {
  const res = await scope(
    sb.from('mfg_sales_orders').select(PUT_ASIDE_COLUMNS)
      .not('fair_put_aside_at', 'is', null)
      .neq('status', 'CANCELLED')
      .order('fair_put_aside_at', { ascending: false })
      .limit(limit),
  );
  if (res.error) return { ok: false };
  return { ok: true, rows: res.data as unknown as PutAsideRow[] };
}

export type PutAsideResult = { ok: true; changed: boolean } | { ok: false; reason: 'not_found' | 'read_failed' | 'update_failed' };

/** Put one order aside (`aside` true) or bring it back (false), with its
 *  History row. Nothing is written when it is already that way. */
export async function setFairPutAside(args: {
  sb: SupabaseClient;
  companyId: number;
  docNo: string;
  aside: boolean;
  actorId: string | null;
  actorName: string | null;
}): Promise<PutAsideResult> {
  const { sb, companyId, docNo, aside, actorId, actorName } = args;
  const { data: so, error: readErr } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, fair_put_aside_at')
    .eq('doc_no', docNo)
    .eq('company_id', companyId)
    .maybeSingle();
  if (readErr) return { ok: false, reason: 'read_failed' };
  if (!so) return { ok: false, reason: 'not_found' };
  const isAside = (so as { fair_put_aside_at?: string | null }).fair_put_aside_at != null;
  if (isAside === aside) return { ok: true, changed: false };

  const { error } = await sb
    .from('mfg_sales_orders')
    .update(aside ? { fair_put_aside_at: new Date().toISOString(), fair_put_aside_by: actorName } : NOT_PUT_ASIDE)
    .eq('doc_no', docNo)
    .eq('company_id', companyId);
  if (error) return { ok: false, reason: 'update_failed' };

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_FAIR',
    actorId,
    actorName,
    fieldChanges: [{ field: 'Fair Links', from: aside ? 'Listed' : 'Put aside', to: aside ? 'Put aside' : 'Listed' }],
    source: 'settle',
  });
  return { ok: true, changed: true };
}
