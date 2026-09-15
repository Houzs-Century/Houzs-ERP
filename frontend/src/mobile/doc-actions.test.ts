/* The mobile footer action's reason step (owner 2026-09-09: a PO cancel needs
 * its reason, not an approval). The phone must ask, must send what was typed,
 * and must fire NOTHING when the person backs out — the server refuses a
 * reasonless cancel, so a phone that fired anyway would only collect a 400. */
import { describe, expect, it, vi } from 'vitest';
import { askActionReason, DO_CANCEL_PROMPT, PO_CANCEL_PROMPT, type DocAction } from './doc-actions';

const cancelPo: DocAction = {
  key: 'cancel', label: 'Cancel', variant: 'danger',
  request: { path: '/mfg-purchase-orders/po-1/cancel', method: 'PATCH' },
  reasonPrompt: PO_CANCEL_PROMPT,
};

describe('askActionReason', () => {
  it('sends the trimmed reason in the body', async () => {
    const prompt = vi.fn(async () => '  Supplier cannot deliver  ');
    const fired = await askActionReason(cancelPo, prompt);
    expect(fired?.request.body).toEqual({ reason: 'Supplier cannot deliver' });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Cancel PO', multiline: true }));
  });

  it('fires nothing when the prompt is dismissed', async () => {
    expect(await askActionReason(cancelPo, vi.fn(async () => null))).toBeNull();
  });

  it('merges into an existing body, and asks nothing of an action with no prompt', async () => {
    const withBody: DocAction = { ...cancelPo, request: { ...cancelPo.request, body: { status: 'CANCELLED' } } };
    expect((await askActionReason(withBody, vi.fn(async () => 'Wrong supplier')))?.request.body)
      .toEqual({ status: 'CANCELLED', reason: 'Wrong supplier' });
    const plain: DocAction = { key: 'post', label: 'Post', variant: 'solid', request: { path: '/grns/g-1/post', method: 'PATCH' } };
    const prompt = vi.fn(async () => 'never asked');
    expect(await askActionReason(plain, prompt)).toBe(plain);
    expect(prompt).not.toHaveBeenCalled();
  });

  /* Owner 2026-09-14 — the delivery order's cancel rides its STATUS route, so
     the reason has to arrive BESIDE status CANCELLED, not instead of it. */
  it('a delivery order cancel carries both the status and the reason', async () => {
    const cancelDo: DocAction = {
      key: 'cancel', label: 'Cancel', variant: 'danger',
      request: { path: '/delivery-orders-mfg/do-1/status', method: 'PATCH', body: { status: 'CANCELLED' } },
      reasonPrompt: DO_CANCEL_PROMPT,
    };
    const prompt = vi.fn(async () => ' Customer postponed the delivery ');
    expect((await askActionReason(cancelDo, prompt))?.request.body)
      .toEqual({ status: 'CANCELLED', reason: 'Customer postponed the delivery' });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cancel this delivery order?', confirmLabel: 'Cancel DO' }));
    expect(await askActionReason(cancelDo, vi.fn(async () => null))).toBeNull();
    expect(DO_CANCEL_PROMPT.minChars).toBe(5);
  });

  it('refuses a reason under the floor the server enforces', () => {
    const validate = (v: string) => (v.trim().length < PO_CANCEL_PROMPT.minChars ? 'too short' : null);
    expect(validate('no')).not.toBeNull();
    expect(validate('wrong supplier')).toBeNull();
    /* readReason on the server refuses under 5 too — one rule, one number. */
    expect(PO_CANCEL_PROMPT.minChars).toBe(5);
  });
});
