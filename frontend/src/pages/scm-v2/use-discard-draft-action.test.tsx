/* Discarding a draft Sales Order (owner 2026-07-20, re-raised 2026-10-13:
 * 「这个draft - discard不到」). The words and the outcome are the decision: it
 * is confirmed first, it really deletes, and a server refusal reaches the
 * person word for word instead of vanishing. */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.fn(async (_opts: unknown): Promise<boolean> => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirm }));
const notify = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../../vendor/scm/lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notify(o) }));
const mutateAsync = vi.fn(async (_v: unknown) => ({ ok: true }));
vi.mock('../../vendor/scm/lib/sales-order-queries', () => ({ useDeleteMfgSalesOrder: () => ({ mutateAsync, isPending: false }) }));

const { useDiscardDraftAction, discardDraftPrompt, DISCARD_DRAFT_LABEL } = await import('./use-discard-draft-action');

beforeEach(() => { confirm.mockClear(); notify.mockClear(); mutateAsync.mockClear(); });

describe('useDiscardDraftAction', () => {
  it('confirms, deletes the draft, and says it is gone', async () => {
    const { result } = renderHook(() => useDiscardDraftAction());
    expect(await result.current.discard('HC-SO-2609-386')).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Discard draft HC-SO-2609-386?', confirmLabel: DISCARD_DRAFT_LABEL, danger: true,
    }));
    expect(mutateAsync).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-386' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft discarded' }));
  });

  it('deletes NOTHING when the dialog is dismissed', async () => {
    confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useDiscardDraftAction());
    expect(await result.current.discard('SO-1')).toBe(false);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("hands the server's own refusal to the person, and answers false", async () => {
    mutateAsync.mockRejectedValueOnce(new Error('This order has payments recorded against it.'));
    const { result } = renderHook(() => useDiscardDraftAction());
    expect(await result.current.discard('SO-1')).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'error', body: expect.stringContaining('This order has payments recorded against it.'),
    }));
  });

  it('the prompt says a confirmed order is cancelled, not discarded', () => {
    expect(discardDraftPrompt('SO-9').body).toContain('cancelled, not discarded');
  });
});
