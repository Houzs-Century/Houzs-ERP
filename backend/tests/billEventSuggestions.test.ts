/* OCR finds the event (owner 2026-09-29/30: ocr 要有办法 detect 相关的 event;
   6a — suggest only). Pinned:
     • the reader's printed event is coerced strictly — an object of nulls is
       no event, dates only as YYYY-MM-DD;
     • the matcher ties a bill to an event by what both sides carry — booth,
       venue, organiser, the days, the brand — names each reason, offers every
       brand row of a shared booth, and offers nothing below the bar or an
       archived row;
     • POST /payment-vouchers/extract returns the suggestions per bill, reads
       the company's own events once, and a bill that prints no event gets none.
   The route runs on the fake PostgREST + a fake env.DB, with fetch stubbed to
   answer as the model would (tests/pvVendorMemory.test.ts's pattern). */

import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { coerceBillJson, coerceEventHint } from '../src/acc/bill-extract';
import { scoreEvent, suggestEvents } from '../src/scm/lib/event-match';
import { toEventRow, type EventRow } from '../src/scm/lib/event-tags';
import { extractBillsHandler } from '../src/scm/routes/pv-extract';

const EVENT_ROWS: Row[] = [
  { id: 348, company_id: 1, code: '2026-09-MLE-PENANG-PWCC-AKEMI', name: 'Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: null, venue: 'PENANG WATERFRONT CONVENTION CENTRE', brand: 'AKEMI', organizer: 'MLE', booth_no: 'F1' },
  { id: 2212, company_id: 1, code: '2026-09-MLE-PENANG-PWCC-ZANOTTI', name: 'PULAU PINANG [ZANOTTI] MLE @ PENANG WATERFRONT CONVENTION CENTRE', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: null, venue: 'PENANG WATERFRONT CONVENTION CENTRE', brand: 'ZANOTTI', organizer: 'MLE', booth_no: 'F1' },
  { id: 336, company_id: 1, code: '2026-09-HOMELOVE-PENANG-SPICE-AKEMI', name: 'Pulau Pinang [AKEMI] HOMELOVE @ SETIA SPICE CONVENTION CENTRE', start_date: '2026-09-04', end_date: '2026-09-06', status: 'confirmed', archived_at: null, venue: 'SETIA SPICE CONVENTION CENTRE', brand: 'AKEMI', organizer: 'HOMELOVE', booth_no: '1129-1132, 1139-1142' },
  { id: 777, company_id: 1, code: 'ARCHIVED', name: 'A withdrawn duplicate', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: '2026-09-01', venue: 'PENANG WATERFRONT CONVENTION CENTRE', brand: 'AKEMI', organizer: 'MLE', booth_no: 'F1' },
  { id: 900, company_id: 2, code: 'OTHER', name: 'Another company at PWCC', start_date: '2026-09-25', end_date: '2026-09-27', status: 'confirmed', archived_at: null, venue: 'PENANG WATERFRONT CONVENTION CENTRE', brand: 'X', organizer: 'MLE', booth_no: 'F1' },
];
const asEventRow = (r: Row): EventRow => toEventRow({
  id: r.id, code: r.code, name: r.name, startdate: r.start_date, enddate: r.end_date, status: r.status,
  archivedat: r.archived_at, venue: r.venue, brand: r.brand, organizer: r.organizer, boothno: r.booth_no,
});
const EVENTS = EVENT_ROWS.filter((r) => r.company_id === 1).map(asEventRow);

describe('the printed event, coerced', () => {
  test('nulls and junk are no event; dates only as YYYY-MM-DD', () => {
    expect(coerceEventHint(null)).toBeNull();
    expect(coerceEventHint({ name: null, venue: '', booth: undefined, dateFrom: 'soon' })).toBeNull();
    expect(coerceEventHint({ name: ' MLE Home Expo ', venue: 'PWCC', booth: 'F1', dateFrom: '2026-09-25', dateTo: '27/09/2026' }))
      .toEqual({ name: 'MLE Home Expo', venue: 'PWCC', booth: 'F1', dateFrom: '2026-09-25', dateTo: null });
    expect(coerceBillJson({ vendorName: 'X', lines: [] }).event).toBeNull();
  });
});

describe('the matcher', () => {
  const hint = { name: 'MLE HOME & LIFESTYLE EXPO', venue: 'Penang Waterfront Convention Centre', booth: 'F1', dateFrom: '2026-09-25', dateTo: '2026-09-27' };

  test('a shared booth offers every brand row at it, each with its reasons; the archived and the other fair do not come', () => {
    const got = suggestEvents({ hint, vendorName: 'MLE EVENTS SDN BHD', lineText: 'Booth rental F1', billDate: '2026-09-01' }, EVENTS);
    expect(got.map((s) => s.id).sort((a, b) => a - b)).toEqual([348, 2212]);
    expect(got[0]!.reasons).toEqual(expect.arrayContaining(['booth F1', 'same days', 'organiser MLE']));
    expect(got[0]!.reasons.some((r) => r.startsWith('venue'))).toBe(true);
  });

  test('the brand printed on the bill lifts its row above the other brand at the same booth', () => {
    const got = suggestEvents({ hint, vendorName: 'MLE EVENTS SDN BHD', lineText: 'Booth F1 — ZANOTTI', billDate: '2026-09-01' }, EVENTS);
    expect(got[0]!.id).toBe(2212);
    expect(got[0]!.reasons).toContain('brand ZANOTTI');
  });

  test('a booth range on the event matches one number printed on the bill', () => {
    const s = scoreEvent({ hint: { name: null, venue: null, booth: 'Lot 1139', dateFrom: null, dateTo: null }, vendorName: null, lineText: '', billDate: null }, EVENTS.find((e) => e.id === 336)!);
    expect(s?.reasons).toContain('booth 1139');
  });

  test('an organiser alone is not enough; nothing tied offers nothing', () => {
    expect(suggestEvents({ hint: { name: null, venue: null, booth: null, dateFrom: null, dateTo: null }, vendorName: 'MLE EVENTS SDN BHD', lineText: '', billDate: '2026-09-01' }, EVENTS)).toEqual([]);
    expect(suggestEvents({ hint: { name: 'Something Else', venue: 'Mid Valley', booth: 'Z9', dateFrom: '2026-12-01', dateTo: null }, vendorName: 'ACME', lineText: '', billDate: null }, EVENTS)).toEqual([]);
  });
});

const anthropicAnswer = (bill: Row) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(bill) }] }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); });

describe('POST /payment-vouchers/extract suggests events', () => {
  test('a bill that prints its event gets suggestions; one that prints none gets none; the events are the company\'s own, read once', async () => {
    const bills = [
      { vendorName: 'MLE EVENTS SDN BHD', documentKind: 'invoice', invoiceNumber: 'MLE-0925', invoiceDate: '2026-09-01', currency: 'MYR', totalRm: 8500, lines: [{ description: 'Booth F1 rental', amountRm: 8500 }], event: { name: 'MLE Home Expo', venue: 'Penang Waterfront Convention Centre', booth: 'F1', dateFrom: '2026-09-25', dateTo: '2026-09-27' } },
      { vendorName: 'TENAGA NASIONAL BERHAD', documentKind: 'bill', invoiceNumber: 'TNB-1', invoiceDate: '2026-09-01', currency: 'MYR', totalRm: 150, lines: [], event: null },
    ];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(bills[call++]!)));
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind(...vals: unknown[]) {
            return {
              async all<T>() {
                const co = /p\.company_id = (\d+)/.exec(sql);
                const [to, from] = vals.map(String);
                const hit = EVENT_ROWS.filter((r) => (!co || r.company_id === Number(co[1])) && r.archived_at == null && r.start_date <= to! && (r.end_date ?? r.start_date) >= from!);
                return { results: hit.map((r) => ({ id: r.id, code: r.code, name: r.name, startdate: r.start_date, enddate: r.end_date, status: r.status, archivedat: r.archived_at, venue: r.venue, brand: r.brand, organizer: r.organizer, boothno: r.booth_no })) as unknown as T[] };
              },
            };
          },
        };
      },
    };
    const sb = fakeSb({ suppliers: [], acc_vendor_memory: [] });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, 1 as never);
      c.set('allowedCompanyIds' as never, [1] as never);
      c.set('houzsUser' as never, { id: 9, name: 'Chew', permissions_set: new Set(['scm.payment_voucher.create']) } as never);
      await next();
    });
    app.post('/extract', extractBillsHandler as never);
    const res = await app.request('/extract', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bills: bills.map(() => ({ files: [{ name: 'a.jpg', mime: 'image/jpeg', dataBase64: 'aGk=' }] })) }),
    }, { ANTHROPIC_API_KEY: 'k', DB: db } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { bills: Array<{ eventSuggestions: Array<{ id: number; reasons: string[] }> }> };
    expect(body.bills[0]!.eventSuggestions.map((s) => s.id).sort((a, b) => a - b)).toEqual([348, 2212]);
    expect(body.bills[1]!.eventSuggestions).toEqual([]);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('p.company_id = 1');
  });
});
