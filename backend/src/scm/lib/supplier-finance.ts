// ----------------------------------------------------------------------------
// supplier-finance — who counts as Finance on the supplier master, and when a
// supplier's CODE may still change (owner 2026-09-30: 代码只有 finance 能改;
// a supplier that already has documents or ledger entries waits for the
// change-code tool).
//
// The code IS the AutoCount creditor number, and it is stamped as text on
// every journal line the supplier's paper posts (party_code) and on credit
// notes. Changed by editing the field, the old code stays on the ledger —
// Receipts & Payments then shows the supplier twice — and a 400- to 405-
// change (or back) strands the balance on the old control account. So this
// edit changes a code only while nothing carries it yet; afterwards the
// change goes through the change-code tool, which moves the history with it.
// ----------------------------------------------------------------------------
import { hasCapability, type CapabilityCaller } from '../../services/capabilities';
import { scopeToCompanyId } from './companyScope';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped in this router family */
type Db = any;

/** Finance, for the supplier master: the caller who may move money (capability
    scm.money.move — Finance Executive, Managing Director, Owner, Super Admin). */
export const isSupplierFinanceCaller = (c: { get: (key: 'houzsUser') => unknown }): boolean =>
  hasCapability(c.get('houzsUser') as CapabilityCaller | null | undefined, 'scm.money.move');

/** The documents that carry a supplier by id, in the words an operator uses for them. */
const SUPPLIER_DOCUMENTS: ReadonlyArray<readonly [table: string, label: string]> = [
  ['purchase_orders', 'purchase orders'],
  ['grns', 'goods received notes'],
  ['purchase_invoices', 'purchase invoices'],
  ['purchase_returns', 'purchase returns'],
  ['purchase_consignment_orders', 'consignment orders'],
  ['purchase_consignment_receives', 'consignment receipts'],
  ['purchase_consignment_returns', 'consignment returns'],
  ['ap_invoices', 'AP invoices'],
  ['payment_vouchers', 'payment vouchers'],
  ['acc_credit_notes', 'credit notes'],
  ['acc_supplier_advances', 'supplier advances'],
];

/**
 * The first place this supplier already appears — a document that names it,
 * or a journal line that carries its code — or null when it appears nowhere.
 * Fails closed: a read that errors is reported, never read as "nowhere".
 */
export async function supplierHistory(
  sb: Db, companyId: number, supplierId: string, code: string,
): Promise<{ ok: true; where: string | null } | { ok: false; reason: string }> {
  for (const [table, label] of SUPPLIER_DOCUMENTS) {
    const { count, error } = await scopeToCompanyId(
      sb.from(table).select('id', { count: 'exact', head: true }).eq('supplier_id', supplierId), companyId,
    );
    if (error) return { ok: false, reason: `${table}: ${error.message}` };
    if (Number(count) > 0) return { ok: true, where: label };
  }
  const { count, error } = await scopeToCompanyId(
    sb.from('journal_entry_lines').select('id', { count: 'exact', head: true }).eq('party_type', 'SUPPLIER').eq('party_code', code), companyId,
  );
  if (error) return { ok: false, reason: `journal_entry_lines: ${error.message}` };
  return { ok: true, where: Number(count) > 0 ? 'journal entries' : null };
}

export type CodeChangeRefusal = { status: 403 | 409 | 500; body: { error: string; message: string } };

/** Why changing this supplier's code is refused, or null when it may go ahead.
    Asked only for a code that differs from the one on file. */
export async function supplierCodeChangeRefusal(
  sb: Db, companyId: number, supplier: { id: string; code: string }, finance: boolean,
): Promise<CodeChangeRefusal | null> {
  if (!finance) {
    return { status: 403, body: { error: 'supplier_code_finance_only', message: "Only Finance can change a supplier's code." } };
  }
  const history = await supplierHistory(sb, companyId, supplier.id, supplier.code);
  if (!history.ok) {
    return { status: 500, body: { error: 'history_read_failed', message: 'Could not check where this supplier is used, so its code was not changed. Try again.' } };
  }
  if (history.where) {
    return {
      status: 409,
      body: {
        error: 'supplier_code_has_history',
        message: `${supplier.code} is already on ${history.where}. Its code waits for the change-code tool, which moves the history with it.`,
      },
    };
  }
  return null;
}
