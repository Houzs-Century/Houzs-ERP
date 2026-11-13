import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../types';
import type { AssrAckCase } from './assrConnectAck';

// The gate's whole point: a case with no resolvable DO sends the customer nothing
// (owner 2026-11-11). The DO resolver and Connect send/config are stubbed so the
// test is pure; orderDoNumbers stays real (it reads delivery_order || do_numbers).
vi.mock('./connect', () => ({
  isConnectConfigured: vi.fn(() => true),
  postConnectContact: vi.fn(async () => ({ ok: true as const })),
  buildServiceCaseReceived: vi.fn((phone: string, name: string, soNo: string, assrNo: string) => ({
    phone, name, automation: 'Service Case Received',
    attributes: { full_name: name, ref_1: soNo, assr_no: assrNo },
  })),
}));
vi.mock('./assr', () => ({ attachDeliveryOrders: vi.fn(async () => {}) }));

import { sendServiceCaseReceivedAck, caseHasDeliveryOrder } from './assrConnectAck';
import { postConnectContact, isConnectConfigured } from './connect';
import { attachDeliveryOrders } from './assr';

const env = {} as unknown as Env;
const CASE: AssrAckCase = {
  assrNo: 'ASSR/2609-021', soNo: 'SO-012538', customerName: 'JONG HIN FATT',
  phone: '+60123456789', refNo: 'HC12774', companyCode: 'HOUZS', deliveryOrder: null,
};

/** The resolver writes do_numbers (a DO) or leaves it null. Persistent (not a
 *  one-shot) so an early-return test can't leak a queued impl into a later one. */
function resolverFinds(hasDo: boolean) {
  vi.mocked(attachDeliveryOrders).mockImplementation(async (_e, rows: Record<string, unknown>[]) => {
    for (const r of rows) r.do_numbers = hasDo ? 'DO-010831 · DO-010845' : null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isConnectConfigured).mockReturnValue(true);
});

describe('sendServiceCaseReceivedAck — DO gate (owner 2026-11-11)', () => {
  it('sends when the case resolves a DO (e.g. via the AutoCount mirror by ref_no)', async () => {
    resolverFinds(true);
    await sendServiceCaseReceivedAck(env, { ...CASE });
    expect(postConnectContact).toHaveBeenCalledTimes(1);
  });

  it('sends NOTHING when the case resolves no DO', async () => {
    resolverFinds(false);
    await sendServiceCaseReceivedAck(env, { ...CASE });
    expect(postConnectContact).not.toHaveBeenCalled();
  });

  it('sends nothing without a usable phone, even with a DO', async () => {
    resolverFinds(true);
    await sendServiceCaseReceivedAck(env, { ...CASE, phone: '' });
    expect(postConnectContact).not.toHaveBeenCalled();
  });

  it('sends nothing when Connect is not configured', async () => {
    vi.mocked(isConnectConfigured).mockReturnValueOnce(false);
    resolverFinds(true);
    await sendServiceCaseReceivedAck(env, { ...CASE });
    expect(postConnectContact).not.toHaveBeenCalled();
  });
});

describe('caseHasDeliveryOrder', () => {
  it('is true when the resolver finds a DO, false when none', async () => {
    resolverFinds(true);
    expect(await caseHasDeliveryOrder(env, CASE)).toBe(true);
    resolverFinds(false);
    expect(await caseHasDeliveryOrder(env, CASE)).toBe(false);
  });

  it('is true from a hand-entered delivery_order even if the resolver adds nothing', async () => {
    resolverFinds(false);
    expect(await caseHasDeliveryOrder(env, { ...CASE, deliveryOrder: 'DO-99' })).toBe(true);
  });
});
