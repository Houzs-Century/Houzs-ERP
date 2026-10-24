// ----------------------------------------------------------------------------
// /threepl-do-charges - HC-0031: key in a 3PL's invoice AFTER delivery and tally
// it against the rate card, per delivery order.
//
//   GET  /?from=&to=     rows (one per DO + carrier) with billed, system amount
//                        and variance, plus totals per (carrier, invoice no)
//   PUT  /               { doNumber, threeplCompanyId, invoiceNo, invoiceDate,
//                          billedSen, note } - upsert on (company, DO, carrier)
//   DELETE /:id
//   /from-ap/*           fill the rows from an AP invoice's attached bill
//                        (threepl-from-ap.ts, owner 2026-10-23)
//
// Why per DO, not per trip: prod has 0 trips; 3PL work is not planned in
// Delivery Planning (read-only probe 14 Oct). The pricing is the pure
// lib/threepl-do-charge.ts over the existing cards (delivery-rate-cards.ts),
// read by lib/threepl-charge-load.ts so a bill brought in from an AP invoice
// is tallied against the same Rate card amount this list shows.
//
// company_id is the PAYING company (active). The DO may belong to any company
// the caller is allowed (HOUZS pays a 3PL for 2990 deliveries), which is also
// how the related-company split shows: each row carries the DO's company code.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import {
  scopeToCompanyId, scopeToAllowedCompanies, requireActiveCompanyId, companyCodeMap,
} from '../lib/companyScope';
import { expectedSen, invoiceTotals, varianceSen } from '../lib/threepl-do-charge';
import { loadCarrierCards, loadDoFacts } from '../lib/threepl-charge-load';
import { billSummaries } from '../lib/threepl-bill-import';
import { hasHouzsPerm } from '../lib/houzs-perms';
import {
  assignBillLineHandler, confirmApBillHandler, listApBillsHandler, listBillLinesHandler, readApBillHandler,
} from './threepl-from-ap';

export const threeplDoCharges = new Hono<{ Bindings: Env; Variables: Variables }>();
threeplDoCharges.use('*', supabaseAuth);

threeplDoCharges.get('/from-ap/invoices', listApBillsHandler);
threeplDoCharges.post('/from-ap/:apInvoiceId/read', readApBillHandler);
threeplDoCharges.post('/from-ap/:apInvoiceId/confirm', confirmApBillHandler);
threeplDoCharges.get('/bill-lines', listBillLinesHandler);
threeplDoCharges.patch('/bill-lines/:id', assignBillLineHandler);

type Row = Record<string, unknown>;
// The new table is not in the generated Supabase types until it merges; same
// narrow bridge as delivery-rate-cards.ts rc().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (sb: unknown): any => sb;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

threeplDoCharges.get('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const from = c.req.query('from');
  const to = c.req.query('to');

  const { data: charges, error } = await paginateAll<Row>((lo, hi) => {
    let q = scopeToCompanyId(db(sb).from('threepl_do_charges')
      .select('id, do_id, threepl_company_id, invoice_no, invoice_date, billed_sen, note, ap_invoice_id, created_at'), co.companyId)
      .order('invoice_date', { ascending: false, nullsFirst: false }).range(lo, hi);
    if (from && ISO.test(from)) q = q.gte('invoice_date', from);
    if (to && ISO.test(to)) q = q.lte('invoice_date', to);
    return q;
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = charges ?? [];

  const loaded = await loadCarrierCards(sb, co.companyId);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);
  const { carrierName, specByCarrier } = loaded.cards;

  const doIds = [...new Set(rows.map((r) => String(r.do_id)))];
  const doById = new Map<string, Row>();
  if (doIds.length) {
    const { data, error: e4 } = await scopeToAllowedCompanies(sb.from('delivery_orders')
      .select('id, do_number, do_date, so_doc_no, company_id, debtor_name, status'), c).in('id', doIds);
    if (e4) return c.json({ error: 'load_failed', reason: e4.message }, 500);
    for (const d of (data ?? []) as Row[]) doById.set(String(d.id), d);
  }
  const facts = await loadDoFacts((q) => scopeToAllowedCompanies(q, c), sb, [...doById.values()].map((d) => ({ id: String(d.id), soDocNo: str(d.so_doc_no) })));
  if (!facts.ok) return c.json({ error: 'load_failed', reason: facts.reason }, 500);

  const codes = companyCodeMap(c);
  const out = rows.map((r) => {
    const d = doById.get(String(r.do_id));
    const carrierId = String(r.threepl_company_id);
    const card = specByCarrier.get(carrierId) ?? null;
    const billed = Number(r.billed_sen ?? 0);
    const f = facts.facts.get(String(r.do_id));
    const expected = d && f ? expectedSen(card?.spec ?? null, f) : null;
    return {
      id: String(r.id),
      doId: String(r.do_id),
      doNumber: d ? str(d.do_number) : null,
      doDate: d ? str(d.do_date) : null,
      doStatus: d ? str(d.status) : null,
      customer: d ? str(d.debtor_name) : null,
      doCompanyCode: d ? codes.get(Number(d.company_id)) ?? null : null,
      carrierId,
      carrierName: carrierName.get(carrierId) ?? null,
      cardName: card?.name ?? null,
      invoiceNo: str(r.invoice_no),
      invoiceDate: str(r.invoice_date),
      billedSen: billed,
      expectedSen: expected,
      varianceSen: varianceSen(billed, expected),
      note: str(r.note),
      apInvoiceId: str(r.ap_invoice_id),
    };
  });
  /* The bills read off AP invoices and their parts (DOs / service / fairs / not
     counted / waiting) — Finance's, as the AP invoice is. */
  let bills: unknown[] = [];
  if (hasHouzsPerm(c, 'scm.finance.accounting')) {
    const sum = await billSummaries({ sb, companyId: co.companyId, allowedIds: [co.companyId], usage: null });
    if (!sum.ok) return c.json({ error: 'load_failed', reason: sum.reason }, 500);
    bills = sum.bills;
  }
  return c.json({ rows: out, invoices: invoiceTotals(out).map((t) => ({ ...t, carrierName: carrierName.get(t.carrierId) ?? null })), bills });
});

threeplDoCharges.put('/', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: Row;
  try { body = (await c.req.json()) as Row; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const doNumber = str(body.doNumber)?.trim();
  const carrierId = str(body.threeplCompanyId);
  const billed = Number(body.billedSen);
  const invoiceDate = str(body.invoiceDate);
  if (!doNumber) return c.json({ error: 'do_required' }, 400);
  if (!carrierId) return c.json({ error: 'carrier_required' }, 400);
  if (!Number.isInteger(billed) || billed < 0) return c.json({ error: 'invalid_billed_sen' }, 400);
  if (invoiceDate && !ISO.test(invoiceDate)) return c.json({ error: 'invalid_invoice_date' }, 400);

  // The carrier must be the paying company's own; the DO any company the caller may see.
  const { data: carrier, error: cErr } = await scopeToCompanyId(db(sb).from('threepl_companies').select('id'), co.companyId).eq('id', carrierId).maybeSingle();
  if (cErr) return c.json({ error: 'load_failed', reason: cErr.message }, 500);
  if (!carrier) return c.json({ error: 'carrier_not_found' }, 404);
  const { data: dos, error: doErr } = await scopeToAllowedCompanies(sb.from('delivery_orders').select('id, status'), c).eq('do_number', doNumber);
  if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
  const live = ((dos ?? []) as Row[]).filter((d) => d.status !== 'CANCELLED');
  if (live.length !== 1) return c.json({ error: live.length ? 'do_ambiguous' : 'do_not_found' }, 404);

  const { data, error } = await db(sb).from('threepl_do_charges').upsert({
    company_id: co.companyId,
    do_id: String(live[0]!.id),
    threepl_company_id: carrierId,
    invoice_no: str(body.invoiceNo)?.trim() || null,
    invoice_date: invoiceDate,
    billed_sen: billed,
    note: str(body.note)?.trim() || null,
    created_by: c.get('houzsUser')?.id ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,do_id,threepl_company_id' }).select('id').single();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ id: data?.id }, 201);
});

threeplDoCharges.delete('/:id', async (c) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data, error } = await db(sb).from('threepl_do_charges').delete()
    .eq('id', c.req.param('id')).eq('company_id', co.companyId).select('id');
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!data?.length) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export default threeplDoCharges;
