import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDeliveryFollowUp,
  isConnectConfigured,
  postConnectContact,
  parseConnectCompanyProfiles,
  CONNECT_DELIVERY_AUTOMATION,
  CONNECT_RESET_ATTRIBUTES,
  chatCallbackUrl,
  connectUntriggeredReason,
  formatRm,
  type ConnectCompanyProfile,
} from './connect';

const CTX = { callbackUrl: 'https://erp.houzscentury.com/api/chat-callback' };

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
    ], null, CTX);
    expect(contact).toEqual({
      phone: '+60123',
      name: 'Wong',
      automation: CONNECT_DELIVERY_AUTOMATION,
      attributes: {
        full_name: 'Wong',
        order_total: '1',
        button_status: '',
        last_button: '',
        amount: '',
        amended_delivery_date: '',
        amend_date_reason: '',
        date_amended: '',
        ref_1: 'HC13234',
        delivery_date_1: '2026/10/05',
        brand_1: 'AKEMI',
        callback_url: 'https://erp.houzscentury.com/api/chat-callback',
      },
    });
  });

  it('resets every attribute the flows read before they write, on every send', () => {
    // Connect MERGES attributes over the contact's existing ones: without the
    // reset the previous order's Confirm would lock this order's Amend tap and
    // a settled balance would print again.
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
    ], null, CTX);
    for (const key of CONNECT_RESET_ATTRIBUTES) expect(contact.attributes[key]).toBe('');
    expect(CONNECT_RESET_ATTRIBUTES).toContain('button_status');
    expect(CONNECT_RESET_ATTRIBUTES).toContain('amount');
  });

  it('amount = the owed sum over EVERY bundled order, formatted RM, only when > 0', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05', balanceSen: 150000 },
      { ref: 'B2', branding: 'SLUMBERLAND', deliveryDate: '2026/10/06', balanceSen: -5000 }, // over-paid: ignored
      { ref: 'C3', branding: 'GOODNITE', deliveryDate: '2026/10/07', balanceSen: null },
      { ref: 'D4', branding: 'VONO', deliveryDate: '2026/10/08', balanceSen: 2550 }, // 4th order still counts
    ], null, CTX);
    expect(contact.attributes.amount).toBe('1,525.50');
  });

  it('nothing owed → amount is the empty reset, so has_balance stays quiet', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05', balanceSen: 0 },
      { ref: 'B2', branding: 'AKEMI', deliveryDate: '2026/10/05', balanceSen: -100 },
    ], null, CTX);
    expect(contact.attributes.amount).toBe('');
  });

  it('a kind picks its automation by name and merges its extra variables last', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
    ], null, { ...CTX, automation: 'Driver Info', extra: { drivers_name: 'Ali', car_plate: 'WXY 1234' } });
    expect(contact.automation).toBe('Driver Info');
    expect(contact.attributes.drivers_name).toBe('Ali');
    expect(contact.attributes.car_plate).toBe('WXY 1234');
    expect(contact.attributes.ref_1).toBe('A1');
  });

  it('resetConversation:false leaves the conversation state alone (a reminder must not unlock Delivery Lock)', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05', balanceSen: 1000 },
    ], null, { ...CTX, automation: 'Balance Reminder', resetConversation: false });
    expect(contact.attributes.button_status).toBeUndefined();
    expect(contact.attributes.last_button).toBeUndefined();
    expect(contact.attributes.amount).toBe('10.00');
  });

  it('callback_url is the send context, verbatim', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
    ], null, { callbackUrl: 'https://houzs-erp-staging.pages.dev/api/chat-callback' });
    expect(contact.attributes.callback_url).toBe('https://houzs-erp-staging.pages.dev/api/chat-callback');
  });

  it('bundles multiple orders as 1-indexed ref_N / delivery_date_N / brand_N', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
      { ref: 'B2', branding: 'SLUMBERLAND', deliveryDate: '2026/10/06' },
      { ref: 'C3', branding: 'GOODNITE', deliveryDate: '2026/10/07' },
    ], null, CTX);
    expect(contact.attributes.order_total).toBe('3');
    expect(contact.attributes.ref_1).toBe('A1');
    expect(contact.attributes.ref_2).toBe('B2');
    expect(contact.attributes.ref_3).toBe('C3');
    expect(contact.attributes.delivery_date_2).toBe('2026/10/06');
    expect(contact.attributes.brand_3).toBe('GOODNITE');
  });

  it('4+ orders → shows the first 3 lines but order_total carries the TRUE count', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
      { ref: 'B2', branding: 'SLUMBERLAND', deliveryDate: '2026/10/06' },
      { ref: 'C3', branding: 'GOODNITE', deliveryDate: '2026/10/07' },
      { ref: 'D4', branding: 'VONO', deliveryDate: '2026/10/08' },
      { ref: 'E5', branding: 'DREAMLAND', deliveryDate: '2026/10/09' },
    ], null, CTX);
    expect(contact.attributes.order_total).toBe('5');
    expect(contact.attributes.ref_1).toBe('A1');
    expect(contact.attributes.ref_3).toBe('C3');
    expect(contact.attributes.brand_3).toBe('GOODNITE');
    expect(contact.attributes.ref_4).toBeUndefined();
    expect(contact.attributes.delivery_date_4).toBeUndefined();
    expect(contact.attributes.brand_4).toBeUndefined();
  });

  it('a company profile adds company_signature / bank_block / disposal_block', () => {
    const profile: ConnectCompanyProfile = {
      signature: '2990s Home',
      bankBlock: 'Bank: Test\nAcc: 000',
      disposalBlock: 'Disposal: sample',
    };
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
    ], profile, CTX);
    expect(contact.attributes.company_signature).toBe('2990s Home');
    expect(contact.attributes.bank_block).toBe('Bank: Test\nAcc: 000');
    expect(contact.attributes.disposal_block).toBe('Disposal: sample');
  });

  it('a null profile adds no per-company attributes', () => {
    const contact = buildDeliveryFollowUp('+60123', 'Wong', [
      { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
    ], null, CTX);
    expect(contact.attributes.company_signature).toBeUndefined();
    expect(contact.attributes.bank_block).toBeUndefined();
    expect(contact.attributes.disposal_block).toBeUndefined();
  });
});

describe('chatCallbackUrl / formatRm', () => {
  it('builds the callback URL off PUBLIC_APP_URL, trimming a trailing slash, prod as last resort', () => {
    expect(chatCallbackUrl({ PUBLIC_APP_URL: 'https://houzs-erp-staging.pages.dev/' }))
      .toBe('https://houzs-erp-staging.pages.dev/api/chat-callback');
    expect(chatCallbackUrl({})).toBe('https://erp.houzscentury.com/api/chat-callback');
  });

  it('formats sen as the RM figure the message prints', () => {
    expect(formatRm(150000)).toBe('1,500.00');
    expect(formatRm(2550)).toBe('25.50');
    expect(formatRm(123456789)).toBe('1,234,567.89');
  });
});

describe('parseConnectCompanyProfiles', () => {
  it('parses a company_id -> profile map', () => {
    const raw = JSON.stringify({
      '1': { signature: 'Houzs Century', bankBlock: 'B1', disposalBlock: 'D1' },
      '2': { signature: '2990s Home', bankBlock: 'B2', disposalBlock: 'D2' },
    });
    const m = parseConnectCompanyProfiles(raw);
    expect(m['1'].signature).toBe('Houzs Century');
    expect(m['2'].bankBlock).toBe('B2');
    expect(m['2'].disposalBlock).toBe('D2');
  });

  it('returns {} for null, empty or bad JSON', () => {
    expect(parseConnectCompanyProfiles(null)).toEqual({});
    expect(parseConnectCompanyProfiles('')).toEqual({});
    expect(parseConnectCompanyProfiles('{not json')).toEqual({});
    expect(parseConnectCompanyProfiles('[]')).toEqual({});
  });

  it('drops a row with no usable fields and coerces missing fields to empty strings', () => {
    const raw = JSON.stringify({
      '1': { signature: 'Houzs Century' },
      '2': {},
      '3': 'nope',
    });
    const m = parseConnectCompanyProfiles(raw);
    expect(m['1']).toEqual({ signature: 'Houzs Century', bankBlock: '', disposalBlock: '' });
    expect(m['2']).toBeUndefined();
    expect(m['3']).toBeUndefined();
  });
});

describe('postConnectContact', () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { CONNECT_WEBHOOK_URL: 'https://chat.houzscentury.com/', CONNECT_WEBHOOK_KEY: 'secret48' };
  const contact = buildDeliveryFollowUp('+60123', 'Wong', [
    { ref: 'A1', branding: 'AKEMI', deliveryDate: '2026/10/05' },
  ], null, CTX);

  it('posts to /api/webhooks/erp with the X-Connect-Key header, trimming a trailing slash', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await postConnectContact(env, contact);

    expect(r).toEqual({ ok: true, httpCode: 200, error: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://chat.houzscentury.com/api/webhooks/erp');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-connect-key']).toBe('secret48');
  });

  it('a 200 whose `triggered` list is empty is a FAILURE naming the automation (nothing was sent)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, contactId: 'c1', triggered: [], runs: [] }), { status: 200 })));
    const r = await postConnectContact(env, { ...contact, automation: 'Balance Reminder' });
    expect(r.ok).toBe(false);
    expect(r.httpCode).toBe(200);
    expect(r.error).toContain('Balance Reminder');
    expect(r.error).toContain('enable');
  });

  it('a 200 that triggered a run is a success; a body without `triggered` is trusted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, triggered: ['New Delivery Follow-up'] }), { status: 200 })));
    expect((await postConnectContact(env, contact)).ok).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    expect((await postConnectContact(env, contact)).ok).toBe(true);
    expect(connectUntriggeredReason('not json', 'X')).toBeNull();
    expect(connectUntriggeredReason('{"triggered":[]}', 'Driver Info')).toContain('Driver Info');
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
