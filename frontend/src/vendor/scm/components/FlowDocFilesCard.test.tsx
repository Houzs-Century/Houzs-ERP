/* The Files card on the receiving and return documents (backlog A3): who sees
 * Attach and Remove, that a finished document keeps its files, that a
 * cancelled one takes no more, and that each kind talks to its own document. */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessLevel } from '../../../types';

let level: AccessLevel = 'edit';
let wildcard = false;
let data: { files: Array<Record<string, unknown>>; locked: boolean } = { files: [], locked: false };
const seen: string[] = [];

vi.mock('../lib/flow-doc-files', async (orig) => ({
  ...(await orig<typeof import('../lib/flow-doc-files')>()),
  useFlowDocFiles: (kind: string, docId: string) => { seen.push(`${kind}:${docId}`); return { data }; },
  useUploadFlowDocFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteFlowDocFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ can: (p: string) => wildcard && p === '*', pageAccess: () => level }),
}));
vi.mock('./ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('./NotifyDialog', () => ({ useNotify: () => vi.fn() }));

const { FlowDocFilesCard } = await import('./FlowDocFilesCard');
const { canWriteFlowDocFiles, FLOW_DOC_KIND_BY_MODULE } = await import('../lib/flow-doc-files');

const FILE = { id: 'f1', file_name: 'supplier-do.pdf', mime: 'application/pdf', size_bytes: 2048, sort_no: 1, created_at: '2026-11-09T01:00:00Z' };

beforeEach(() => { level = 'edit'; wildcard = false; data = { files: [FILE], locked: false }; seen.length = 0; });

describe('FlowDocFilesCard', () => {
  it('an editor of an open document can attach and remove', () => {
    render(<FlowDocFilesCard kind="grn" docId="g1" status="POSTED" />);
    expect(screen.getByLabelText('Attach files to this goods received note')).toBeTruthy();
    expect(screen.getByLabelText('Remove supplier-do.pdf')).toBeTruthy();
    expect(seen).toContain('grn:g1');
  });

  it('a view-only caller sees the files but neither Attach nor Remove', () => {
    level = 'view';
    render(<FlowDocFilesCard kind="purchase-invoice" docId="p1" status="POSTED" />);
    expect(screen.getByText('supplier-do.pdf')).toBeTruthy();
    expect(screen.queryByLabelText('Attach files to this purchase invoice')).toBeNull();
    expect(screen.queryByLabelText('Remove supplier-do.pdf')).toBeNull();
  });

  it('a finished document keeps its files: attach stays, remove goes', () => {
    data = { files: [FILE], locked: true };
    render(<FlowDocFilesCard kind="purchase-return" docId="r1" status="COMPLETED" />);
    expect(screen.getByLabelText('Attach files to this purchase return')).toBeTruthy();
    expect(screen.queryByLabelText('Remove supplier-do.pdf')).toBeNull();
    expect(screen.getByText(/kept with the finished purchase return/)).toBeTruthy();
  });

  it('a cancelled document takes no more files', () => {
    render(<FlowDocFilesCard kind="delivery-return" docId="d1" status="cancelled" />);
    expect(screen.queryByLabelText('Attach files to this delivery return')).toBeNull();
    expect(screen.queryByLabelText('Remove supplier-do.pdf')).toBeNull();
  });
});

describe('canWriteFlowDocFiles mirrors the area guard', () => {
  it('needs edit on the document area, or the wildcard', () => {
    const page = (lv: AccessLevel) => () => lv;
    expect(canWriteFlowDocFiles('grn', () => false, page('view'))).toBe(false);
    expect(canWriteFlowDocFiles('grn', () => false, page('edit'))).toBe(true);
    expect(canWriteFlowDocFiles('delivery-return', (p) => p === '*', page('none'))).toBe(true);
  });

  it('the phone maps exactly the four module keys', () => {
    expect(FLOW_DOC_KIND_BY_MODULE).toEqual({
      grns: 'grn', 'purchase-invoices': 'purchase-invoice', 'delivery-returns': 'delivery-return', 'purchase-returns': 'purchase-return',
    });
  });
});
