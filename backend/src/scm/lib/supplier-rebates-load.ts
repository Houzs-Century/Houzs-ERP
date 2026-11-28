// ----------------------------------------------------------------------------
// supplier-rebates-load — what a supplier rebate rule reads (lib/supplier-rebates.ts),
// every read the company's own: the supplier's bills dated in the range, line by
// line — purchase invoices and AP invoices, neither cancelled nor draft — its
// display-discount credit notes posted in the range (owner 2026-11-27: 「这个减的就是
// display set」), and, when the rule has a display discount, its discounted PO lines
// on POs dated in the range, neither cancelled nor draft (owner 2026-11-28).
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from './paginate-all';
import { rebateLineKind, type RebateDisplayNote, type RebatePoLine, type RebatePurchaseLine, type SupplierRebateRule } from './supplier-rebates';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the scm lib layer */
type Db = any;
type Row = Record<string, any>;

export type RebateInputs = { lines: RebatePurchaseLine[]; notes: RebateDisplayNote[]; poLines: RebatePoLine[] };
type Loaded = { ok: true; inputs: RebateInputs } | { ok: false; reason: string };

const LEFT_OUT = new Set(['CANCELLED', 'DRAFT']);
const live = (r: Row): boolean => !LEFT_OUT.has(String(r.status ?? '').toUpperCase());
const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);
const failed = (what: string, r: { error: { message: string } | null; truncated: boolean }): string | null =>
  (r.error ? `${what}: ${r.error.message}` : r.truncated ? `${what}: more rows than one read takes` : null);

async function loadPoLines(sb: Db, companyId: number, ids: string[], from: string, to: string): Promise<{ ok: true; poLines: RebatePoLine[] } | { ok: false; reason: string }> {
  const pos = await chunkIn<Row>(ids, (b, lo, hi) => sb.from('purchase_orders').select('id, po_number, po_date, status')
    .eq('company_id', companyId).in('supplier_id', b).gte('po_date', from).lte('po_date', to).order('id').range(lo, hi));
  const posFail = failed('purchase orders', pos);
  if (posFail) return { ok: false, reason: posFail };
  const poById = new Map(pos.data.filter(live).map((p) => [String(p.id), p] as const));
  const items = await chunkIn<Row>([...poById.keys()], (b, lo, hi) => sb.from('purchase_order_items')
    .select('id, purchase_order_id, item_code, material_name, qty, unit_price_sen, discount_sen')
    .eq('company_id', companyId).in('purchase_order_id', b).gt('discount_sen', 0).order('id').range(lo, hi));
  const itemsFail = failed('purchase order lines', items);
  if (itemsFail) return { ok: false, reason: itemsFail };
  const poLines: RebatePoLine[] = [];
  for (const i of items.data) {
    const po = poById.get(String(i.purchase_order_id));
    if (!po) continue;
    const day = dayOf(po.po_date);
    poLines.push({
      id: String(i.id), month: day.slice(0, 7), day, poNo: String(po.po_number ?? ''),
      text: [i.item_code, i.material_name].map((v) => String(v ?? '').trim()).filter(Boolean).join(' '),
      grossSen: Number(i.qty ?? 0) * Number(i.unit_price_sen ?? 0), discountSen: Number(i.discount_sen ?? 0),
    });
  }
  return { ok: true, poLines };
}

/** The rule's supplier's bills, display notes and (with a display discount) discounted PO lines in [from, to]. */
export async function loadRebateInputs(sb: Db, companyId: number, rule: SupplierRebateRule, from: string, to: string): Promise<Loaded> {
  const sup = await paginateAll<Row>((lo, hi) => sb.from('suppliers').select('id')
    .eq('company_id', companyId).eq('code', rule.supplierCode).order('id').range(lo, hi));
  const supFail = failed('suppliers', { error: sup.error, truncated: sup.truncated });
  if (supFail) return { ok: false, reason: supFail };
  const ids = (sup.data ?? []).map((s) => String(s.id));
  if (ids.length === 0) return { ok: true, inputs: { lines: [], notes: [], poLines: [] } };

  const [pis, aps, notes, po] = await Promise.all([
    chunkIn<Row>(ids, (b, lo, hi) => sb.from('purchase_invoices').select('id, invoice_number, invoice_date, status')
      .eq('company_id', companyId).in('supplier_id', b).gte('invoice_date', from).lte('invoice_date', to).order('id').range(lo, hi)),
    chunkIn<Row>(ids, (b, lo, hi) => sb.from('ap_invoices').select('id, invoice_number, invoice_date, status')
      .eq('company_id', companyId).in('supplier_id', b).gte('invoice_date', from).lte('invoice_date', to).order('id').range(lo, hi)),
    chunkIn<Row>(ids, (b, lo, hi) => sb.from('acc_credit_notes').select('id, note_number, note_date, total_sen')
      .eq('company_id', companyId).eq('kind', 'SCN').eq('status', 'POSTED').in('supplier_id', b)
      .gte('note_date', from).lte('note_date', to).ilike('reason', '%display%').order('id').range(lo, hi)),
    rule.displayDiscountBp > 0 ? loadPoLines(sb, companyId, ids, from, to) : Promise.resolve({ ok: true as const, poLines: [] }),
  ]);
  for (const [what, r] of [['purchase invoices', pis], ['AP invoices', aps], ['credit notes', notes]] as const) {
    const f = failed(what, r);
    if (f) return { ok: false, reason: f };
  }
  if (!po.ok) return { ok: false, reason: po.reason };
  const piById = new Map(pis.data.filter(live).map((p) => [String(p.id), p] as const));
  const apById = new Map(aps.data.filter(live).map((a) => [String(a.id), a] as const));

  const [items, apLines] = await Promise.all([
    chunkIn<Row>([...piById.keys()], (b, lo, hi) => sb.from('purchase_invoice_items')
      .select('id, purchase_invoice_id, item_code, material_name, description, line_total_sen')
      .eq('company_id', companyId).in('purchase_invoice_id', b).order('id').range(lo, hi)),
    chunkIn<Row>([...apById.keys()], (b, lo, hi) => sb.from('ap_invoice_lines').select('id, invoice_id, description, amount_sen')
      .eq('company_id', companyId).in('invoice_id', b).order('id').range(lo, hi)),
  ]);
  for (const [what, r] of [['purchase invoice lines', items], ['AP invoice lines', apLines]] as const) {
    const f = failed(what, r);
    if (f) return { ok: false, reason: f };
  }
  const codes = [...new Set(items.data.map((i) => String(i.item_code ?? '').trim()).filter(Boolean))];
  const prods = await chunkIn<Row>(codes, (b, lo, hi) => sb.from('mfg_products').select('code, category')
    .eq('company_id', companyId).in('code', b).order('code').range(lo, hi));
  const prodFail = failed('products', prods);
  if (prodFail) return { ok: false, reason: prodFail };
  const categoryOf = new Map(prods.data.map((p) => [String(p.code), p.category == null ? null : String(p.category)] as const));

  const lines: RebatePurchaseLine[] = [];
  for (const i of items.data) {
    const pi = piById.get(String(i.purchase_invoice_id));
    if (!pi) continue;
    const day = dayOf(pi.invoice_date);
    const code = String(i.item_code ?? '').trim();
    const text = [i.item_code, i.material_name, i.description].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
    lines.push({
      month: day.slice(0, 7), day, docNo: String(pi.invoice_number ?? ''), text, sen: Number(i.line_total_sen ?? 0),
      kind: rebateLineKind(rule, text, code ? categoryOf.get(code) ?? null : null),
    });
  }
  for (const l of apLines.data) {
    const ap = apById.get(String(l.invoice_id));
    if (!ap) continue;
    const day = dayOf(ap.invoice_date);
    const text = String(l.description ?? '').trim();
    lines.push({ month: day.slice(0, 7), day, docNo: String(ap.invoice_number ?? ''), text, sen: Number(l.amount_sen ?? 0), kind: rebateLineKind(rule, text, null) });
  }
  return {
    ok: true,
    inputs: {
      lines,
      notes: notes.data.map((n) => {
        const day = dayOf(n.note_date);
        return { month: day.slice(0, 7), day, noteNo: String(n.note_number ?? ''), sen: Number(n.total_sen ?? 0) };
      }),
      poLines: po.poLines,
    },
  };
}
