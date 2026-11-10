// Files on the receiving and return documents (backlog A3): Goods Received,
// Purchase Invoice, Delivery Return, Purchase Return. One hook set for all
// four, keyed by the document kind, so the desktop page and the phone detail
// read and write through the same calls. The server
// (backend/src/scm/routes/flow-doc-files.ts) owns the rules; the client only
// reads its `locked` answer and treats CANCELLED as closed, which the server
// also refuses.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { fetchDocFileBlobUrl, type PvFile, type PvFilePayload } from './payment-voucher-queries';
import { ACCESS_RANK, type AccessLevel } from '../../../types';

export type FlowDocKind = 'grn' | 'purchase-invoice' | 'delivery-return' | 'purchase-return';

export const FLOW_DOC_FILES: Record<FlowDocKind, { path: string; area: string; noun: string }> = {
  grn: { path: '/grns', area: 'scm.procurement.grn', noun: 'goods received note' },
  'purchase-invoice': { path: '/purchase-invoices', area: 'scm.procurement.pi', noun: 'purchase invoice' },
  'delivery-return': { path: '/delivery-returns', area: 'scm.sales.returns', noun: 'delivery return' },
  'purchase-return': { path: '/purchase-returns', area: 'scm.procurement.pr', noun: 'purchase return' },
};

/** The phone's generic detail screen names documents by module key. */
export const FLOW_DOC_KIND_BY_MODULE: Partial<Record<string, FlowDocKind>> = {
  grns: 'grn',
  'purchase-invoices': 'purchase-invoice',
  'delivery-returns': 'delivery-return',
  'purchase-returns': 'purchase-return',
};

/** The server gate is scmAreaGuard: `edit` on the document's area for any write. */
export const canWriteFlowDocFiles = (
  kind: FlowDocKind,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): boolean => can('*') || ACCESS_RANK[pageAccess(FLOW_DOC_FILES[kind].area)] >= ACCESS_RANK.edit;

const base = (kind: FlowDocKind, docId: string) => `${FLOW_DOC_FILES[kind].path}/${docId}/files`;
const key = (kind: FlowDocKind, docId: string | null) => ['flow-doc-files', kind, docId];

export const useFlowDocFiles = (kind: FlowDocKind, docId: string | null) => useQuery({
  queryKey: key(kind, docId),
  queryFn: () => authedFetch<{ files: PvFile[]; locked: boolean }>(base(kind, docId as string)),
  enabled: !!docId,
  retry: retryUnlessClientError,
});

/** For a document that did not exist when the page mounted (a file attached
    right after its create), where the hook below cannot be bound yet. */
export const uploadFlowDocFile = (kind: FlowDocKind, docId: string, file: PvFilePayload) =>
  authedFetch<{ ok: true; file: PvFile }>(base(kind, docId), {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }),
  });

export const useUploadFlowDocFile = (kind: FlowDocKind, docId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: PvFilePayload) => uploadFlowDocFile(kind, docId, file),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key(kind, docId) }); },
  });
};

export const useDeleteFlowDocFile = (kind: FlowDocKind, docId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => authedFetch<{ ok: true }>(`${base(kind, docId)}/${fileId}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key(kind, docId) }); },
  });
};

export const fetchFlowDocFileBlobUrl = (kind: FlowDocKind, docId: string, fileId: string) =>
  fetchDocFileBlobUrl(`${base(kind, docId)}/${fileId}`);
