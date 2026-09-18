// ----------------------------------------------------------------------------
// CLEARING THE PROCESSING DATE TAKES THE ORDER BACK OUT OF PRODUCTION.
//
// Owner, 2026-09-03, looking at HC-SO-013361 with an empty Processing Date and
// an IN_PRODUCTION badge: 「为什么我已经 remove 掉 processing data 了，还在
// production？」
//
// Because only the FORWARD half of his own rule had ever been built. Given
// three options he chose the symmetric one, guarded, and said why in one line:
//
//   「B 其实就看有没有 date 就知道了」
//
// The date is the answer in both directions. The guard is the single case where
// that would be a lie: an order already delivered or invoiced is not "not in
// production", it is FURTHER along, and pulling it back would hide a real
// document from the board the factory works from.
// ----------------------------------------------------------------------------
import { describe, expect, test, vi } from 'vitest';
import {
  PROCEED_FROM_STATUS,
  PROCEED_TO_STATUS,
  statusAfterProcessingDateCleared,
  statusAfterProcessingDateSet,
} from '../shared/so-proceeded-status';
import { soStatusAfterProcessingDateChange } from './so-proceed-status-change';

const cleared = (over: Partial<Parameters<typeof statusAfterProcessingDateCleared>[0]> = {}) =>
  statusAfterProcessingDateCleared({
    currentStatus: PROCEED_TO_STATUS,
    storedProcessingDate: '2026-08-20',
    effectiveProcessingDate: null,
    hasDownstream: false,
    ...over,
  });

describe('the date is the answer, both ways', () => {
  test('clearing it takes a produced order back to confirmed', () => {
    expect(cleared()).toBe(PROCEED_FROM_STATUS);
  });

  /* THE GAP THIS CLOSES, stated as the old behaviour. The forward rule has
     always answered null here, and nothing else was asked — which is exactly
     why the order sat IN_PRODUCTION with no date. */
  test('the forward rule alone still says nothing about a clearing', () => {
    expect(statusAfterProcessingDateSet({
      currentStatus: PROCEED_TO_STATUS,
      storedProcessingDate: '2026-08-20',
      effectiveProcessingDate: null,
    })).toBeNull();
  });
});

describe('what it must never do', () => {
  /* An order already delivered or invoiced is not "not in production" - it is
     further along. Demoting it would hide a real document from the board. */
  test('an order with a delivery order or invoice is left alone', () => {
    expect(cleared({ hasDownstream: true })).toBeNull();
  });

  test('only ever out of the status the forward rule puts it in', () => {
    for (const status of ['READY_TO_SHIP', 'DELIVERED', 'INVOICED', 'CANCELLED', 'DRAFT', PROCEED_FROM_STATUS]) {
      expect(cleared({ currentStatus: status }), `${status} was moved`).toBeNull();
    }
  });

  /* The UN-PROCEED is the TRANSITION, not the absence. An order that never
     carried a date is not un-proceeding every time somebody saves it. */
  test('an order that never had a date is not un-proceeding', () => {
    expect(cleared({ storedProcessingDate: null })).toBeNull();
    expect(cleared({ storedProcessingDate: '   ' })).toBeNull();
  });

  test('a date that is still there moves nothing', () => {
    expect(cleared({ effectiveProcessingDate: '2026-08-21' })).toBeNull();
  });
});

describe('the save asks once, and pays for the downstream read only when it must', () => {
  const sb = (hasDownstream: boolean) => ({
    from: vi.fn(() => {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, is: () => q, not: () => q, neq: () => q,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: hasDownstream ? [{ id: 'x' }] : [], count: hasDownstream ? 1 : 0, error: null }).then(r),
      };
      return q;
    }),
  });

  test('a save that does not clear a date issues NO database read', async () => {
    const client = sb(false);
    const r = await soStatusAfterProcessingDateChange(client, 'HC-SO-1', {
      currentStatus: PROCEED_TO_STATUS,
      storedProcessingDate: '2026-08-20',
      effectiveProcessingDate: '2026-08-20',
    });
    expect(r).toBeNull();
    expect(client.from, 'a plain save paid for a downstream read').not.toHaveBeenCalled();
  });

  test('the forward move still happens, and needs no read either', async () => {
    const client = sb(false);
    const r = await soStatusAfterProcessingDateChange(client, 'HC-SO-1', {
      currentStatus: PROCEED_FROM_STATUS,
      storedProcessingDate: null,
      effectiveProcessingDate: '2026-08-20',
    });
    expect(r).toBe(PROCEED_TO_STATUS);
    expect(client.from).not.toHaveBeenCalled();
  });

  test('a clearing reads downstream and moves the order back', async () => {
    const client = sb(false);
    const r = await soStatusAfterProcessingDateChange(client, 'HC-SO-1', {
      currentStatus: PROCEED_TO_STATUS,
      storedProcessingDate: '2026-08-20',
      effectiveProcessingDate: null,
    });
    expect(r).toBe(PROCEED_FROM_STATUS);
    expect(client.from).toHaveBeenCalled();
  });

  test('a clearing on a shipped order reads downstream and moves nothing', async () => {
    const r = await soStatusAfterProcessingDateChange(sb(true), 'HC-SO-1', {
      currentStatus: PROCEED_TO_STATUS,
      storedProcessingDate: '2026-08-20',
      effectiveProcessingDate: null,
    });
    expect(r).toBeNull();
  });
});
