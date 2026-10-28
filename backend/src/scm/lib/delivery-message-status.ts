// ---------------------------------------------------------------------------
// delivery-message-status.ts — move a sent order's Delivery Message Status to
// its "Done X" in the same request that sent the WhatsApp (HC-0164).
//
// Until 2026-10-28 the board's send modal wrote the status itself, one
// fire-and-forget PATCH per order after the send answered. Nothing reported a
// failed one: a modal closed mid-send, an SO editor lease or a version race
// left the row on "To Send Delivery Date" although the customer already had
// the message (HC-SO-006432 / 010484, 2026-10-26 17:03 MYT). Written here, the
// send and the status share one request, and an order whose status could not
// move comes back to the caller by name.
// ---------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies } from './companyScope';
import { advanceSoGeneration } from './so-generation';
import { recordSoAudit } from './so-audit';

export interface StatusNotMoved { docNo: string; reason: string }

/* A version race with another writer of the same header (stock allocation, the
   sheet sync) is retried; an open SO editor lease is not - that order is the
   editor's until it saves. */
const CONFLICT_RETRIES = 2;

export async function markSentStatus(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  docNos: readonly string[],
  status: string,
  kindLabel: string,
): Promise<StatusNotMoved[]> {
  if (docNos.length === 0) return [];
  const sb = c.get('supabase');
  const { data, error } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders').select('doc_no, status, delivery_message_status').in('doc_no', [...docNos]),
    c,
  );
  if (error) return docNos.map((docNo) => ({ docNo, reason: 'read_failed' }));
  const before = new Map(((data ?? []) as Array<{ doc_no: string; status: string | null; delivery_message_status: string | null }>)
    .map((r) => [r.doc_no, r]));

  const user = c.get('user') as { id?: string; user_metadata?: { name?: string } } | null;
  const notMoved: StatusNotMoved[] = [];
  for (const docNo of docNos) {
    const prev = before.get(docNo);
    if (!prev) { notMoved.push({ docNo, reason: 'not_found' }); continue; }
    if (prev.delivery_message_status === status) continue;
    let reason: string | null = null;
    for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt++) {
      try {
        const res = await advanceSoGeneration(sb, docNo, { delivery_message_status: status });
        reason = res.applied ? null : res.reason;
      } catch (e) {
        reason = `write_failed: ${String((e as Error).message).slice(0, 120)}`;
      }
      if (reason !== 'conflict') break;
    }
    if (reason) { notMoved.push({ docNo, reason }); continue; }
    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_DETAILS',
      actorId: user?.id ?? null,
      actorName: user?.user_metadata?.name ?? null,
      fieldChanges: [{ field: 'deliveryMessageStatus', from: prev.delivery_message_status ?? null, to: status }],
      statusSnapshot: prev.status ?? null,
      source: 'delivery-planning',
      note: `${kindLabel} message sent`,
    });
  }
  return notMoved;
}
