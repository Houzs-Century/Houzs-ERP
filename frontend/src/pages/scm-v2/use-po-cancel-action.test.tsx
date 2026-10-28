/* Cancelling a Purchase Order (owner 2026-09-09:「PO cancelled 不需要审批，只需要
 * remark 原因取消」). The words are the decision: this DOES cancel it, no
 * approval is involved, and the reason is mandatory — so the prompt must not be
 * skippable and the reason must reach the server. */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.fn(async (_opts: unknown): Promise<string | null> => '  Supplier cannot deliver  ');
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => prompt }));
const notify = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../../vendor/scm/lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notify(o) }));
const mutateAsync = vi.fn(async (_v: unknown) => ({ purchaseOrder: {} }));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({ useCancelPurchaseOrder: () => ({ mutateAsync, isPending: false }) }));

const { usePoCancelAction, poCancelPrompt, MIN_PO_CANCEL_REASON } = await import('./use-po-cancel-action');

beforeEach(() => { prompt.mockClear(); notify.mockClear(); mutateAsync.mockClear(); });

describe('usePoCancelAction', () => {
  it('asks why, cancels with the trimmed reason, and says it is done', async () => {
    const { result } = renderHook(() => usePoCancelAction());
    expect(await result.current.cancelPo('po-1', 'PO-1')).toBe(true);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancel PO PO-1?', multiline: true, confirmLabel: 'Cancel PO' }));
    expect(mutateAsync).toHaveBeenCalledWith({ id: 'po-1', reason: 'Supplier cannot deliver' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'PO PO-1 cancelled' }));
  });

  it('cancels NOTHING when the prompt is dismissed — the reason is the gate', async () => {
    prompt.mockResolvedValueOnce(null);
    const { result } = renderHook(() => usePoCancelAction());
    expect(await result.current.cancelPo('po-1', 'PO-1')).toBe(false);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('hands the server\'s own refusal to the person, and answers false', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('A goods receipt exists on this purchase order.'));
    const { result } = renderHook(() => usePoCancelAction());
    expect(await result.current.cancelPo('po-1', 'PO-1')).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', body: 'A goods receipt exists on this purchase order.' }));
  });

  it('the prompt refuses a reason under the floor, and says the cancel is immediate', () => {
    const p = poCancelPrompt('PO-9');
    expect(p.validate('x'.repeat(MIN_PO_CANCEL_REASON - 1))).not.toBeNull();
    expect(p.validate('x'.repeat(MIN_PO_CANCEL_REASON))).toBeNull();
    expect(p.body).toContain('no approval is needed');
    /* The floor is the server's (readReason, 5 chars) — one rule, one number. */
    expect(MIN_PO_CANCEL_REASON).toBe(5);
  });
});
