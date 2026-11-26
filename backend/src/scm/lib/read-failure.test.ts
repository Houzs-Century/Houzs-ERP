import { describe, expect, it, vi } from 'vitest';

import { describeReadError, readFailure, readFailureError } from './read-failure';

describe('describeReadError', () => {
  it('still says something when the driver hands back an EMPTY message', () => {
    const out = describeReadError({ message: '', details: '', hint: '', code: '' });

    expect(out).not.toBe('');
    expect(out).toContain('message=<empty>');
    expect(out).toContain('raw=');
  });

  it('carries the caller context the driver cannot know', () => {
    const out = describeReadError({ message: '' }, { filter: 'so_item_id', in_list_size: 13900 });

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

    expect(err.message.trim()).not.toBe('');
    expect(err.message).not.toContain('Bad Request');
  });
});
