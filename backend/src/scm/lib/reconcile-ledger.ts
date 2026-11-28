
import { paginateAll } from './paginate-all';
import { DO_SHIPPED_STATES } from '../shared/do-shipped-states';

/** One flagged document — a posted/shipped doc with no matching movement. */
export type LedgerIssue = { docType: string; id: string; docNo: string; status: string };

/** Full reconcile result; same shape the /reconcile route has always returned. */
export type ReconcileResult = { asOf: string; issueCount: number; issues: LedgerIssue[] };

const DO_SHIPPED: readonly string[] = DO_SHIPPED_STATES;

type DocRow = Record<string, string | null | undefined>;

/**
 * Run the read-only ledger reconcile sweep against the scm-schema supabase
 * client. `sb` is a supabase-js client already scoped to the `scm` schema
 * (getSupabaseService(env) — db.schema='scm'), the same one the route uses.
 */
export async function reconcileLedger(sb: any, companyId: number | null | undefined): Promise<ReconcileResult> {
  const withCo = (q: any) => (companyId != null ? q.eq('company_id', companyId) : q);
  const { data: movRows, error: movErr } = await paginateAll<{ source_doc_type: string | null; source_doc_id: string | null }>((from, to) => withCo(sb
    .from('inventory_movements')
    .select('source_doc_type, source_doc_id'))
    .range(from, to));
  if (movErr) throw new Error(movErr.message);
  const hasMov = new Set<string>();
  for (const m of (movRows ?? []) as Array<{ source_doc_type: string | null; source_doc_id: string | null }>) {
    if (m.source_doc_id) hasMov.add(`${m.source_doc_type}::${m.source_doc_id}`);
  }

  const issues: LedgerIssue[] = [];
  const flag = (docType: string, movType: string, rows: DocRow[], numCol: string) => {
    for (const r of rows) {
      const id = (r.id as string) ?? '';
      if (id && !hasMov.has(`${movType}::${id}`)) {
        issues.push({ docType, id, docNo: (r[numCol] as string) ?? id, status: (r.status as string) ?? '' });
      }
    }
  };

  const [
    grnsR, dosR, prsR, drsR,
    transfersR, csNotesR, csReturnsR, pcReceivesR, pcReturnsR,
  ] = await Promise.all([
    paginateAll<DocRow>((from, to) => withCo(sb.from('grns').select('id, grn_number, status').eq('status', 'POSTED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('delivery_orders').select('id, do_number, status').in('status', DO_SHIPPED)).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('purchase_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('delivery_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('stock_transfers').select('id, transfer_no, status').eq('status', 'POSTED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('consignment_delivery_orders').select('id, do_number, status').in('status', DO_SHIPPED)).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('consignment_delivery_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('purchase_consignment_receives').select('id, receive_number, status').neq('status', 'CANCELLED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('purchase_consignment_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
  ]);


  flag('GRN', 'GRN', (grnsR.data ?? []) as DocRow[], 'grn_number');
  flag('Delivery Order', 'DO', (dosR.data ?? []) as DocRow[], 'do_number');
  flag('Purchase Return', 'PURCHASE_RETURN', (prsR.data ?? []) as DocRow[], 'return_number');
  flag('Delivery Return', 'DR', (drsR.data ?? []) as DocRow[], 'return_number');
  flag('Stock Transfer', 'STOCK_TRANSFER', (transfersR.data ?? []) as DocRow[], 'transfer_no');
  flag('Consignment Note', 'CS_DO', (csNotesR.data ?? []) as DocRow[], 'do_number');
  flag('Consignment Return', 'CS_DR', (csReturnsR.data ?? []) as DocRow[], 'return_number');
  flag('PC Receive', 'PC_RECEIVE', (pcReceivesR.data ?? []) as DocRow[], 'receive_number');
  flag('PC Return', 'PC_RETURN', (pcReturnsR.data ?? []) as DocRow[], 'return_number');

  return { asOf: new Date().toISOString(), issueCount: issues.length, issues };
}
