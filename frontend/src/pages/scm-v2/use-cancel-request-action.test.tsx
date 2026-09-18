/* The ask-then-raise step behind every "Request cancellation" control (owner
 * 2026-09-08). The words are the decision: nothing is cancelled by the click,
 * the reason is mandatory, and the person is told what happens next. */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.fn(async (_opts: unknown): Promise<string | null> => 'Customer cancelled the order');
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => prompt }));
const notify = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../../vendor/scm/lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notify(o) }));
const mutateAsync = vi.fn(async (_v: unknown) => ({ request: {} }));
vi.mock('../../vendor/scm/lib/document-cancel-queries', () => ({ useRaiseCancelRequest: () => ({ mutateAsync }) }));

const { useCancelRequestAction, cancelRequestPrompt, MIN_CANCEL_REASON } = await import('./use-cancel-request-action');

beforeEach(() => { prompt.mockClear(); notify.mockClear(); mutateAsync.mockClear(); });

describe('useCancelRequestAction', () => {
  it('asks for the reason, raises the request, and says nothing is cancelled yet', async () => {
    const { result } = renderHook(() => useCancelRequestAction('so'));
    expect(await result.current('SO-1', 'SO-1')).toBe(true);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Request cancellation of SO-1?', multiline: true, confirmLabel: 'Request cancellation' }));
    expect(mutateAsync).toHaveBeenCalledWith({ key: 'SO-1', reason: 'Customer cancelled the order' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancellation requested' }));
    expect(String((notify.mock.calls[0]![0] as { body: string }).body)).toContain('not cancelled yet');
  });

  it('does nothing when the prompt is dismissed', async () => {
    prompt.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useCancelRequestAction('po'));
    expect(await result.current('po-1', 'PO-1')).toBe(false);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('tells the person when the server refuses, and answers false', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('A cancellation request is already open on this document.'));
    const { result } = renderHook(() => useCancelRequestAction('so'));
    expect(await result.current('SO-1', 'SO-1')).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', body: 'A cancellation request is already open on this document.' }));
  });

  it('the prompt refuses a reason under the floor, and names the document kind', () => {
    const so = cancelRequestPrompt('so', 'SO-9');
    expect(so.validate('x'.repeat(MIN_CANCEL_REASON - 1))).not.toBeNull();
    expect(so.validate('x'.repeat(MIN_CANCEL_REASON))).toBeNull();
    expect(so.body).toContain('sales order');
    expect(so.body).toContain('Nothing is cancelled yet');
    expect(cancelRequestPrompt('po', 'PO-9').body).toContain('purchase order');
  });
});
