/* GET /purchase-invoices/outstanding-grn-items — the Bill a Goods-Received Note
 * picker must offer EVERY note that still has something to bill.
 *
 * The handler took the newest 500 POSTED, not-held notes by received_at and
 * only then kept the lines with accepted - invoiced - returned > 0, so past 500
 * posted notes an older unbilled one was absent from the picker and from its
 * search, with nothing on the screen to say so. Its line read was one unpaged
 * `.in('grn_id', <ids>)`, which PostgREST's row ceiling cuts short in silence.
 *
 * Drives the REAL router over lib/fake-postgrest.ts with its `maxRows` ceiling
 * ON (1000, the number this tree assumes; docs/bugs/0447). A fake without the
 * ceiling would make an unpaged read look complete here while it is short in
 * production.
 *
 * THE CONTROLS ARE PART OF THE TEST. `oldRead` replays the pre-change query
 * shape against the SAME fixture and asserts it loses the notes / lines the new
 * read returns — without it, "the read found everything" passes just as happily
 * against a fixture the old code also handled. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';
import routerSrc from './purchase-invoices.ts?raw';

const MAX_ROWS = 1000;

const state = vi.hoisted(() => ({ sb: null as unknown }));
/* supabaseAuth replaces whatever the caller set with the service client, so the
   fake is injected at that seam (same harness as purchaseInvoiceZeroPriceCreate). */
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => state.sb }));

const CALLER = {
  id: 7, email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { purchaseInvoices } = await import('./purchase-invoices');

type Item = { grnItemId: string; grnId: string; grnDocNo: string; receivedAt: string; remaining: number; supplierCode: string; poDocNo: string | null; currency: string; exchangeRate: number };

const HOUZS = { id: 1, code: 'HOUZS' };
const CO_2990 = { id: 2, code: '2990' };

async function getPicker(sb: ReturnType<typeof fakeSb>, company = HOUZS) {
  state.sb = sb;
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', company.id);
    c.set('companyCode', company.code);
    await next();
  });
  app.route('/', purchaseInvoices);
  const res = await app.request('/outstanding-grn-items');
  return { status: res.status, body: (await res.json()) as { items?: Item[]; truncated?: boolean; error?: string } };
}

/* uuid-shaped, so the id batches are sized the way production sizes them. */
const uuid = (space: number, n: number) =>
  `${space.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const day = (offset: number) => new Date(Date.UTC(2025, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

type NoteSpec = {
  n: number; company?: number; received: string; status?: string; onHold?: boolean;
  lines: Array<{ accepted: number; invoiced?: number | null; returned?: number | null; company?: number; createdAt?: string }>;
};

/* Builds grns + grn_items AND scm.v_grn_outstanding, with the view computed by
   mig 0267's own definition so the fixture cannot disagree with it. */
function tables(notes: NoteSpec[]) {
  const grns: Row[] = [];
  const grn_items: Row[] = [];
  const view: Row[] = [];
  for (const note of notes) {
    const id = uuid(0xa, note.n);
    const company = note.company ?? 1;
    const status = note.status ?? 'POSTED';
    grns.push({
      id, grn_number: `GRN-${String(note.n).padStart(5, '0')}`, received_at: note.received,
      supplier_id: `sup-${company}`, purchase_order_id: `po-${note.n}`, currency: 'MYR', exchange_rate: 1,
      status, on_hold: note.onHold ?? false, company_id: company,
      supplier: { code: `400-S${company}`, name: `Supplier ${company}` },
      purchase_order: { po_number: `PO-${note.n}` },
    });
    let unbilled = false;
    note.lines.forEach((l, i) => {
      const row = {
        id: uuid(0xb, note.n * 10 + i), grn_id: id, company_id: l.company ?? company,
        material_kind: 'mfg_product', item_code: `ITEM-${note.n}-${i}`, material_name: `Item ${note.n}-${i}`,
        item_group: 'mattress', description: null, qty_accepted: l.accepted, qty_rejected: 0,
        invoiced_qty: l.invoiced === undefined ? 0 : l.invoiced, returned_qty: l.returned === undefined ? 0 : l.returned,
        unit_price_sen: 1000, variants: null, created_at: l.createdAt ?? `${note.received}T00:00:0${i}Z`,
      };
      grn_items.push(row);
      if ((row.qty_accepted ?? 0) - (row.invoiced_qty ?? 0) - (row.returned_qty ?? 0) > 0) unbilled = true;
    });
    view.push({
      id, grn_number: `GRN-${note.n}`, supplier_id: `sup-${company}`, received_at: note.received, status,
      is_outstanding: status !== 'CANCELLED' && unbilled, company_id: company,
    });
  }
  return { grns, grn_items, v_grn_outstanding: view, fabric_trackings: [] as Row[] };
}

/* The handler as it was, replayed through the same fake. */
async function oldRead(sb: ReturnType<typeof fakeSb>, companyId = 1) {
  const { data: headers } = await sb.from('grns').select('*').eq('company_id', companyId)
    .eq('status', 'POSTED').eq('on_hold', false)
    .order('received_at', { ascending: false }).limit(500);
  const ids = (headers as Row[]).map((h) => h.id as string);
  const { data: items } = await sb.from('grn_items').select('*').in('grn_id', ids);
  return (items as Row[]).filter((r) => (r.qty_accepted ?? 0) - (r.invoiced_qty ?? 0) - (r.returned_qty ?? 0) > 0);
}

describe('GET /purchase-invoices/outstanding-grn-items', () => {
  it('offers an older unbilled note that 600 newer, fully billed notes used to push out', async () => {
    const notes: NoteSpec[] = [];
    // 620 posted notes, one a day. The 600 newest are fully billed; the 20 oldest are not.
    for (let k = 0; k < 620; k++) {
      notes.push({ n: k, received: day(k), lines: [{ accepted: 3, invoiced: k >= 20 ? 3 : 1 }] });
    }
    // Another company's unbilled notes must never appear.
    for (let k = 0; k < 5; k++) notes.push({ n: 5000 + k, company: 2, received: day(700 + k), lines: [{ accepted: 2 }] });
    const sb = fakeSb(tables(notes), {}, [], [], MAX_ROWS);

    const control = await oldRead(sb);
    expect(control).toHaveLength(0); // the old read saw 500 billed notes and nothing to offer

    const { status, body } = await getPicker(sb);
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(20);
    expect(new Set(body.items!.map((i) => i.grnDocNo))).toEqual(
      new Set(Array.from({ length: 20 }, (_, k) => `GRN-${String(k).padStart(5, '0')}`)),
    );
    expect(body.items!.every((i) => i.remaining === 2)).toBe(true);
    expect(body.items![0]).toMatchObject({ supplierCode: '400-S1', poDocNo: 'PO-19', currency: 'MYR', exchangeRate: 1 });
  });

  it('returns every unbilled line when the notes carry more lines than one response can hold', async () => {
    const notes: NoteSpec[] = [];
    for (let k = 0; k < 300; k++) {
      notes.push({ n: k, received: day(k), lines: [1, 2, 3, 4].map(() => ({ accepted: 1 })) });
    }
    const sb = fakeSb(tables(notes), {}, [], [], MAX_ROWS);

    const control = await oldRead(sb);
    expect(control).toHaveLength(MAX_ROWS); // 1,200 lines asked for, 1,000 came back, no error

    const { status, body } = await getPicker(sb);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1200);
    expect(new Set(body.items!.map((i) => i.grnItemId)).size).toBe(1200);
  });

  it('offers only POSTED, not-held notes of this company, and only lines this company owns', async () => {
    const sb = fakeSb(tables([
      { n: 1, received: day(1), lines: [{ accepted: 2 }] },
      { n: 2, received: day(2), onHold: true, lines: [{ accepted: 2 }] },            // held: the view still says outstanding
      { n: 3, received: day(3), status: 'DRAFT', lines: [{ accepted: 2 }] },
      { n: 4, received: day(4), status: 'CANCELLED', lines: [{ accepted: 2 }] },
      { n: 5, received: day(5), lines: [{ accepted: 2 }, { accepted: 2, company: 2 }] }, // a line stamped with the other company
      { n: 6, received: day(6), company: 2, lines: [{ accepted: 2 }] },
      { n: 7, received: day(7), lines: [{ accepted: 2, invoiced: 1, returned: 1 }] },  // returned counts as consumed
      { n: 8, received: day(8), lines: [{ accepted: 2, invoiced: null, returned: null }] }, // NULL tallies read as zero
    ]), {}, [], [], MAX_ROWS);

    const { body } = await getPicker(sb);
    expect(body.items!.map((i) => i.grnDocNo)).toEqual(['GRN-00008', 'GRN-00005', 'GRN-00001']);
    expect(body.items!.filter((i) => i.grnDocNo === 'GRN-00005')).toHaveLength(1);

    const other = await getPicker(sb, CO_2990);
    expect(other.body.items!.map((i) => i.grnDocNo)).toEqual(['GRN-00006']);
  });

  it('lists the newest note first, and a note\'s lines in the order they were entered', async () => {
    const sb = fakeSb(tables([
      { n: 1, received: day(10), lines: [{ accepted: 1, createdAt: '2025-01-11T09:00:00Z' }, { accepted: 1, createdAt: '2025-01-11T08:00:00Z' }] },
      { n: 2, received: day(12), lines: [{ accepted: 1 }] },
      { n: 3, received: day(10), lines: [{ accepted: 1 }] },
    ]), {}, [], [], MAX_ROWS);

    const { body } = await getPicker(sb);
    expect(body.items!.map((i) => i.grnDocNo)).toEqual(['GRN-00002', 'GRN-00003', 'GRN-00001', 'GRN-00001']);
    const n1 = body.items!.filter((i) => i.grnDocNo === 'GRN-00001').map((i) => i.grnItemId);
    expect(n1).toEqual([uuid(0xb, 11), uuid(0xb, 10)]);
  });

  /* A failed read must never come back as "nothing to bill". Each of the three
     reads is broken in turn by asking it for a column the table does not have,
     which the fake fails with 42703 and a null body, as PostgREST does. */
  it.each([
    ['the outstanding-note read', { v_grn_outstanding: ['id'] }],
    ['the note header read', { grns: ['currency'] }],
    ['the line read', { grn_items: ['returned_qty'] }],
  ])('answers 500 when %s fails, never an empty list', async (_label, missing) => {
    const sb = fakeSb(tables([{ n: 1, received: day(1), lines: [{ accepted: 2 }] }]), missing, [], [], MAX_ROWS);
    const { status, body } = await getPicker(sb);
    expect(status).toBe(500);
    expect(body.error).toBe('load_failed');
    expect(body.items).toBeUndefined();
  });

  it('says so when the outstanding-note read stops at its ceiling', async () => {
    const view: Row[] = Array.from({ length: 20_001 }, (_, k) => ({
      id: uuid(0xc, k), status: 'POSTED', is_outstanding: true, company_id: 1, received_at: day(0),
    }));
    const sb = fakeSb({ grns: [], grn_items: [], v_grn_outstanding: view }, {}, [], [], MAX_ROWS);
    const { status, body } = await getPicker(sb);
    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
  }, 30_000);

  it('the route delegates to the paged reader and no longer caps the note read', () => {
    const start = routerSrc.indexOf("purchaseInvoices.get('/outstanding-grn-items'");
    const end = routerSrc.indexOf("purchaseInvoices.get('/:id'", start);
    expect(start).toBeGreaterThan(-1);
    const handler = routerSrc.slice(start, end);
    expect(handler).toContain('loadOutstandingGrnLines');
    expect(handler).toContain('scopeToCompany');
    expect(handler).not.toMatch(/\.limit\(/);
    expect(handler).not.toMatch(/from\('grns'\)/);
  });
});
