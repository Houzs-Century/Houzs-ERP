// The composer that turns an ERP document into what AcSyncService accepts, and
// the client's read of what AutoCount answered.
//
// The master maps come from PR #1696, built against the live AED_HOUZS book;
// the payload SHAPE is AcSyncService's (Details[] / Desc2 / UDF{}), which is
// the service that exists and was proven against that book on 2026-08-07.
import { describe, expect, test, vi } from 'vitest';
import {
  composeCreateSo,
  composeCreatePo,
  composeEdit,
  composeDescription2,
  makeItemCodeResolver,
  mapOrPassthrough,
  callAcService,
  acServiceConfig,
  AC_DEBTOR_CODE,
  AGENT_MAP,
  LOCATION_MAP,
  type ErpSoHeader,
  type ErpLine,
} from './autocount-writeback';

const header: ErpSoHeader = {
  doc_no: 'HC-SO-1', so_date: '2026-08-10', debtor_name: 'Tan Ah Kow',
  agent: 'kar jiun', sales_location: 'PETALING JAYA', branding: 'akemi',
  venue: 'KSL CITY MALL', address1: 'A1', address2: 'A2', address3: null, address4: null,
  phone: '0123', ref: 'REF', po_doc_no: 'CUST-PO-7',
};

const line = (over: Partial<ErpLine> = {}): ErpLine => ({
  item_code: 'SKU-1', description: 'Mattress', qty: 2, unit_price_centi: 199_900, ...over,
});

describe('master mapping', () => {
  test('normalises case and spacing before mapping (a salesperson types freely)', () => {
    expect(mapOrPassthrough('kar jiun', AGENT_MAP)).toBe('TAN KAR JIUN');
    expect(mapOrPassthrough('  Mei   Ting ', AGENT_MAP)).toBe('MEI TING');
  });

  test('a value that is already the AutoCount spelling passes through', () => {
    expect(mapOrPassthrough('TAN KAR JIUN', AGENT_MAP)).toBe('TAN KAR JIUN');
    expect(mapOrPassthrough('KL', LOCATION_MAP)).toBe('KL');
  });

  test('an unknown value maps to null rather than being invented', () => {
    expect(mapOrPassthrough('SOMEONE NEW', AGENT_MAP)).toBeNull();
    expect(mapOrPassthrough('', AGENT_MAP)).toBeNull();
    expect(mapOrPassthrough(null, AGENT_MAP)).toBeNull();
  });
});

describe('composeCreateSo', () => {
  const payload = composeCreateSo(header, [line()]);

  test('writes the fixed debtor account with the real customer name over it', () => {
    expect(payload.DebtorCode).toBe(AC_DEBTOR_CODE);
    expect(payload.DebtorName).toBe('Tan Ah Kow');
    expect(payload.Attention).toBe('Tan Ah Kow');
  });

  test('maps agent, location, branding and venue to their AutoCount spellings', () => {
    expect(payload.Agent).toBe('TAN KAR JIUN');
    expect(payload.SalesLocation).toBe('KL');
    expect(payload.UDF).toEqual({
      BRANDING: 'AKEMI',
      VENUE: 'KSL CITY MALL JOHOR SOLO',
      ToPONo: 'CUST-PO-7',
    });
  });

  test('money crosses as a decimal — sen is an ERP convention, not AutoCount"s', () => {
    expect(payload.Details[0].UnitPrice).toBe(1999);
    expect(payload.Details[0].Qty).toBe(2);
  });

  test('a blank UDF is dropped, not sent as an empty option', () => {
    const p = composeCreateSo({ ...header, branding: null, venue: null, po_doc_no: null }, [line()]);
    expect(p.UDF).toEqual({});
  });
});

describe('Description 2 — where a variant goes, because AutoCount has no variant fields', () => {
  test('sofa variants collapse into one blob', () => {
    expect(composeDescription2(line({
      variants: { fabricColor: 'Beige', fabricLabel: 'Linen', seatHeight: '45', legHeight: '10' },
    }))).toBe('Col: Beige / Fabric: Linen / Seat: 45 / Leg: 10');
  });

  test('an explicit description2 wins over the variants', () => {
    expect(composeDescription2(line({ description2: 'KING 6x7', variants: { fabricColor: 'Beige' } })))
      .toBe('KING 6x7');
  });

  test('a line with neither carries no Desc2 rather than an empty string', () => {
    expect(composeDescription2(line())).toBeNull();
  });
});

describe('ItemCode resolution', () => {
  test('a direct binding wins', () => {
    const resolve = makeItemCodeResolver(new Map([['SKU-1', 'AC-CODE-1']]));
    expect(resolve('SKU-1').acItemCode).toBe('AC-CODE-1');
  });

  test('a sofa compartment with no binding of its own collapses to the parent sofa code', () => {
    /* Owner's rule: every compartment of a sofa points at ONE AutoCount code
       and the compartment itself travels in Desc 2. The parent is the SKU up to
       the first hyphen, so ARIA-2SEAT rides on ARIA-3SEAT's binding. */
    const resolve = makeItemCodeResolver(new Map([['ARIA-3SEAT', 'AC-SOFA-ARIA']]));
    expect(resolve('ARIA-3SEAT').acItemCode).toBe('AC-SOFA-ARIA');
    expect(resolve('ARIA-2SEAT').acItemCode).toBe('AC-SOFA-ARIA');
    expect(resolve('ARIA-CHAISE').acItemCode).toBe('AC-SOFA-ARIA');
    // A DIFFERENT model does not borrow it.
    expect(resolve('BONA-2SEAT').acItemCode).toBeNull();
  });

  test('the collapse is sofa-only — a non-sofa binding is never borrowed by a sibling SKU', () => {
    const resolve = makeItemCodeResolver(new Map([['AKEMI-KING', 'AC-MATT-AKEMI']]));
    expect(resolve('AKEMI-QUEEN').acItemCode).toBeNull();
  });

  test('an unbound code resolves to null and the ERP code is sent as-is', () => {
    const resolve = makeItemCodeResolver(new Map());
    expect(resolve('SKU-9').acItemCode).toBeNull();
    expect(composeCreateSo(header, [line({ item_code: 'SKU-9' })], resolve).Details[0].ItemCode).toBe('SKU-9');
  });
});

describe('composeCreatePo', () => {
  test('carries the creditor and the lines', () => {
    const p = composeCreatePo({
      po_number: 'HC-PO-1', po_date: '2026-08-10', creditor_code: '400-H004',
      creditor_name: 'Supplier Sdn Bhd', agent: null, ref: 'R', notes: 'N',
    }, [line({ unit_price_centi: 5000 })]);
    expect(p.DocNo).toBe('HC-PO-1');
    expect(p.CreditorCode).toBe('400-H004');
    expect(p.Description).toBe('N');
    expect(p.Details[0].UnitPrice).toBe(50);
  });
});

describe('composeEdit', () => {
  test('a known line is addressed by its AutoCount DtlKey so the edit updates it', () => {
    // Without the key AcSyncService APPENDS, which is the duplicate-line bug
    // PR #1819 stores linked_ac_dtlkey to prevent.
    const p = composeEdit('SO', 'SO-000021', { Ref: 'R2' }, [
      line({ linked_ac_dtlkey: 991 }),
      line({ item_code: 'SKU-NEW' }),
    ]);
    expect(p.DocType).toBe('SO');
    expect(p.DocNo).toBe('SO-000021');
    expect(p.Header).toEqual({ Ref: 'R2' });
    expect(p.Lines[0].DtlKey).toBe(991);
    expect(p.Lines[1].DtlKey).toBeUndefined();
  });

  test('a non-numeric key is treated as no key rather than sent as garbage', () => {
    const p = composeEdit('SO', 'SO-1', {}, [line({ linked_ac_dtlkey: 'not-a-key' })]);
    expect(p.Lines[0].DtlKey).toBeUndefined();
  });
});

describe('callAcService', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900/', AC_SYNC_KEY: 'secret' } as never;

  test('AC_SYNC_URL is config and its absence is reported, not guessed around', () => {
    expect(acServiceConfig({} as never)).toBeNull();
  });

  test('posts to the route for the operation, with the API key header', async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, docNo: 'SO-000123' }), { status: 200 });
    }) as never;

    const r = await callAcService(env, 'create_so', { DocNo: 'HC-SO-1' }, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.docNo).toBe('SO-000123');
    expect(seen.url).toBe('http://ac.local:8900/create-so');
    expect((seen.init?.headers as Record<string, string>)['X-API-KEY']).toBe('secret');
  });

  test('an unreachable host is retryable — the AutoCount box reboots', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never;
    const r = await callAcService(env, 'cancel', {}, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.retryable).toBe(true);
  });

  test('a 4xx is NOT retryable — a bad payload stays bad', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'DocNo required' }), { status: 400 })) as never;
    const r = await callAcService(env, 'create_so', {}, fetchImpl);
    expect(r.retryable).toBe(false);
    expect(r.error).toBe('DocNo required');
  });

  test("a 500 keeps AutoCount's own words and is retried, because the service turns every exception into one", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: 'AutoCount refused to cancel SO SO-1 (already transferred to a downstream document, or already cancelled)' }),
      { status: 500 },
    )) as never;
    const r = await callAcService(env, 'cancel', {}, fetchImpl);
    expect(r.retryable).toBe(true);
    expect(r.error).toContain('already transferred to a downstream document');
  });

  test('a 200 body that says ok:false is a failure, not a success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'nope' }), { status: 200 })) as never;
    expect((await callAcService(env, 'edit', {}, fetchImpl)).ok).toBe(false);
  });
});
