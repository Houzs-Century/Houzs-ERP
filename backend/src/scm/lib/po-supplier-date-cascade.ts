/* Set ONE supplier-revised delivery date slot on a purchase order and cascade it
 * down to every line — the write behind the bulk supplier-date action
 * (POST /mfg-purchase-orders/bulk-supplier-date, owner 2026-08-03) and behind the
 * PO line import's Estimate Delivery Date 1/2/3 (owner 2026-09-15). One writer,
 * so the two doors cannot disagree about what "move the estimate date" does.
 *
 * The line write is UNCONDITIONAL (no `.is(col, null)`), because the point is the
 * SECOND revision, when every line already carries the first one.
 *
 * NOT here, on purpose: the downstream-lock check and the AutoCount enqueue. The
 * caller checks the lock before it calls, and enqueues once per purchase order
 * after ALL of that order's writes — an import that moves a date and edits three
 * lines of the same PO must queue one edit, not two. */
import { diffFields, recordEntityAudit, type AuditActor } from './entity-audit';
import { scopeToCompanyId } from './companyScope';

export const SUPPLIER_DATE_SLOT_COL = {
  2: 'supplier_delivery_date_2',
  3: 'supplier_delivery_date_3',
  4: 'supplier_delivery_date_4',
} as const;
export type SupplierDateSlot = keyof typeof SUPPLIER_DATE_SLOT_COL;

/* A postgres.js transaction hands a date column back as a JS Date; the audit's
   from-value must still read as the day, not "Tue Sep 15 2026 ...". */
const dayOrRaw = (v: unknown): unknown => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

export async function cascadePoSupplierDate(
  sb: any,
  args: {
    companyId: number;
    poId: string;
    /** The header row read BEFORE the write: po_number, status, company_id and the slot column. */
    before: Record<string, unknown>;
    slot: SupplierDateSlot;
    /** null clears the slot, as the PO editor's own blank does. */
    date: string | null;
    applyToLines: boolean;
    actor: AuditActor | null;
    note: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { companyId, poId, before, slot, date, applyToLines, actor, note } = args;
  const col = SUPPLIER_DATE_SLOT_COL[slot];

  const { error } = await scopeToCompanyId(
    sb.from('purchase_orders').update({ [col]: date, updated_at: new Date().toISOString() }).eq('id', poId),
    companyId,
  );
  if (error) return { ok: false, reason: error.message };

  if (applyToLines) {
    const { error: lineErr } = await scopeToCompanyId(
      sb.from('purchase_order_items').update({ [col]: date }).eq('purchase_order_id', poId),
      companyId,
    );
    /* The header already moved, so a line failure is reported rather than
       swallowed: the operator has to know this PO is half-applied. */
    if (lineErr) return { ok: false, reason: `Header updated but lines failed: ${lineErr.message}` };
  }

  const camel = `supplierDeliveryDate${slot}`;
  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId: poId,
    entityDocNo: (before.po_number as string | null) ?? null,
    action: 'UPDATE',
    actor,
    companyId: (before.company_id as number | null) ?? companyId,
    statusSnapshot: (before.status as string | null) ?? null,
    ...(note ? { note } : {}),
    fieldChanges: diffFields({ [col]: dayOrRaw(before[col]) }, { [camel]: date }, [[camel, col]]),
  });
  return { ok: true };
}
