import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { noWriteUntilMarked, writesFromHere } from '../src/scm/lib/no-write-refusal';

/* 4 · Credit notes and AP invoices now take a per-form Idempotency-Key. Without
   the release, a refused save claimed the key and the corrected Save met
   409 idempotency_key_reused. Every refusal before the first write carries the
   no-write mark (the middleware then deletes the claim); nothing after it does. */
describe('noWriteUntilMarked', () => {
  const app = new Hono();
  app.post('/r', noWriteUntilMarked, async (c) => {
    const q = c.req.query('at');
    if (q === 'refuse') return c.json({ error: 'supplier_required' }, 400);
    writesFromHere(c);
    if (q === 'after') return c.json({ error: 'save_failed' }, 500);
    return c.json({ ok: true }, 201);
  });

  it('a refusal before the first write releases the key', async () => {
    const res = await app.request('/r?at=refuse', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Idempotency-Outcome')).toBe('no-write');
  });

  it('a failure after the first write keeps the key', async () => {
    const res = await app.request('/r?at=after', { method: 'POST' });
    expect(res.headers.get('Idempotency-Outcome')).toBeNull();
  });

  it('a created document keeps the key, so a second press replays it', async () => {
    const res = await app.request('/r', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Outcome')).toBeNull();
  });
});

describe('the money creates use it, with the mark taken back before their first write', () => {
  const src = (f: string) => readFileSync(new URL(`../src/scm/routes/${f}`, import.meta.url), 'utf8');
  it('credit notes', () => {
    const s = src('credit-notes.ts');
    expect(s).toContain("creditNotes.post('/', noWriteUntilMarked, createCreditNoteHandler)");
    const handler = s.slice(s.indexOf('export const createCreditNoteHandler'));
    expect(handler.indexOf('writesFromHere(c)')).toBeGreaterThan(0);
    expect(handler.indexOf('writesFromHere(c)')).toBeLessThan(handler.indexOf('await insertCreditNote('));
  });
  it('AP invoices', () => {
    const s = src('ap-invoices.ts');
    expect(s).toContain("apInvoices.post('/', noWriteUntilMarked, createApInvoiceHandler)");
    const handler = s.slice(s.indexOf('export const createApInvoiceHandler'));
    expect(handler.indexOf('writesFromHere(c)')).toBeGreaterThan(0);
    expect(handler.indexOf('writesFromHere(c)')).toBeLessThan(handler.indexOf('await mintMonthlyDocNo('));
    expect(handler.indexOf('writesFromHere(c)')).toBeLessThan(handler.indexOf(".from('ap_invoices').insert("));
  });
});

/* 5 · The SO edit-lock Override's reason used to be dropped on a same-status
   PATCH that answered `unchanged` and wrote nothing. */
describe('SO status: an override reason reaches the timeline', () => {
  it('the same-status branch writes the reason and says so', () => {
    const s = readFileSync(new URL('../src/scm/routes/mfg-sales-orders.ts', import.meta.url), 'utf8');
    const branch = s.slice(s.indexOf('if (fromNorm === toStatus) {'), s.indexOf('const isConfirm ='));
    expect(branch).toContain("from('mfg_so_status_changes').insert(");
    expect(branch).toContain('Edit-lock override: ${overrideReason}');
    expect(branch).toContain('overrideRecorded: true');
    expect(branch.indexOf('override_not_recorded')).toBeLessThan(branch.indexOf('overrideRecorded: true'));
  });
});
