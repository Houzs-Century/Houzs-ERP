import { describe, expect, test } from 'vitest';
import { ReceivedFloorError, withReceivedFloor } from './so-revision';

/* HC-0004: inside runScmPgCommand a refused statement throws (with the SQLSTATE
   kept on it) instead of returning { error }; a P0411 must still come out as the
   ReceivedFloorError the PO amendment routes answer with 409. */
describe('withReceivedFloor', () => {
  const dbRefusal = Object.assign(new Error('po_line_over_received: PO line x would have 7 received against qty 5'), { code: 'P0411' });

  test('a thrown P0411 becomes a ReceivedFloorError with the received qty', async () => {
    const err = await withReceivedFloor(Promise.reject(dbRefusal), 'poi-1', 3).catch((e) => e);
    expect(err).toBeInstanceOf(ReceivedFloorError);
    expect(err.receivedQty).toBe(7);
    expect(err.revisedQty).toBe(3);
  });

  test('any other thrown error passes through untouched', async () => {
    const other = Object.assign(new Error('boom'), { code: '23505' });
    await expect(withReceivedFloor(Promise.reject(other), 'poi-1', 3)).rejects.toBe(other);
  });

  test('a normal result is returned as is', async () => {
    await expect(withReceivedFloor(Promise.resolve({ error: null }), 'poi-1', 3)).resolves.toEqual({ error: null });
  });
});
