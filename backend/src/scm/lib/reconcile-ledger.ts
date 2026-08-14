// ----------------------------------------------------------------------------
// reconcile-ledger — read-only inventory-ledger integrity sweep.
//
// Inventory writes across the SCM are best-effort: a failed movement insert
// does NOT roll back the parent document (see every routes/*.ts resync/write
// helper — they return errors rather than throwing). So a document can be
// POSTED / shipped / received while its stock movement silently never landed.
//
// This sweep flags every non-cancelled document that, in its current status,
// ALWAYS moves stock but has ZERO matching inventory_movements rows — a silent
// partial-write the operator can then re-post or investigate.
//
// Pure read-only + bounded (.limit on every read). Shared by:
//   • scm/routes/inventory.ts  GET /reconcile        (operator-facing detail)
//   • routes/systemHealth.ts   "Inventory ledger integrity" check (count only)
//
// Match key = `${source_doc_type}::${source_doc_id}` where source_doc_id is the
// document HEADER's own id. The source_doc_type for each flow is the PRIMARY
// label the write path stamps on the FIRST movement of a fresh document (later
// resync deltas reuse 'STOCK_TRANSFER', but a document that moved stock at all
// always has at least its primary-label row, so matching on the primary label
// alone never false-flags a doc that did move).
// ----------------------------------------------------------------------------

import { paginateAll } from './paginate-all';
import { DO_SHIPPED_STATES } from '../shared/do-shipped-states';

/** One flagged document — a posted/shipped doc with no matching movement. */
export type LedgerIssue = { docType: string; id: string; docNo: string; status: string };

/** Full reconcile result; same shape the /reconcile route has always returned. */
export type ReconcileResult = { asOf: string; issueCount: number; issues: LedgerIssue[] };

// Delivery-Order shipped states that mean the DO has deducted stock (OUT): a
// dispatched/in-transit/signed/delivered/invoiced doc has shipped, so it must
// have an OUT movement. Read from shared/do-shipped-states.ts, which is also
// what delivery-orders-mfg.ts and consignment-notes.ts read — "identical to
// consignment-notes' SHIPPED_STATES" is what this comment used to CLAIM, and a
// claim is not a mechanism.
//
// This is the 5-state set, so a COMPLETED delivery order is NOT scanned — and
// COMPLETED is a legal DO status (DO_STATUSES, delivery-orders-mfg.ts) that sits
// past INVOICED, i.e. one whose OUT should exist. Behaviour is unchanged from
// the hand-typed list this replaced; whether the sweep should widen to
// DO_STOCK_OUT_STATES is a real question and an owner's call, not something to
// change while collapsing a duplicated list. Flagged in the PR, not fixed here.
const DO_SHIPPED: readonly string[] = DO_SHIPPED_STATES;

// A row from any document header read below: id + a doc-number col + status.
type DocRow = Record<string, string | null | undefined>;

/**
 * Run the read-only ledger reconcile sweep against the scm-schema supabase
 * client. `sb` is a supabase-js client already scoped to the `scm` schema
 * (getSupabaseService(env) — db.schema='scm'), the same one the route uses.
 */
export async function reconcileLedger(sb: any, companyId: number | null | undefined): Promise<ReconcileResult> {
  // Per-company scoping: when a companyId is given (operator-facing /reconcile,
  // which is per-company), every read is filtered to that company so the report
  // can't surface the other company's doc numbers. When omitted (System Health's
  // cross-company integrity count), behaviour is unchanged — all companies.
  const withCo = (q: any) => (companyId != null ? q.eq('company_id', companyId) : q);
  // All movements, indexed by `${type}::${doc_id}` so the per-doc check is O(1).
  // Page through — PostgREST caps a single response at 1000 rows, so a bare
  // .limit(200_000) silently truncated to the first 1000 movements, which would
  // make EVERY document past that window look like it never moved stock (mass
  // false-positives). paginateAll reads the full ledger.
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
  // flag(docType, movType, rows, numCol): a doc with id X but no `${movType}::X`
  // movement row is flagged. numCol is the header's human doc-number column.
  const flag = (docType: string, movType: string, rows: DocRow[], numCol: string) => {
    for (const r of rows) {
      const id = (r.id as string) ?? '';
      if (id && !hasMov.has(`${movType}::${id}`)) {
        issues.push({ docType, id, docNo: (r[numCol] as string) ?? id, status: (r.status as string) ?? '' });
      }
    }
  };

  // Page through every header read too — a bare .limit(10_000) is still capped at
  // PostgREST's 1000-row ceiling, so a busy month past 1000 docs would drop the
  // overflow from the sweep (the dropped docs would simply never be checked). The
  // status filter stays INSIDE each page query so every page is consistent.
  const [
    grnsR, dosR, prsR, drsR,
    transfersR, csNotesR, csReturnsR, pcReceivesR, pcReturnsR,
  ] = await Promise.all([
    // ── existing coverage (unchanged) ──────────────────────────────────────
    paginateAll<DocRow>((from, to) => withCo(sb.from('grns').select('id, grn_number, status').eq('status', 'POSTED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('delivery_orders').select('id, do_number, status').in('status', DO_SHIPPED)).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('purchase_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
    paginateAll<DocRow>((from, to) => withCo(sb.from('delivery_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
    // ── new coverage (all stock-moving SCM document types) ─────────────────
    // Stock Transfer: only ever POSTED or CANCELLED (DRAFT removed in mig 0078);
    // a POSTED transfer with qty>0 lines always writes paired OUT/IN movements
    // labelled STOCK_TRANSFER on the header id.
    paginateAll<DocRow>((from, to) => withCo(sb.from('stock_transfers').select('id, transfer_no, status').eq('status', 'POSTED')).range(from, to)),
    // Consignment Note (dispatch, stock OUT): created directly at DISPATCHED and
    // only moves among DO_SHIPPED states or CANCELLED. The first ship-out writes
    // a CS_DO OUT on the header id (consignment_delivery_orders).
    paginateAll<DocRow>((from, to) => withCo(sb.from('consignment_delivery_orders').select('id, do_number, status').in('status', DO_SHIPPED)).range(from, to)),
    // Consignment Return (stock IN): posts immediately on create (no DRAFT),
    // status RECEIVED; first IN is labelled CS_DR on the header id.
    paginateAll<DocRow>((from, to) => withCo(sb.from('consignment_delivery_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
    // Purchase Consignment Receive (stock IN): posts immediately (no DRAFT),
    // status POSTED; first IN labelled PC_RECEIVE on the header id.
    paginateAll<DocRow>((from, to) => withCo(sb.from('purchase_consignment_receives').select('id, receive_number, status').neq('status', 'CANCELLED')).range(from, to)),
    // Purchase Consignment Return (stock OUT): posts immediately (no DRAFT);
    // first OUT labelled PC_RETURN on the header id.
    paginateAll<DocRow>((from, to) => withCo(sb.from('purchase_consignment_returns').select('id, return_number, status').neq('status', 'CANCELLED')).range(from, to)),
  ]);

  // EXCLUDED — Stock Take (stock_takes): a posted take with NO counted variance
  // legitimately writes ZERO movements, so flagging zero-movement takes would be
  // a guaranteed false positive. Intentionally not swept here.

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
