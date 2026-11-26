import { describe, it, expect, vi, afterEach } from 'vitest';

import { fakeSb } from '../lib/fake-postgrest';
import { CONNECT_COMPANY_PROFILE_KEY } from '../../services/connect';
import { sendDeliveryMessageForDocs } from './delivery-messages';

const PROFILES = JSON.stringify({
  '1': { signature: 'Houzs Century', bankBlock: 'HC bank\nAcc: 111', disposalBlock: 'HC disposal' },
  '2': { signature: "2990's Home", bankBlock: '2990 bank\nAcc: 222', disposalBlock: '2990 disposal' },
});

const COMPANIES = [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }];

const ENV = {
  PUBLIC_APP_URL: 'https://erp.houzscentury.com',
  CONNECT_WEBHOOK_URL: 'https://chat.houzscentury.com',
  CONNECT_WEBHOOK_KEY: 'k',
};

function ctx(sb: ReturnType<typeof fakeSb>, activeCompanyId: number, houzsUser?: { id: number; email?: string }) {
  const store: Record<string, unknown> = {
    supabase: sb,
    user: { id: 'u1' },
    houzsUser,
    companyId: activeCompanyId,
    allowedCompanyIds: [1, 2],
    companies: COMPANIES,
  };
  return { get: (k: string) => store[k], env: ENV } as unknown as Parameters<typeof sendDeliveryMessageForDocs>[0];
}

function tables() {
  return {
    mfg_sales_orders: [
      { doc_no: 'HC-SO-001', ref: 'HC 11001', debtor_name: 'Wong', phone: '+60123456789', branding: 'AKEMI', company_id: 1, customer_delivery_date: '2026-10-05', amended_delivery_date: null },
      { doc_no: '2990-SO-001', ref: 'HM 22001', debtor_name: 'Wong', phone: '+60123456789', branding: 'AKEMI', company_id: 2, customer_delivery_date: '2026-10-05', amended_delivery_date: null },
    ],
    mfg_sales_orders_with_payment_totals: [
      { doc_no: 'HC-SO-001', balance_sen_live: 0, local_total_sen: 150000 },
      { doc_no: '2990-SO-001', balance_sen_live: 0, local_total_sen: 200000 },
    ],
    app_config: [{ key: CONNECT_COMPANY_PROFILE_KEY, value: PROFILES }],
    wa_message_log: [] as Record<string, unknown>[],
  };
}

describe('sendDeliveryMessageForDocs — company routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(): Array<{ attributes: Record<string, string> }> {
    const posted: Array<{ attributes: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ triggered: ['New Delivery Follow-up'] }), { status: 200 });
    }));
    return posted;
  }

  it('resolves company_code + profile from the ORDER company — a 2990 order sent by HOUZS staff gets 2990s account', async () => {
    const posted = stubFetch();
    const res = await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1), ['HC-SO-001', '2990-SO-001'], 'delivery', {});

    expect(res.sent).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    expect(posted).toHaveLength(2);

    const byCode = new Map(posted.map((p) => [p.attributes.company_code, p]));
    const houzs = byCode.get('HOUZS');
    const h2990 = byCode.get('2990');
    expect(houzs).toBeDefined();
    expect(h2990).toBeDefined();

    expect(h2990!.attributes.company_code).toBe('2990');
    expect(h2990!.attributes.company_signature).toBe("2990's Home");
    expect(h2990!.attributes.bank_block).toBe('2990 bank\nAcc: 222');
    expect(h2990!.attributes.bank_block).not.toContain('HC bank');
    expect(h2990!.attributes.refs_all).toBe('2990-SO-001');

    expect(houzs!.attributes.company_code).toBe('HOUZS');
    expect(houzs!.attributes.bank_block).toBe('HC bank\nAcc: 111');
    expect(houzs!.attributes.refs_all).toBe('HC-SO-001');
  });

  it('is unchanged for a single-company phone — one message, the order company', async () => {
    const posted = stubFetch();
    const res = await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1), ['HC-SO-001'], 'delivery', {});
    expect(res.sent).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.attributes.company_code).toBe('HOUZS');
  });

  // HC-0232: Connect alerts whoever pressed Send when WhatsApp does not deliver.
  it('carries the sender email as sent_by_email, and omits it when unknown', async () => {
    const posted = stubFetch();
    await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1, { id: 7, email: 'syu.houzs@gmail.com' }), ['HC-SO-001'], 'delivery', {});
    await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1), ['HC-SO-001'], 'delivery', {});
    expect(posted[0]!.attributes.sent_by_email).toBe('syu.houzs@gmail.com');
    expect(posted[1]!.attributes).not.toHaveProperty('sent_by_email');
  });

  it('blanks service_job on an SO send so a stale Service Arrangement value cannot mis-route it', async () => {
    const posted = stubFetch();
    await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1), ['HC-SO-001'], 'reminder_1', {});
    expect(posted[0]!.attributes.service_job).toBe('');
  });
});

describe('sendDeliveryMessageForDocs — a send whose log row did not land', () => {
  afterEach(() => vi.unstubAllGlobals());

  function logRefusingSb() {
    const base = fakeSb(tables());
    return {
      ...base,
      from(t: string) {
        const q = base.from(t);
        if (t === 'wa_message_log') {
          (q as { insert: unknown }).insert = () => Promise.resolve({ data: null, error: { message: 'permission denied for table wa_message_log' } });
        }
        return q;
      },
    } as unknown as ReturnType<typeof fakeSb>;
  }

  it('still reports the message as sent, and names it in notLogged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await sendDeliveryMessageForDocs(ctx(logRefusingSb(), 1), ['HC-SO-001'], 'delivery', {});
    warn.mockRestore();
    expect(res.sent).toHaveLength(1);
    expect(res.notLogged).toEqual([
      { phone: '+60123456789', docNos: ['HC-SO-001'], sent: true, reason: 'permission denied for table wa_message_log' },
    ]);
  });

  it('is empty when the log row lands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const res = await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1), ['HC-SO-001'], 'delivery', {});
    expect(res.notLogged).toEqual([]);
  });
});
