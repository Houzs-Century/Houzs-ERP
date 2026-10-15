// ----------------------------------------------------------------------------
// /threepl-do-charges - HC-0031: key in a 3PL's invoice AFTER delivery and tally
// it against the rate card, per delivery order.
//
//   GET  /?from=&to=     rows (one per DO + carrier) with billed, system amount
//                        and variance, plus totals per (carrier, invoice no)
//   PUT  /               { doNumber, threeplCompanyId, invoiceNo, invoiceDate,
//                          billedSen, note } - upsert on (company, DO, carrier)
//   DELETE /:id
//
// Why per DO, not per trip: prod has 0 trips; 3PL work is not planned in
// Delivery Planning (read-only probe 14 Oct). The pricing is the pure
// lib/threepl-do-charge.ts over the existing cards (delivery-rate-cards.ts).
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
import { DEFAULT_ZONE_PREFIX_MAP, zoneForAddress } from '../lib/zone-classify';
import type { SetLine } from '../lib/set-count';
import { doFacts, expectedSen, invoiceTotals, varianceSen } from '../lib/threepl-do-charge';
import { cardOut, ruleOut, toCardSpec } from './delivery-rate-cards';

export const threeplDoCharges = new Hono<{ Bindings: Env; Variables: Variables }>();
threeplDoCharges.use('*', supabaseAuth);

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
      .select('id, do_id, threepl_company_id, invoice_no, invoice_date, billed_sen, note, created_at'), co.companyId)
      .order('invoice_date', { ascending: false, nullsFirst: false }).range(lo, hi);
    if (from && ISO.test(from)) q = q.gte('invoice_date', from);
    if (to && ISO.test(to)) q = q.lte('invoice_date', to);
    return q;
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = charges ?? [];

  const [{ data: carriers, error: e1 }, { data: cardRows, error: e2 }] = await Promise.all([
    scopeToCompanyId(db(sb).from('threepl_companies').select('id, name'), co.companyId),
    scopeToCompanyId(db(sb).from('delivery_rate_cards').select('*'), co.companyId).eq('is_active', true),
  ]);
  if (e1 || e2) return c.json({ error: 'load_failed', reason: (e1 ?? e2).message }, 500);
  const carrierName = new Map<string, string>(((carriers ?? []) as Row[]).map((r) => [String(r.id), String(r.name ?? '')]));
  const cards = ((cardRows ?? []) as Row[]).map(cardOut).filter((cd) => cd.carrierCompanyId);
  const { data: ruleRows, error: e3 } = cards.length
    ? await scopeToCompanyId(db(sb).from('delivery_rate_rules').select('*'), co.companyId).in('card_id', cards.map((x) => x.id))
    : { data: [] as Row[], error: null };
  if (e3) return c.json({ error: 'load_failed', reason: e3.message }, 500);
  const rules = ((ruleRows ?? []) as Row[]).map(ruleOut);
  const specByCarrier = new Map(cards.map((cd) => [cd.carrierCompanyId as string, { name: cd.name, spec: toCardSpec(cd, rules.filter((r) => r.cardId === cd.id)) }]));

  const doIds = [...new Set(rows.map((r) => String(r.do_id)))];
  const doById = new Map<string, Row>();
  if (doIds.length) {
    const { data, error: e4 } = await scopeToAllowedCompanies(sb.from('delivery_orders')
      .select('id, do_number, do_date, so_doc_no, company_id, debtor_name, status'), c).in('id', doIds);
    if (e4) return c.json({ error: 'load_failed', reason: e4.message }, 500);
    for (const d of (data ?? []) as Row[]) doById.set(String(d.id), d);
  }
  const soDocs = [...new Set([...doById.values()].map((d) => str(d.so_doc_no)).filter((x): x is string => !!x))];
  const linesBySo = new Map<string, SetLine[]>();
  const zoneBySo = new Map<string, string | null>();
  const addressBySo = new Map<string, string>();
  if (soDocs.length) {
    const [{ data: lineRows, error: e5 }, { data: soRows, error: e6 }] = await Promise.all([
      scopeToAllowedCompanies(sb.from('mfg_sales_order_items').select('doc_no, item_group, qty, cancelled'), c).in('doc_no', soDocs),
      scopeToAllowedCompanies(sb.from('mfg_sales_orders').select('doc_no, postcode, address1, address2'), c).in('doc_no', soDocs),
    ]);
    if (e5 || e6) return c.json({ error: 'load_failed', reason: (e5 ?? e6)!.message }, 500);
    for (const l of (lineRows ?? []) as Row[]) {
      const arr = linesBySo.get(String(l.doc_no)) ?? [];
      const g = String(l.item_group ?? '').toUpperCase();
      arr.push({
        category: g.includes('BEDFRAME') ? 'BEDFRAME' : g.includes('SOFA') ? 'SOFA' : g.includes('MATTRESS') ? 'MATTRESS' : 'OTHERS',
        qty: Number(l.qty ?? 1), cancelled: l.cancelled === true,
      });
      linesBySo.set(String(l.doc_no), arr);
    }
    for (const so of (soRows ?? []) as Row[]) {
      addressBySo.set(String(so.doc_no), [str(so.address1), str(so.address2), str(so.postcode)].filter(Boolean).join(' '));
      zoneBySo.set(String(so.doc_no), zoneForAddress({ postcode: str(so.postcode), address1: str(so.address1), address2: str(so.address2) }, [...DEFAULT_ZONE_PREFIX_MAP]).zone);
    }
  }

  const codes = companyCodeMap(c);
  const out = rows.map((r) => {
    const d = doById.get(String(r.do_id));
    const soDoc = d ? str(d.so_doc_no) : null;
    const carrierId = String(r.threepl_company_id);
    const card = specByCarrier.get(carrierId) ?? null;
    const billed = Number(r.billed_sen ?? 0);
    const expected = d && soDoc ? expectedSen(card?.spec ?? null, doFacts(linesBySo.get(soDoc) ?? [], zoneBySo.get(soDoc) ?? null, addressBySo.get(soDoc) ?? null)) : null;
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
    };
  });
  return c.json({ rows: out, invoices: invoiceTotals(out).map((t) => ({ ...t, carrierName: carrierName.get(t.carrierId) ?? null })) });
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
