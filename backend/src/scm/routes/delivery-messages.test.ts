/* THE PER-COMPANY SEND, keyed by the ORDER's company, not the sender's.
 *
 * The bug this guards: delivery-messages resolved the Connect company profile
 * (signature / bank / disposal) by activeCompanyId(c) — the SENDING USER's
 * company — and sent no company_code at all. 2990 shares HOUZS's WhatsApp
 * number, so a 2990 order sent by HOUZS staff told the customer to pay HOUZS's
 * bank account. The fix groups a send by (phone, company) and resolves BOTH the
 * profile and company_code from the ORDER's company. This test drives the whole
 * sender with the sender in HOUZS (company 1) and a 2990 order in the batch, and
 * asserts the 2990 message carries 2990's bank block and company_code '2990'. */
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

/** The subset of the Hono context the sender reads; cast to its param type. */
function ctx(sb: ReturnType<typeof fakeSb>, activeCompanyId: number) {
  const store: Record<string, unknown> = {
    supabase: sb,
    user: { id: 'u1' },
    companyId: activeCompanyId,
    allowedCompanyIds: [1, 2],
    companies: COMPANIES,
  };
  return { get: (k: string) => store[k], env: ENV } as unknown as Parameters<typeof sendDeliveryMessageForDocs>[0];
}

/** Both companies' orders under ONE customer phone. */
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

  /** Capture every contact POSTed to Connect. */
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
    // Sender active company = 1 (HOUZS) — the bug keyed on this.
    const res = await sendDeliveryMessageForDocs(ctx(fakeSb(tables()), 1), ['HC-SO-001', '2990-SO-001'], 'delivery', {});

    // One message per company, never one bundle under the sender's company.
    expect(res.sent).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    expect(posted).toHaveLength(2);

    const houzs = posted.find((p) => p.attributes.company_code === 'HOUZS');
    const h2990 = posted.find((p) => p.attributes.company_code === '2990');
    expect(houzs).toBeDefined();
    expect(h2990).toBeDefined();

    // The 2990 message carries 2990's code, signature and bank — NOT the
    // sender's (company 1) HOUZS account. This is the whole fix.
    expect(h2990!.attributes.company_code).toBe('2990');
    expect(h2990!.attributes.company_signature).toBe("2990's Home");
    expect(h2990!.attributes.bank_block).toBe('2990 bank\nAcc: 222');
    expect(h2990!.attributes.bank_block).not.toContain('HC bank');
    // and it bundles only the 2990 order.
    expect(h2990!.attributes.refs_all).toBe('2990-SO-001');

    // The HOUZS message stays HOUZS.
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
});
