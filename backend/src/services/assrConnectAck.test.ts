import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../types';

// The gate's whole point: a case whose order has no DO sends the customer nothing
// (owner 2026-11-11). Connect send + config are stubbed so the test is pure.
vi.mock('./connect', () => ({
  isConnectConfigured: vi.fn(() => true),
  postConnectContact: vi.fn(async () => ({ ok: true as const })),
  buildServiceCaseReceived: vi.fn((phone: string, name: string, soNo: string, assrNo: string) => ({
    phone, name, automation: 'Service Case Received',
    attributes: { full_name: name, ref_1: soNo, assr_no: assrNo },
  })),
}));

import { sendServiceCaseReceivedAck, caseHasDeliveryOrder } from './assrConnectAck';
import { postConnectContact, isConnectConfigured } from './connect';

/** A fake Env whose DB answers the DO-gate probe with a row (hasDo) or null. */
function fakeEnv(hasDo: boolean): Env {
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => (hasDo ? { has_do: 1 } : null) }) }),
    },
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isConnectConfigured).mockReturnValue(true);
});

describe('sendServiceCaseReceivedAck — DO gate (owner 2026-11-11)', () => {
  it('sends the ack when the order has a DO', async () => {
    await sendServiceCaseReceivedAck(fakeEnv(true), 'ASSR/2610-038', 'HC-SO-013133', 'Wong', '+60123456789');
    expect(postConnectContact).toHaveBeenCalledTimes(1);
  });

  it('sends NOTHING when the order has no DO', async () => {
    await sendServiceCaseReceivedAck(fakeEnv(false), 'ASSR/2610-038', 'HC-SO-013133', 'Wong', '+60123456789');
    expect(postConnectContact).not.toHaveBeenCalled();
  });

  it('sends nothing without a usable phone, even with a DO', async () => {
    await sendServiceCaseReceivedAck(fakeEnv(true), 'ASSR/2610-038', 'HC-SO-013133', 'Wong', '');
    expect(postConnectContact).not.toHaveBeenCalled();
  });

  it('sends nothing when Connect is not configured', async () => {
    vi.mocked(isConnectConfigured).mockReturnValueOnce(false);
    await sendServiceCaseReceivedAck(fakeEnv(true), 'ASSR/2610-038', 'HC-SO-013133', 'Wong', '+60123456789');
    expect(postConnectContact).not.toHaveBeenCalled();
  });
});

describe('caseHasDeliveryOrder', () => {
  it('is false for a blank doc_no and never queries', async () => {
    expect(await caseHasDeliveryOrder(fakeEnv(true), null)).toBe(false);
    expect(await caseHasDeliveryOrder(fakeEnv(true), '   ')).toBe(false);
  });

  it('is true when a delivery order exists, false when none', async () => {
    expect(await caseHasDeliveryOrder(fakeEnv(true), 'HC-SO-1')).toBe(true);
    expect(await caseHasDeliveryOrder(fakeEnv(false), 'HC-SO-1')).toBe(false);
  });
});
