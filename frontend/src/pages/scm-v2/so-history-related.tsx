/* The SO History drawer's view of the documents raised from the order.

   The SO's own trail (mfg_so_audit_log) never carried "PO created" or "DO
   created" — those rows live in entity_audit_log against the child document —
   so the drawer could not answer when the PO for this order was raised (ticket
   DEV-16). This merges the children's rows into the SO trail, tags each one with
   its document number linking to that document, and reads each row with its own
   document's vocabulary. Shared by the V2 detail page and the V1 editor so the
   two drawers cannot tell different stories. */

import { useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AuditLabelDictionary, AuditLogEntry } from '../../components/audit/audit-labels';
import {
  useSalesOrderRelatedAuditLog,
  type SoAuditEntry,
  type SoRelatedAuditEntry,
} from '../../vendor/scm/lib/sales-order-queries';
import { SO_AUDIT_LABELS } from './so-audit-labels';
import {
  DELIVERY_ORDER_AUDIT_LABELS,
  PURCHASE_ORDER_AUDIT_LABELS,
  SALES_INVOICE_AUDIT_LABELS,
} from './document-audit-labels';

const RELATED: Record<SoRelatedAuditEntry['entity_type'], { labels: AuditLabelDictionary; path: string }> = {
  PURCHASE_ORDER: { labels: PURCHASE_ORDER_AUDIT_LABELS, path: '/scm/purchase-orders/' },
  DELIVERY_ORDER: { labels: DELIVERY_ORDER_AUDIT_LABELS, path: '/scm/delivery-orders/' },
  SALES_INVOICE: { labels: SALES_INVOICE_AUDIT_LABELS, path: '/scm/sales-invoices/' },
};

const DOC_TAG_STYLE: CSSProperties = {
  marginLeft: 6,
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  color: 'var(--brand, #16695f)',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  whiteSpace: 'nowrap',
};

type RelatedFields = Pick<SoRelatedAuditEntry, 'entity_type' | 'entity_id' | 'entity_doc_no'>;
export type SoHistoryEntry = AuditLogEntry & Partial<RelatedFields>;

const relatedOf = (e: AuditLogEntry): RelatedFields | null => {
  const r = e as SoHistoryEntry;
  return r.entity_type && r.entity_id && RELATED[r.entity_type]
    ? { entity_type: r.entity_type, entity_id: r.entity_id, entity_doc_no: r.entity_doc_no ?? null }
    : null;
};

export function useSoHistoryWithRelated(docNo: string | null, own: SoAuditEntry[] | undefined) {
  const q = useSalesOrderRelatedAuditLog(docNo);

  const entries = useMemo<SoHistoryEntry[]>(() => {
    /* Prefixed ids: the two tables number their rows independently, and the
       drawer keys its expand state on the id. */
    const related = (q.data ?? []).map((e) => ({ ...e, id: `${e.entity_type}:${e.id}` }));
    return [...(own ?? []), ...related].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  }, [own, q.data]);

  const labelsFor = useCallback((e: AuditLogEntry): AuditLabelDictionary => {
    const r = relatedOf(e);
    return r ? RELATED[r.entity_type].labels : SO_AUDIT_LABELS;
  }, []);

  const renderDocTag = useCallback((e: AuditLogEntry): ReactNode => {
    const r = relatedOf(e);
    if (!r) return null;
    return (
      <Link to={`${RELATED[r.entity_type].path}${r.entity_id}`} style={DOC_TAG_STYLE}>
        {r.entity_doc_no ?? r.entity_id}
      </Link>
    );
  }, []);

  return { entries, isLoading: q.isLoading, error: q.error, labelsFor, renderDocTag };
}
