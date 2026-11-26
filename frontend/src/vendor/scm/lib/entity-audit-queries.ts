
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type EntityAuditFieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};

export type EntityAuditEntry = {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_doc_no: string | null;
  action: string;
  actor_id: string | null;
  actor_name_snapshot: string | null;
  field_changes: EntityAuditFieldChange[];
  status_snapshot: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
};

export const AUDIT_ENTITY_TYPES = [
  'PAYMENT_VOUCHER',
  'GRN',
  'STOCK_TAKE',
  'STOCK_TRANSFER',
  'INVENTORY_ADJUSTMENT',
  'SALES_INVOICE',
  'PURCHASE_ORDER',
  'PURCHASE_INVOICE',
  'DELIVERY_ORDER',
  'PURCHASE_RETURN',
  'PRODUCT_REQUEST',
  'PAYMENT_REQUEST',
  'COMMISSION_MONTH',
  'OPENING_BALANCE',
  'LORRY_OFF_ROAD',
  'GL_ACCOUNT',
  'CREDIT_NOTE',
  'DAILY_BANK_START',
  'DAILY_BANK_RECEIPT',
  'DAILY_BANK_SKIP',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * One document's audit history, newest first.
 *
 * staleTime is 0, unlike most queries in this tree. The drawer is mounted only
 * while it is open, so every open is a fresh fetch — which is the point: the
 * common way to reach History is right after making an edit, and a cached list
 * that omits the edit the user just made reads as "the system did not record
 * it". The cost is one request per click on a capped (<=500 row) read.
 */
export const useEntityAuditLog = (
  entityType: AuditEntityType,
  entityId: string | null,
) => useQuery({
  queryKey: ['scm-entity-audit-log', entityType, entityId],
  queryFn: () => authedFetch<{ entries: EntityAuditEntry[] }>(
    `/entity-audit-log/${entityType}/${entityId}`,
  ).then((r) => r.entries),
  enabled: Boolean(entityId),
  staleTime: 0,
  retry: retryUnlessClientError,
});
