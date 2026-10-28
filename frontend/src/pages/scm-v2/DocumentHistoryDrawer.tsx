/* DocumentHistoryDrawer — one line per document detail page.

   EntityHistoryPanel already takes the five props a drawer needs, and the four
   existing call sites each spell all five out. That was fine at four; at nine it
   is nine places to keep a label dictionary, an entity name and a StatusPill
   vocabulary agreed with each other, and the whole reason this change exists is
   that TWO such lists had silently disagreed for months.

   So the per-document constants live here, in one registry keyed by the same
   entity type the backend records under, and a page mounts its history with:

     {historyOpen && (
       <DocumentHistoryDrawer doc="SALES_INVOICE" id={inv.id} label={inv.doc_no}
                              onClose={closeHistory} />
     )}

   Adding a document is one row in DOCS, not a fifth copy of the same six lines.

   Not every AuditEntityType is in DOCS. PURCHASE_RETURN and
   INVENTORY_ADJUSTMENT are recorded write-only today and have no detail screen
   asking for them, so the registry's key type is a SUBSET rather than the full
   union — an entry appears when a page needs it, and the compiler refuses a
   `doc` this file cannot render. */

import { memo } from 'react';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import type { AuditLabelDictionary } from '../../components/audit/audit-labels';
import type { AuditEntityType } from '../../vendor/scm/lib/entity-audit-queries';
import type { StatusDocType } from '../../vendor/scm/lib/status-pill';
import {
  PURCHASE_ORDER_AUDIT_LABELS,
  PURCHASE_INVOICE_AUDIT_LABELS,
  SALES_INVOICE_AUDIT_LABELS,
  DELIVERY_ORDER_AUDIT_LABELS,
} from './document-audit-labels';
import {
  GRN_AUDIT_LABELS,
  PAYMENT_VOUCHER_AUDIT_LABELS,
  STOCK_TAKE_AUDIT_LABELS,
  STOCK_TRANSFER_AUDIT_LABELS,
} from './entity-audit-labels';

type DocSpec = {
  /* Shown in the drawer's accessible dialog label, in the words staff use for
     the document rather than the backend's SCREAMING_CASE. */
  entityName: string;
  labels: AuditLabelDictionary;
  statusDocType: StatusDocType;
};

export type HistoryDocType = Extract<
  AuditEntityType,
  'PURCHASE_ORDER' | 'PURCHASE_INVOICE' | 'SALES_INVOICE' | 'DELIVERY_ORDER'
  | 'GRN' | 'PAYMENT_VOUCHER' | 'STOCK_TAKE' | 'STOCK_TRANSFER'
>;

export const DOCS: Record<HistoryDocType, DocSpec> = {
  PURCHASE_ORDER:   { entityName: 'Purchase order',   labels: PURCHASE_ORDER_AUDIT_LABELS,   statusDocType: 'po' },
  PURCHASE_INVOICE: { entityName: 'Purchase invoice', labels: PURCHASE_INVOICE_AUDIT_LABELS, statusDocType: 'pi' },
  SALES_INVOICE:    { entityName: 'Invoice',          labels: SALES_INVOICE_AUDIT_LABELS,    statusDocType: 'si' },
  DELIVERY_ORDER:   { entityName: 'Delivery order',   labels: DELIVERY_ORDER_AUDIT_LABELS,   statusDocType: 'do' },
  GRN:              { entityName: 'Goods receipt',    labels: GRN_AUDIT_LABELS,              statusDocType: 'grn' },
  PAYMENT_VOUCHER:  { entityName: 'Payment voucher',  labels: PAYMENT_VOUCHER_AUDIT_LABELS,  statusDocType: 'pv' },
  STOCK_TAKE:       { entityName: 'Stock take',       labels: STOCK_TAKE_AUDIT_LABELS,       statusDocType: 'stockTake' },
  STOCK_TRANSFER:   { entityName: 'Stock transfer',   labels: STOCK_TRANSFER_AUDIT_LABELS,   statusDocType: 'stockTransfer' },
};

export type DocumentHistoryDrawerProps = {
  doc: HistoryDocType;
  /* The header row's UUID. The log is keyed on the id, NOT the doc number —
     passing the doc number here returns an empty history that looks real. */
  id: string;
  /* Human document number, shown in the drawer title. */
  label: string;
  onClose: () => void;
};

export const DocumentHistoryDrawer = memo(({ doc, id, label, onClose }: DocumentHistoryDrawerProps) => {
  const spec = DOCS[doc];
  return (
    <EntityHistoryPanel
      entityType={doc}
      entityId={id}
      recordLabel={label}
      entityName={spec.entityName}
      labels={spec.labels}
      statusDocType={spec.statusDocType}
      onClose={onClose}
    />
  );
});
DocumentHistoryDrawer.displayName = 'DocumentHistoryDrawer';
