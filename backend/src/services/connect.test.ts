import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDeliveryFollowUp,
  isConnectConfigured,
  postConnectContact,
  CONNECT_DELIVERY_AUTOMATION,
} from './connect';

describe('isConnectConfigured', () => {
  it('needs BOTH url and key', () => {
    expect(isConnectConfigured({ CONNECT_WEBHOOK_URL: 'x', CONNECT_WEBHOOK_KEY: 'y' })).toBe(true);
    expect(isConnectConfigured({ CONNECT_WEBHOOK_URL: 'x' })).toBe(false);
    expect(isConnectConfigured({ CONNECT_WEBHOOK_KEY: 'y' })).toBe(false);
    expect(isConnectConfigured({})).toBe(false);
  });
});

describe('buildDeliveryFollowUp', () => {
  it('single order → ref_1 only, order_total 1, automation by name', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'HC13234', branding: 'AKEMI', deliveryDate: '2026/10/05' },
    ]);
    expect(contact).toEqual({
      phone: '+60123',
      name: 'Wong',
      automation: CONNECT_DELIVERY_AUTOMATION,
      attributes: {
        full_name: 'Wong',
        order_total: '1',
        ref_1: 'HC13234',
        delivery_date_1: '2026/10/05',
        brand_1: 'AKEMI',
      },
    });
  });

  it('bundles multiple orders as 1-indexed ref_N / delivery_date_N / brand_N', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
      { ref: 'B2', branding: 'SLUMBERLAND', deliveryDate: '2026/10/06' },
      { ref: 'C3', branding: 'GOODNITE', deliveryDate: '2026/10/07' },
    ]);
    expect(contact.attributes.order_total).toBe('3');
    expect(contact.attributes.ref_1).toBe('A1');
    expect(contact.attributes.ref_2).toBe('B2');
    expect(contact.attributes.ref_3).toBe('C3');
    expect(contact.attributes.delivery_date_2).toBe('2026/10/06');
    expect(contact.attributes.brand_3).toBe('GOODNITE');
  });
});

describe('postConnectContact', () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { CONNECT_WEBHOOK_URL: 'https://chat.houzscentury.com/', CONNECT_WEBHOOK_KEY: 'secret48' };
  const contact = buildDeliveryFollowUp('+60123', 'Wong', [
    { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
  ]);

  it('posts to /api/webhooks/erp with the X-Connect-Key header, trimming a trailing slash', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await postConnectContact(env, contact);

    expect(r).toEqual({ ok: true, httpCode: 200, error: null });
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://chat.houzscentury.com/api/webhooks/erp');
    expect(call[1].method).toBe('POST');
    expect((call[1].headers as Record<string, string>)['x-connect-key']).toBe('secret48');
  });

  it('a non-2xx response is a failure carrying the body text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const r = await postConnectContact(env, contact);
    expect(r.ok).toBe(false);
    expect(r.httpCode).toBe(401);
    expect(r.error).toContain('unauthorized');
  });

  it('a thrown fetch is a failure, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const r = await postConnectContact(env, contact);
    expect(r).toEqual({ ok: false, httpCode: null, error: 'network down' });
  });
});
