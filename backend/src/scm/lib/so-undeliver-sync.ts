import { DO_NOT_DELIVERED_IN_LIST, doHasArrived } from '../shared/do-shipped-states';
import { advanceSoGeneration } from './so-generation';
import { recordSoAudit } from './so-audit';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the SCM libs */
type Db = any;

export type SoUndeliverOutcome =
  | 'stepped_back'
  | 'not_delivered'
  | 'still_delivered'
  | 'conflict'
  | 'read_failed';

/** Pure: does any live DO of the order still say the delivery happened? */
export function anyDoStillDelivered(
  dos: Array<{ status: string | null; customer_delivered_date: string | null }>,
): boolean {
  return dos.some((d) => doHasArrived(d.status) || !!d.customer_delivered_date);
}

export async function stepSoBackFromDelivered(
  sb: Db,
  p: { soDocNo: string | null; companyId: number; actorId: string | null; doNumber: string },
): Promise<SoUndeliverOutcome> {
  if (!p.soDocNo) return 'not_delivered';
  const { data: so, error: soErr } = await sb.from('mfg_sales_orders')
    .select('status').eq('doc_no', p.soDocNo).eq('company_id', p.companyId).maybeSingle();
  if (soErr) return 'read_failed';
  if ((so as { status?: string | null } | null)?.status !== 'DELIVERED') return 'not_delivered';

  const { data: dos, error: doErr } = await sb.from('delivery_orders')
    .select('status, customer_delivered_date')
    .eq('so_doc_no', p.soDocNo).eq('company_id', p.companyId)
    .not('status', 'in', DO_NOT_DELIVERED_IN_LIST);
  if (doErr) return 'read_failed';
  if (anyDoStillDelivered((dos ?? []) as Array<{ status: string | null; customer_delivered_date: string | null }>)) {
    return 'still_delivered';
  }

  const gen = await advanceSoGeneration(sb, p.soDocNo, { status: 'SHIPPED' }, { status: 'DELIVERED' });
  if (!gen.applied) return 'conflict';
  const note = `Auto: ${p.doNumber} taken back from Delivered — the order is shipped, not yet delivered`;
  await sb.from('mfg_so_status_changes').insert({
    company_id: p.companyId, doc_no: p.soDocNo, from_status: 'DELIVERED', to_status: 'SHIPPED',
    changed_by: p.actorId, notes: note,
  });
  await recordSoAudit(sb, {
    docNo: p.soDocNo, action: 'UPDATE_STATUS', actorId: p.actorId,
    fieldChanges: [{ field: 'status', from: 'DELIVERED', to: 'SHIPPED' }],
    statusSnapshot: 'SHIPPED', source: 'automation', note,
  });
  return 'stepped_back';
}
