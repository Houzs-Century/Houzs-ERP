/* ── Server-callable core: create DRAFT Purchase Invoice(s) by converting GRN lines ──
   The multi-select GRN->PI conversion — supplier+FX bucketing, doc-no minting,
   line mapping (discount pro-rate), post-insert over-invoice rollback — factored
   out of createPurchaseInvoicesFromGrnItemsHandler (routes/purchase-invoices.ts)
   so a caller with NO Hono request (the OCR scan-queue consumer) can raise the
   SAME draft the UI raises. The exact MIRROR of grn-from-po-core.ts (PR #4146):
   the HTTP route wires its real context through verbatim, and the headless entry
   below builds a synthetic one from Env.

   Lives in its own module (not purchase-invoices.ts) purely to keep that
   already-large route file under its size ceiling; the one private helper it
   reuses (verifyGrnLinesNotOverInvoiced) is imported back from
   purchase-invoices.ts, which is a runtime-safe cycle (every use is at call time).

   DRAFT-ONLY, by construction: this inserts the PI as status DRAFT / posted_at
   null and NEVER flips it to POSTED — so it books NO AP and consumes NO GRN qty
   (a DRAFT PI is excluded from both verifyGrnLinesNotOverInvoiced and
   recomputeGrnInvoiced). The auto-post the UI create performs — the status flip,
   recomputeGrnInvoiced, reallocatePiCharges, recostFromGrn, the AutoCount
   gr_to_pi transfer and the CREATE audit — all stays in the HTTP handler, after
   the core returns. Callers of this core (the scan queue) raise a draft for a
   human to confirm, and record their own CREATE.

   The over-invoice verify DOES force-count this draft (`countDraftPiId: h.id`),
   so it catches an over-billing pick at creation time exactly as the inline
   POSTED insert did — see verifyGrnLinesNotOverInvoiced's countDraftPiId note. */
import { yymmFor } from '../../services/documentRefs';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { verifyGrnLinesNotOverInvoiced } from '../routes/purchase-invoices';
import { scopeToCompany, activeCompanyId, companyDocPrefix, stampCompany } from './companyScope';
import { grnNotBillableRefusal } from './source-document-gates';
import { refuseMigratedSources, receiptMustMirrorAutoCount } from './migrated-chain';
import { MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT } from './migrated-receipts-not-invoiced.generated';
import { normalizeCurrency, normalizeExchangeRate } from './fx';
import { mintMonthlyDocNo } from './doc-no';
import { dateOrNull } from './date-coerce';
import { todayMyt } from './my-time';
import { withPoPriceSnapshot } from './pi-po-price';
import { recordPiCreate } from './pi-audit-trail';
import { duplicateBillRefusal, findDuplicateSupplierBill } from './duplicate-supplier-bill';

export type PiFromGrnItemsContext = {
  req: { json(): Promise<unknown> };
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string };
  get(key: 'companyId'): number | undefined;
  get(key: 'allowedCompanyIds'): number[] | undefined;
  get(key: 'companyCode'): string | undefined;
};

export type DraftPiFromGrnItems = {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  purchaseOrderId: string | null;
  grnIds: string[];
  grnNumbers: string[];
  grnItemIds: string[];
  lineCount: number;
};

export type CreateDraftPisFromGrnItemsResult =
  | { ok: true; created: DraftPiFromGrnItems[] }
  | { ok: false; status: ContentfulStatusCode; body: Record<string, unknown> };

/** A line billed by hand keeps the receipt's price. */
export const RECEIPT_PRICES: ReadonlyMap<string, number> = new Map();

/** `invoicePriceSen` is what the supplier printed, by GRN line: the scan's read
 *  (owner 2026-11-04: the invoice bills the supplier's price). It is a parameter,
 *  not a body field, so no request can set a price through the HTTP route, which
 *  posts what it creates. */
export async function createDraftPisFromGrnItemsCore(
  c: PiFromGrnItemsContext,
  invoicePriceSen: ReadonlyMap<string, number>,
  duplicateBill: 'refuse' | 'allow',
): Promise<CreateDraftPisFromGrnItemsResult> {
  /* company-scope: the only by-id write here is the ROLLBACK of the header this
     core just inserted, so that id is not caller-supplied. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: {
    picks?: Array<{ grnItemId: string; qty: number }>;
    supplierInvoiceNumber?: string;
    invoiceDate?: string;
    dueDate?: string;
    notes?: string;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return { ok: false, status: 400, body: { error: 'invalid_json' } }; }
  const picks = body.picks ?? [];
  if (picks.length === 0) return { ok: false, status: 400, body: { error: 'picks_required' } };

  const ids = picks.map((p) => p.grnItemId);
  const { data: itemsData, error: itemsErr } = await scopeToCompany(sb
    .from('grn_items')
    .select(`
      id, grn_id, material_kind, item_code, material_name, item_group,
      description, description2, uom, qty_accepted, invoiced_qty, returned_qty, unit_price_sen,
      variants, gap_inches, divan_height_inches, divan_price_sen,
      leg_height_inches, leg_price_sen, custom_specials, line_suffix,
      special_order_price_sen, discount_sen,
      grn:grns!inner ( id, grn_number, supplier_id, purchase_order_id, status, on_hold, currency, exchange_rate, migrated_no_stock, company_id )
    `)
    .in('id', ids), c);
  if (itemsErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: itemsErr.message } };

  type ItemRow = {
    id: string; grn_id: string; material_kind: string; item_code: string;
    material_name: string; item_group: string | null; description: string | null;
    description2: string | null; uom: string | null;
    qty_accepted: number; invoiced_qty: number; returned_qty: number; unit_price_sen: number;
    variants: unknown; gap_inches: number | null; divan_height_inches: number | null;
    divan_price_sen: number; leg_height_inches: number | null; leg_price_sen: number;
    custom_specials: unknown; line_suffix: string | null; special_order_price_sen: number;
    discount_sen: number;
    grn: { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; currency?: string | null; exchange_rate?: string | number | null; migrated_no_stock?: boolean | null; company_id?: number | null };
  };

  const itemList = (itemsData ?? []) as unknown as ItemRow[];
  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  {
    const refusal = refuseMigratedSources(itemList.map((r) => {
      const docNo = r.grn?.grn_number ?? r.grn_id;
      /* A migrated GRN AutoCount never invoiced is ordinary here (docs/bugs/0918);
         the allowlist is empty until the office measures, so this stays inert. */
      return {
        docNo,
        migrated: receiptMustMirrorAutoCount(
          { docNo, migrated: r.grn?.migrated_no_stock === true },
          MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT,
        ),
      };
    }));
    if (refusal) return { ok: false, status: 409, body: refusal as unknown as Record<string, unknown> };
  }

  for (const p of picks) {
    const row = byId.get(p.grnItemId);
    if (!row) return { ok: false, status: 400, body: { error: 'item_not_found', grnItemId: p.grnItemId } };
    if (p.qty <= 0) return { ok: false, status: 400, body: { error: 'qty_must_be_positive', grnItemId: p.grnItemId } };
    const remaining = (row.qty_accepted ?? 0) - (row.invoiced_qty ?? 0) - (row.returned_qty ?? 0);
    if (p.qty > remaining) {
      return { ok: false, status: 409, body: { error: 'qty_exceeds_remaining', grnItemId: p.grnItemId, requested: p.qty, remaining } };
    }
    { const nb = grnNotBillableRefusal(row.grn, { grnItemId: p.grnItemId }); if (nb) return { ok: false, status: 409, body: nb as unknown as Record<string, unknown> }; }
  }

  /* Group picks by SUPPLIER + currency + FX rate (owner 2026-08-06). One
     supplier invoice can cover several delivery notes, so notes no longer split
     the document — but currency/rate still must, since the PI header carries a
     single pair. grnIds/grnNumbers keep every note the group touches: the
     FIRST (by note number) becomes the header's primary grn_id, and all of them
     drive the notes text, the recost fan-out and the audit trail. */
  type Bucket = {
    grnIds: string[]; grnNumbers: string[];
    supplierId: string; purchaseOrderId: string | null;
    currency: string; exchangeRate: number;
    lines: Array<{ row: ItemRow; qty: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.grnItemId)!;
    const grnCur = normalizeCurrency(row.grn.currency);
    const rate = normalizeExchangeRate(row.grn.exchange_rate, grnCur);
    const key = `${row.grn.supplier_id}|${grnCur}|${rate}`;
    const cur = buckets.get(key) ?? {
      grnIds: [], grnNumbers: [],
      supplierId: row.grn.supplier_id,
      purchaseOrderId: row.grn.purchase_order_id,
      currency: grnCur, exchangeRate: rate,
      lines: [],
    };
    if (!cur.grnIds.includes(row.grn.id)) {
      cur.grnIds.push(row.grn.id);
      cur.grnNumbers.push(row.grn.grn_number);
    }
    cur.lines.push({ row, qty: p.qty });
    buckets.set(key, cur);
  }
  for (const b of buckets.values()) {
    const order = b.grnIds
      .map((id, i) => ({ id, no: b.grnNumbers[i]! }))
      .sort((x, y) => x.no.localeCompare(y.no));
    b.grnIds = order.map((o) => o.id);
    b.grnNumbers = order.map((o) => o.no);
  }

  const dupCompanyId = activeCompanyId(c);
  if (duplicateBill === 'refuse' && dupCompanyId != null) {
    for (const b of buckets.values()) {
      const dup = await findDuplicateSupplierBill(sb, 'purchase_invoices', { companyId: dupCompanyId, supplierId: b.supplierId, ref: body.supplierInvoiceNumber, excludeId: null, docKind: null });
      if (!dup.ok) return { ok: false, status: 500, body: { error: 'load_failed', reason: dup.reason } };
      if (dup.duplicate) return { ok: false, status: 409, body: duplicateBillRefusal(body.supplierInvoiceNumber, dup.duplicate) };
    }
  }

  const yymm = yymmFor();
  const cp = companyDocPrefix(c);
  const firstNext = await mintMonthlyDocNo(sb, 'purchase_invoices', 'invoice_number', `${cp}PI-${yymm}`);
  let counter = parseInt(firstNext.slice(`${cp}PI-${yymm}-`.length), 10) - 1;

  const invoiceDate = dateOrNull(body.invoiceDate) ?? todayMyt();
  const created: DraftPiFromGrnItems[] = [];

  const discFor = (row: ItemRow, qty: number) =>
    Math.round(Number(row.discount_sen ?? 0) * qty / (Number(row.qty_accepted) || 1));
  const priceOf = (row: ItemRow) => invoicePriceSen.get(row.id) ?? row.unit_price_sen;

  for (const bucket of buckets.values()) {
    counter += 1;
    const subtotal = bucket.lines.reduce((s, { row, qty }) => s + Math.max(0, qty * priceOf(row) - discFor(row, qty)), 0);
    const piPayload = {
      company_id: activeCompanyId(c),
      supplier_invoice_ref: body.supplierInvoiceNumber ?? null,
      supplier_id: bucket.supplierId,
      purchase_order_id: bucket.purchaseOrderId,
      grn_id: bucket.grnIds[0]!,
      invoice_date: invoiceDate,
      due_date: dateOrNull(body.dueDate),
      currency: bucket.currency,
      exchange_rate: bucket.exchangeRate,
      subtotal_sen: subtotal,
      tax_sen: 0,
      total_sen: subtotal,
      status: 'DRAFT',
      posted_at: null,
      notes: (() => {
        const from = `Multi-pick from ${bucket.grnNumbers.join(', ')}`;
        return body.notes ? `${from} · ${body.notes}` : from;
      })(),
      created_by: user.id,
    };
    let h: { id: string; invoice_number: string } | null = null;
    for (let attempt = 0; attempt < 8 && !h; attempt += 1) {
      const invoiceNumber = `${cp}PI-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: header, error: hErr } = await sb.from('purchase_invoices')
        .insert({ invoice_number: invoiceNumber, ...piPayload })
        .select('id, invoice_number').single();
      if (!hErr && header) { h = header as unknown as { id: string; invoice_number: string }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const liveNext = await mintMonthlyDocNo(sb, 'purchase_invoices', 'invoice_number', `${cp}PI-${yymm}`);
      counter = parseInt(liveNext.slice(`${cp}PI-${yymm}-`.length), 10);
    }
    if (!h) continue;

    const rows = bucket.lines.map(({ row, qty }) => ({
      purchase_invoice_id: h.id,
      grn_item_id: row.id,
      material_kind: row.material_kind,
      item_code: row.item_code,
      material_name: row.material_name,
      qty,
      unit_price_sen: priceOf(row),
      line_total_sen: Math.max(0, qty * priceOf(row) - discFor(row, qty)),
      item_group: row.item_group,
      description: row.description,
      description2: row.description2,
      uom: row.uom ?? 'UNIT',
      variants: row.variants,
      gap_inches: row.gap_inches,
      divan_height_inches: row.divan_height_inches,
      divan_price_sen: row.divan_price_sen ?? 0,
      leg_height_inches: row.leg_height_inches,
      leg_price_sen: row.leg_price_sen ?? 0,
      custom_specials: row.custom_specials,
      line_suffix: row.line_suffix,
      special_order_price_sen: row.special_order_price_sen ?? 0,
      discount_sen: discFor(row, qty),
    }));
    const { error: iErr } = await withPoPriceSnapshot(sb, rows, () => sb.from('purchase_invoice_items').insert(stampCompany(rows, c)));
    if (iErr) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      continue;
    }
    {
      const verify = await verifyGrnLinesNotOverInvoiced(sb, bucket.lines.map(({ row }) => row.id), h.id);
      // eslint-disable-next-line no-console
      if (verify.error) console.error(`[pi over-invoice verify] ${h.id}: ${verify.error}`);
      const over = verify.over;
      if (over.length > 0) {
        await sb.from('purchase_invoices').delete().eq('id', h.id);
        continue;
      }
    }
    created.push({
      id: h.id,
      invoiceNumber: h.invoice_number,
      supplierId: bucket.supplierId,
      purchaseOrderId: bucket.purchaseOrderId,
      grnIds: bucket.grnIds,
      grnNumbers: bucket.grnNumbers,
      grnItemIds: bucket.lines.map(({ row }) => row.id),
      lineCount: bucket.lines.length,
    });
  }

  return { ok: true, created };
}

export async function createDraftPiFromGrnItems(
  env: Env,
  opts: {
    userId: string;
    houzsUserId?: number | null;
    companyId?: number | null;
    allowedCompanyIds?: number[] | null;
    companyCode?: string | null;
    picks: Array<{ grnItemId: string; qty: number; unitPriceSen: number | null }>;
    supplierInvoiceNumber?: string | null;
    invoiceDate?: string | null;
    dueDate?: string | null;
    notes?: string | null;
    duplicateBill: 'refuse' | 'allow';
  },
): Promise<CreateDraftPisFromGrnItemsResult> {
  const svc = getSupabaseService(env);
  const syntheticGet = (key: string): unknown => {
    if (key === 'supabase') return svc;
    if (key === 'user') return { id: opts.userId };
    if (key === 'companyId') return opts.companyId ?? undefined;
    if (key === 'allowedCompanyIds') return opts.allowedCompanyIds ?? undefined;
    if (key === 'companyCode') return typeof opts.companyCode === 'string' ? opts.companyCode : undefined;
    return undefined;
  };
  const res = await createDraftPisFromGrnItemsCore({
    req: { json: async () => ({
      picks: opts.picks.map(({ grnItemId, qty }) => ({ grnItemId, qty })),
      supplierInvoiceNumber: opts.supplierInvoiceNumber ?? undefined,
      invoiceDate: opts.invoiceDate ?? undefined,
      dueDate: opts.dueDate ?? undefined,
      notes: opts.notes ?? undefined,
    }) },
    get: syntheticGet as unknown as PiFromGrnItemsContext['get'],
  }, new Map(opts.picks.flatMap((p) => (p.unitPriceSen == null ? [] : [[p.grnItemId, p.unitPriceSen] as const]))), opts.duplicateBill);
  if (res.ok) {
    const actor = opts.houzsUserId != null ? ({ id: opts.houzsUserId } as unknown as Variables['houzsUser']) : undefined;
    for (const draft of res.created) {
      await recordPiCreate(svc, actor, opts.companyId ?? null, draft.id, draft.lineCount, `Converted from Goods Receipt ${draft.grnNumbers.join(', ')}`);
    }
  }
  return res;
}
