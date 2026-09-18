/* Cancelling a Delivery Order (owner 2026-09-14:「DO cancel need pop out window
 * for reason」). The prompt IS the decision: it must be asked before anything is
 * sent, a dismissed prompt must cancel nothing, the reason must reach the
 * server, and the notice afterwards must not claim the stock came back when the
 * server said it did not. */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.fn(async (_opts: unknown): Promise<string | null> => '  Customer postponed the delivery  ');
vi.mock('../../vendor/scm/components/PromptDialog', () => ({ usePrompt: () => prompt }));
const notify = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../../vendor/scm/lib/dialog-service', () => ({ serviceNotify: (o: unknown) => notify(o) }));
const mutateAsync = vi.fn(async (_v: unknown): Promise<{ deliveryOrder: unknown; movementErrors?: string[] }> => ({ deliveryOrder: {} }));
vi.mock('../../vendor/scm/lib/delivery-order-queries', () => ({ useCancelMfgDeliveryOrder: () => ({ mutateAsync, isPending: false }) }));

const { useDoCancelAction, doCancelPrompt, MIN_DO_CANCEL_REASON } = await import('./use-do-cancel-action');
const { DO_CANCEL_PROMPT } = await import('../../mobile/doc-actions');

beforeEach(() => { prompt.mockClear(); notify.mockClear(); mutateAsync.mockClear(); });

describe('useDoCancelAction', () => {
  it('asks why, cancels with the trimmed reason, and says it is done', async () => {
    const { result } = renderHook(() => useDoCancelAction());
    expect(await result.current.cancelDo('do-1', 'HC-DO-2609-001')).toBe(true);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancel delivery order HC-DO-2609-001?', multiline: true, confirmLabel: 'Cancel DO' }));
    expect(mutateAsync).toHaveBeenCalledWith({ id: 'do-1', reason: 'Customer postponed the delivery' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'HC-DO-2609-001 cancelled' }));
  });

  it('cancels NOTHING when the prompt is dismissed — the reason is the gate', async () => {
    prompt.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useDoCancelAction());
    expect(await result.current.cancelDo('do-1', 'HC-DO-2609-001')).toBe(false);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('hands the server\'s own refusal to the person, and answers false', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit'));
    const { result } = renderHook(() => useDoCancelAction());
    expect(await result.current.cancelDo('do-1', 'HC-DO-2609-001')).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', body: 'DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit' }));
  });

  /* The DO status handler keeps the cancel when returning the stock partly
     fails and says so in `movementErrors` — "its stock is back" would be false. */
  it('says so when the cancel ran but the stock did not all come back', async () => {
    mutateAsync.mockResolvedValueOnce({ deliveryOrder: {}, movementErrors: ['DO reversal threw: timeout'] });
    const { result } = renderHook(() => useDoCancelAction());
    expect(await result.current.cancelDo('do-1', 'HC-DO-2609-001')).toBe(true);
    const shown = notify.mock.calls[0]![0] as { title: string; body: string; tone?: string };
    expect(shown.tone).toBe('error');
    expect(shown.title).toContain('not all returned');
    expect(shown.body).toContain('DO reversal threw: timeout');
    expect(shown.body).not.toContain('stock is back');
  });

  it('the prompt refuses a reason under the floor, and says the cancel is immediate and final', () => {
    const p = doCancelPrompt('HC-DO-2609-009');
    expect(p.validate('x'.repeat(MIN_DO_CANCEL_REASON - 1))).not.toBeNull();
    expect(p.validate('x'.repeat(MIN_DO_CANCEL_REASON))).toBeNull();
    expect(p.body).toContain('no approval is needed');
    expect(p.body).toContain('cannot be reactivated');
    /* The floor is the server's (readReason, 5 chars) — one rule, one number. */
    expect(MIN_DO_CANCEL_REASON).toBe(5);
  });

  it('the phone says the same thing the desktop says', () => {
    const desktop = doCancelPrompt('X').body;
    expect(DO_CANCEL_PROMPT.minChars).toBe(MIN_DO_CANCEL_REASON);
    expect(DO_CANCEL_PROMPT.confirmLabel).toBe(doCancelPrompt('X').confirmLabel);
    for (const clause of ['no approval is needed', 'its stock goes back', 'released to the Sales Order', 'cannot be reactivated', 'kept on its History']) {
      expect(desktop).toContain(clause);
      expect(DO_CANCEL_PROMPT.body).toContain(clause);
    }
  });
});
