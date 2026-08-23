/* Pressing Send must cause the missing ancestors, not wait for them.
 *
 * Owner, 2026-08-23: 「按下去会把缺的上游依序补上再送自己 —— 按 SI 就
 * SO → DO → SI；按 GR 就 PO → GR；按 PI 就 PO → GR → PI」.
 *
 * WHY WAITING IS THE WRONG ANSWER TO A BUTTON. AutoCount builds a conversion
 * only by carrying an earlier document into it, so a child whose parent is not
 * in the book cannot go. Left alone the row WAITS — correct as a background
 * behaviour, useless to a person, because the parent is `failed` at six of six
 * attempts and nothing re-sends it. Measured on production the same day:
 *
 *   HC-DO-2608-003  so_to_do  failed   6 attempts  "…error code: 502"
 *   HC-SI-2608-002  do_to_iv  pending  0 attempts  "waiting: parent has no
 *                                                   AutoCount document yet"
 *
 * The invoice was waiting for a delivery order that would never be re-sent.
 *
 * THE STOP CONDITION IS THE ACCOUNT BOOK'S OWN NUMBER (`linked_ac_docno`), not
 * the outbox. An outbox row says what we TRIED; the linked number says what
 * ARRIVED, and only the second one answers "can the child go now".
 */
import { describe, expect, it } from 'vitest';

import { fakeSb } from './fake-postgrest';
import { ancestorsMissingFromBook, newestOutboxRowFor } from './autocount-cascade';

/* One sales chain: SO -> DO -> SI, wired the way the real tables are. */
const chain = (opts: { soInBook?: string | null; doInBook?: string | null } = {}) => fakeSb({
  mfg_sales_orders: [{ id: 'so-1', doc_no: 'HC-SO-2608-005', linked_ac_docno: opts.soInBook ?? null }],
  mfg_sales_order_items: [{ id: 'soi-1', doc_no: 'HC-SO-2608-005' }],
  delivery_orders: [{ id: 'do-1', do_number: 'HC-DO-2608-003', linked_ac_docno: opts.doInBook ?? null }],
  delivery_order_items: [{ id: 'doi-1', delivery_order_id: 'do-1', so_item_id: 'soi-1' }],
  sales_invoices: [{ id: 'si-1', invoice_number: 'HC-SI-2608-002', linked_ac_docno: null }],
  sales_invoice_items: [{ id: 'sii-1', sales_invoice_id: 'si-1', do_item_id: 'doi-1' }],
  autocount_outbox: [],
});

describe('ancestorsMissingFromBook — the sales chain', () => {
  it('an invoice with NEITHER ancestor in the book returns SO then DO', async () => {
    const got = await ancestorsMissingFromBook(chain(), 'IV', 'si-1');
    expect(got.map((d) => d.docNo)).toEqual(['HC-SO-2608-005', 'HC-DO-2608-003']);
  });

  it('outermost FIRST — the order AutoCount needs them in', async () => {
    const got = await ancestorsMissingFromBook(chain(), 'IV', 'si-1');
    expect(got[0].docType).toBe('SO');
    expect(got[1].docType).toBe('DO');
  });

  it('stops at the first ancestor already in the book', async () => {
    /* The DO is in the book, so the SO must be too — that is how the DO got
       there. Walking past it would re-send a document that already arrived. */
    const got = await ancestorsMissingFromBook(chain({ doInBook: 'DO-99' }), 'IV', 'si-1');
    expect(got).toEqual([]);
  });

  it('returns only the DO when the SO is in the book but the DO is not', async () => {
    const got = await ancestorsMissingFromBook(chain({ soInBook: 'SO-99' }), 'IV', 'si-1');
    expect(got.map((d) => d.docNo)).toEqual(['HC-DO-2608-003']);
  });

  it('a document with no parent has nothing to send first', async () => {
    const got = await ancestorsMissingFromBook(chain(), 'SO', 'so-1');
    expect(got).toEqual([]);
  });

  it('a null document id is not an error', async () => {
    expect(await ancestorsMissingFromBook(chain(), 'IV', null)).toEqual([]);
  });
});

describe('ancestorsMissingFromBook — the purchase chain', () => {
  const purchase = fakeSb({
    purchase_orders: [{ id: 'po-1', po_number: 'HC-PO-2608-004', linked_ac_docno: null }],
    purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1' }],
    grns: [{ id: 'gr-1', grn_number: 'HC-GRN-2608-004', linked_ac_docno: null }],
    grn_items: [{ id: 'gri-1', grn_id: 'gr-1', purchase_order_item_id: 'poi-1' }],
    purchase_invoices: [{ id: 'pi-1', invoice_number: 'HC-PI-2608-004', linked_ac_docno: null }],
    purchase_invoice_items: [{ id: 'pii-1', purchase_invoice_id: 'pi-1', grn_item_id: 'gri-1' }],
  });

  it('a supplier invoice returns PO then GR', async () => {
    const got = await ancestorsMissingFromBook(purchase, 'PI', 'pi-1');
    expect(got.map((d) => d.docType)).toEqual(['PO', 'GR']);
  });

  it('a receipt returns just the PO', async () => {
    const got = await ancestorsMissingFromBook(purchase, 'GR', 'gr-1');
    expect(got.map((d) => d.docNo)).toEqual(['HC-PO-2608-004']);
  });
});

describe('a MERGED conversion has no single chain, and says so', () => {
  it('two parents return nothing rather than the first one', async () => {
    /* Sending one parent and silently leaving the other is worse than sending
       none: the operator would see a success and still have a document the book
       cannot build. */
    const merged = fakeSb({
      delivery_orders: [{ id: 'do-1', do_number: 'DO-1', linked_ac_docno: null }],
      delivery_order_items: [
        { id: 'doi-1', delivery_order_id: 'do-1', so_item_id: 'soi-1' },
        { id: 'doi-2', delivery_order_id: 'do-1', so_item_id: 'soi-2' },
      ],
      mfg_sales_order_items: [{ id: 'soi-1', doc_no: 'SO-A' }, { id: 'soi-2', doc_no: 'SO-B' }],
      mfg_sales_orders: [{ id: 'so-a', doc_no: 'SO-A', linked_ac_docno: null }],
    });
    expect(await ancestorsMissingFromBook(merged, 'DO', 'do-1')).toEqual([]);
  });
});

describe('newestOutboxRowFor', () => {
  const sb = fakeSb({
    autocount_outbox: [
      { id: 'old', company_id: 1, doc_no: 'HC-DO-2608-003', created_at: '2026-08-22T01:00:00Z' },
      { id: 'new', company_id: 1, doc_no: 'HC-DO-2608-003', created_at: '2026-08-23T01:00:00Z' },
      { id: 'other-co', company_id: 2, doc_no: 'HC-DO-2608-003', created_at: '2026-08-24T01:00:00Z' },
    ],
  });

  it('returns the NEWEST row — a document accumulates create, re-queue, edit', async () => {
    expect(await newestOutboxRowFor(sb, 1, 'HC-DO-2608-003')).toBe('new');
  });

  it('never reaches across companies', async () => {
    expect(await newestOutboxRowFor(sb, 1, 'HC-DO-2608-003')).not.toBe('other-co');
  });

  it('a document with no row is null, not an error', async () => {
    expect(await newestOutboxRowFor(sb, 1, 'NOPE-1')).toBeNull();
  });
});
