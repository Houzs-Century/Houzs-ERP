
import { memo } from 'react';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import type { AuditLabelDictionary } from '../../components/audit/audit-labels';
import type { AuditEntityType } from '../../vendor/scm/lib/entity-audit-queries';
import type { StatusDocType } from '../../../../shared/src/vendor/scm/lib/status-pill';
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
  id: string;
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
