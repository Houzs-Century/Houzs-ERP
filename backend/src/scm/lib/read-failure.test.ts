// The regression this file exists for, in one line of production log:
//
//     [onError] Error: delivered-sum read failed:
//
// Nothing after the colon. `wrangler tail` against the live Worker on
// 2026-08-17 is the only reason anyone knows which read that was — the response
// said "Something went wrong. Please try again." and the throw interpolated the
// one field the driver had left EMPTY.
//
// So the property under test is not a wording, it is: A DIAGNOSTIC STRING MAY
// NEVER BE EMPTY, and an operator-facing one may never carry driver text.
import { describe, expect, it, vi } from 'vitest';

import { describeReadError, readFailure, readFailureError } from './read-failure';

describe('describeReadError', () => {
  it('still says something when the driver hands back an EMPTY message', () => {
    // The exact shape production returned: a rejection with no usable text.
    const out = describeReadError({ message: '', details: '', hint: '', code: '' });

    expect(out).not.toBe('');
    expect(out).toContain('message=<empty>');
    // The whole object survives, so nothing is lost to a blank field again.
    expect(out).toContain('raw=');
  });

  it('carries the caller context the driver cannot know', () => {
    const out = describeReadError({ message: '' }, { filter: 'so_item_id', in_list_size: 13900 });

    // The list size is the suspect in the URI-too-long shape; without it the log
    // says a request failed and nothing about why it might have.
    expect(out).toContain('filter=so_item_id');
    expect(out).toContain('in_list_size=13900');
  });

  it('prefers the driver fields when they are populated', () => {
    const out = describeReadError({ message: 'Bad Request', code: 'PGRST100', hint: 'try fewer' });

    expect(out).toContain('message=Bad Request');
    expect(out).toContain('code=PGRST100');
    expect(out).toContain('hint=try fewer');
    expect(out).not.toContain('message=<empty>');
  });

  it('never resolves to nothing, whatever it is handed', () => {
    for (const junk of [null, undefined, '', 0, new Error(''), {}]) {
      expect(describeReadError(junk)).not.toBe('');
    }
  });
});

describe('readFailure — what the operator sees', () => {
  it('answers the sibling-standard load_failed shape with a quotable stage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = readFailure('delivered_sum', { message: '', code: '' }, { in_list_size: 13900 });
    spy.mockRestore();

    expect(body.error).toBe('load_failed');
    expect(body.stage).toBe('delivered_sum');
    expect(body.reason).toContain('delivered_sum');
  });

  it('keeps driver text OUT of the response and IN the log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = readFailure('delivered_sum', {
      message: 'column delivery_order_items.so_item_id does not exist',
      code: '42703',
    });
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    spy.mockRestore();

    expect(body.reason).not.toMatch(/42703|does not exist|delivery_order_items/);
    // The SCM client discards a server message of 200 characters or more.
    expect(body.reason.length).toBeLessThan(200);
    expect(logged).toContain('42703');
    expect(logged).toContain('does not exist');
  });
});

describe('readFailureError — an engine with no `c` to answer with', () => {
  it('carries the same body, so an UNCAUGHT throw still names the step', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = readFailureError('delivered_sum', { message: '' }, { in_list_size: 13900 });
    spy.mockRestore();

    /* index.ts's onError hands an HTTPException's own response straight through,
       which is what makes this reach a caller that never catches (the Sales
       Order list awaits soDeliverableRemaining with no try). */
    expect(typeof err.getResponse).toBe('function');
    const res = err.getResponse();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'load_failed',
      stage: 'delivered_sum',
      reason: expect.stringContaining('delivered_sum'),
    });
  });

  it('has an operator-safe .message, because mrp.ts returns e.message to staff', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = readFailureError('delivered_sum', { message: 'Bad Request', code: '' });
    spy.mockRestore();

    // Not a bare colon, and not the driver's words either.
    expect(err.message.trim()).not.toBe('');
    expect(err.message).not.toContain('Bad Request');
  });
});
