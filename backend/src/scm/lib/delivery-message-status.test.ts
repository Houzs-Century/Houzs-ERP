/* HC-0164: HC-SO-006432 / 010484 were sent at 17:03 MYT 2026-10-26 and stayed
   on "To Send Delivery Date" - the modal's fire-and-forget status write never
   landed and nothing said so. The status now moves server-side, and an order it
   could not move is named in the answer. */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const advance = vi.fn();
const audit = vi.fn();
vi.mock('./so-generation', () => ({ advanceSoGeneration: (...a: unknown[]) => advance(...a) }));
vi.mock('./so-audit', () => ({ recordSoAudit: (...a: unknown[]) => audit(...a) }));
vi.mock('./companyScope', () => ({ scopeToAllowedCompanies: (q: unknown) => q }));

import { markSentStatus } from './delivery-message-status';

type Row = { doc_no: string; status: string | null; delivery_message_status: string | null };
function ctx(rows: Row[] | null, readError: { message: string } | null = null) {
  const sb = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: rows, error: readError }) }) }) };
  const vars: Record<string, unknown> = { supabase: sb, user: { id: 'u1', user_metadata: { name: 'Syu' } } };
  return { get: (k: string) => vars[k] } as never;
}
const row = (doc_no: string, delivery_message_status: string | null): Row => ({ doc_no, status: 'READY_TO_SHIP', delivery_message_status });

describe('markSentStatus', () => {
  beforeEach(() => { advance.mockReset(); audit.mockReset(); });

  test('moves each sent order to its Done status and records who and why', async () => {
    advance.mockResolvedValue({ applied: true, version: 7, previous: {} });
    const out = await markSentStatus(ctx([row('HC-SO-010484', 'To Send Delivery Date')]), ['HC-SO-010484'], 'Done Send', 'New Delivery Follow-up');
    expect(out).toEqual([]);
    expect(advance).toHaveBeenCalledWith(expect.anything(), 'HC-SO-010484', { delivery_message_status: 'Done Send' });
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      docNo: 'HC-SO-010484', actorName: 'Syu', source: 'delivery-planning',
      fieldChanges: [{ field: 'deliveryMessageStatus', from: 'To Send Delivery Date', to: 'Done Send' }],
    }));
  });

  test('a version race is retried', async () => {
    advance
      .mockResolvedValueOnce({ applied: false, reason: 'conflict', currentVersion: 6 })
      .mockResolvedValueOnce({ applied: true, version: 8, previous: {} });
    const out = await markSentStatus(ctx([row('HC-SO-006432', null)]), ['HC-SO-006432'], 'Done Send', 'New Delivery Follow-up');
    expect(out).toEqual([]);
    expect(advance).toHaveBeenCalledTimes(2);
  });

  test('an open SO editor is not overwritten, and the order is named', async () => {
    advance.mockResolvedValue({ applied: false, reason: 'lease', currentVersion: 6 });
    const out = await markSentStatus(ctx([row('HC-SO-006432', null)]), ['HC-SO-006432'], 'Done Send', 'New Delivery Follow-up');
    expect(out).toEqual([{ docNo: 'HC-SO-006432', reason: 'lease' }]);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  test('an order already on the status is left alone', async () => {
    const out = await markSentStatus(ctx([row('HC-SO-005161', 'Done Send')]), ['HC-SO-005161'], 'Done Send', 'New Delivery Follow-up');
    expect(out).toEqual([]);
    expect(advance).not.toHaveBeenCalled();
  });

  test('a failed read names every order instead of claiming success', async () => {
    const out = await markSentStatus(ctx(null, { message: 'boom' }), ['A', 'B'], 'Done Send', 'New Delivery Follow-up');
    expect(out).toEqual([{ docNo: 'A', reason: 'read_failed' }, { docNo: 'B', reason: 'read_failed' }]);
  });
});
