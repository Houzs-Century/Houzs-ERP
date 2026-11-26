import { yymmFor } from '../../services/documentRefs';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { recordGrnCreate, resolveGrnFx, verifyGrnOverReceipt, recomputeGrnTotals } from '../routes/grns';
import { scopeToCompany, activeCompanyId, companyDocPrefix, stampCompany } from './companyScope';
import { isReceivablePo } from './source-document-gates';
import { isDocumentHeld } from './document-hold';
import { assertAuditWritable, auditUnavailableBody } from './entity-audit';
import { mintMonthlyDocNo } from './doc-no';
import { dateOrNull } from './date-coerce';
import { todayMyt } from './my-time';
import { normalizeAllocationMethod } from './landed-allocation';
import { assertForeignRatePostable } from './fx-guard';
import { effectiveDelivery } from '../shared';

export type GrnFromPoItemsContext = {
  req: { json(): Promise<unknown> };
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string };
  get(key: 'companyId'): number | undefined;
  get(key: 'allowedCompanyIds'): number[] | undefined;
  get(key: 'companyCode'): string | undefined;
};

export type DraftGrnFromPoItems = {
  id: string;
  grnNumber: string;
  companyId: number;
  primaryPoId: string;
  poIds: string[];
  poNumbers: string[];
  lineCount: number;
};

export type CreateDraftGrnsFromPoItemsResult =
  | { ok: true; created: DraftGrnFromPoItems[]; overReceipt: { poItemId: string; requested: number; remaining: number } | null }
  | { ok: false; status: ContentfulStatusCode; body: Record<string, unknown> };

export async function createDraftGrnsFromPoItemsCore(
  c: GrnFromPoItemsContext,
): Promise<CreateDraftGrnsFromPoItemsResult> {
  /* company-scope: the source load is scopeToCompany-filtered below, the header
     is stamped with the active company, and the only by-id write is the ROLLBACK
     of a header this core just inserted — no caller-supplied id is touched. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ poItemId: string; qty: number }>; notes?: string; receivedDate?: string; allocationMethod?: unknown; deliveryNoteRef?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return { ok: false, status: 400, body: { error: 'invalid_json' } }; }
  const picks = body.picks ?? [];
  if (picks.length === 0) return { ok: false, status: 400, body: { error: 'picks_required' } };

  const ids = picks.map((p) => p.poItemId);
  const { data: itemsData, error: itemsErr } = await scopeToCompany(sb
    .from('purchase_order_items')
    .select(`
      id, purchase_order_id, material_kind, item_code, material_name,
      item_group, description, description2, uom, qty, received_qty,
      unit_price_sen, variants, gap_inches, divan_height_inches, divan_price_sen,
      leg_height_inches, leg_price_sen, custom_specials, line_suffix,
      special_order_price_sen, discount_sen, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      po:purchase_orders!inner ( id, po_number, supplier_id, status, on_hold, purchase_location_id, currency )
    `)
    .in('id', ids), c);
  if (itemsErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: itemsErr.message } };

  type ItemRow = {
    id: string; purchase_order_id: string; material_kind: string; item_code: string;
    material_name: string; item_group: string | null; description: string | null;
    description2: string | null; uom: string | null;
    qty: number; received_qty: number; unit_price_sen: number;
    variants: unknown; gap_inches: number | null; divan_height_inches: number | null;
    divan_price_sen: number; leg_height_inches: number | null; leg_price_sen: number;
    custom_specials: unknown; line_suffix: string | null; special_order_price_sen: number;
    discount_sen: number; delivery_date: string | null;
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    po: { id: string; po_number: string; supplier_id: string; status: string; purchase_location_id: string | null; currency?: string | null };
  };

  const itemList = (itemsData ?? []) as unknown as ItemRow[];
  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  for (const p of picks) {
    const row = byId.get(p.poItemId);
    if (!row) return { ok: false, status: 400, body: { error: 'item_not_found', poItemId: p.poItemId } };
    if (p.qty <= 0) return { ok: false, status: 400, body: { error: 'qty_must_be_positive', poItemId: p.poItemId } };
    const remaining = row.qty - (row.received_qty ?? 0);
    if (p.qty > remaining) {
      return { ok: false, status: 409, body: { error: 'qty_exceeds_remaining', poItemId: p.poItemId, requested: p.qty, remaining } };
    }
    if (!isReceivablePo(row.po)) {
      return { ok: false, status: 409, body: { error: 'po_not_receivable', poItemId: p.poItemId, status: row.po.status, onHold: isDocumentHeld(row.po) } };
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return { ok: false, status: 409, body: auditUnavailableBody() as unknown as Record<string, unknown> };

  // Group picks by SUPPLIER → one GRN per supplier (Commander 2026-05-29:
  // "不同 supplier 不能 under 同一张 GRN" + "multi-select → 一张 GRN"). A
  // supplier's lines may span several POs; the GRN header references the first
  // PO (grns.purchase_order_id is single-FK) while each grn_item keeps its own
  // purchase_order_item_id, so received_qty still rolls up to EVERY source PO.
  type Bucket = { supplierId: string; primaryPoId: string; poIds: Set<string>; poNumbers: Set<string>; warehouseId: string | null; currency: string | null; lines: Array<{ row: ItemRow; qty: number }> };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.poItemId)!;
    const key = `${row.po.supplier_id}|${row.po.purchase_location_id ?? ''}`;
    const cur = buckets.get(key) ?? {
      supplierId: row.po.supplier_id, primaryPoId: row.po.id, poIds: new Set<string>(), poNumbers: new Set<string>(),
      warehouseId: row.po.purchase_location_id, currency: row.po.currency ?? null, lines: [],
    };
    cur.poIds.add(row.po.id);
    cur.poNumbers.add(row.po.po_number);
    cur.lines.push({ row, qty: p.qty });
    buckets.set(key, cur);
  }

  const yymm = yymmFor();
  const cp = companyDocPrefix(c);
  const firstNext = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
  let counter = parseInt(firstNext.slice(`${cp}GRN-${yymm}-`.length), 10) - 1;

  const receivedAt = dateOrNull(body.receivedDate) ?? todayMyt();
  const created: DraftGrnFromPoItems[] = [];
  let overReceipt: { poItemId: string; requested: number; remaining: number } | null = null;

  for (const bucket of buckets.values()) {
    const rateGuard = await assertForeignRatePostable(sb, { currency: bucket.currency ?? undefined, operatorRate: undefined, docLabel: 'GRN' });
    if (!rateGuard.ok) return { ok: false, status: 422, body: rateGuard.body as unknown as Record<string, unknown> };
  }

  for (const bucket of buckets.values()) {
    counter += 1;
    const bucketFx = await resolveGrnFx(sb, bucket.primaryPoId, bucket.currency ?? undefined, undefined);
    const grnPayload = {
      company_id: activeCompanyId(c),
      purchase_order_id: bucket.primaryPoId,
      supplier_id: bucket.supplierId,
      received_at: receivedAt,
      warehouse_id: bucket.warehouseId,
      currency: bucketFx.currency,
      exchange_rate: bucketFx.exchange_rate,
      allocation_method: normalizeAllocationMethod(body.allocationMethod),
      notes: body.notes
        ? `Received from ${[...bucket.poNumbers].join(', ')} · ${body.notes}`
        : `Received from ${[...bucket.poNumbers].join(', ')}`,
      delivery_note_ref: body.deliveryNoteRef?.trim() || null,
      created_by: user.id,
      status: 'DRAFT',
    };
    let h: { id: string; grn_number: string; company_id: number } | null = null;
    for (let attempt = 0; attempt < 8 && !h; attempt += 1) {
      const grnNumber = `${cp}GRN-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: header, error: hErr } = await sb.from('grns')
        .insert({ grn_number: grnNumber, ...grnPayload })
        .select('id, grn_number, company_id').single();
      if (!hErr && header) { h = header as unknown as { id: string; grn_number: string; company_id: number }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const liveNext = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
      counter = parseInt(liveNext.slice(`${cp}GRN-${yymm}-`.length), 10);
    }
    if (!h) continue;

    const rows = bucket.lines.map(({ row, qty }) => {
      const discountSen = row.discount_sen ?? 0;
      return {
        grn_id: h.id,
        purchase_order_item_id: row.id,
        material_kind: row.material_kind,
        item_code: row.item_code,
        material_name: row.material_name,
        qty_received: qty,
        qty_accepted: qty,
        qty_rejected: 0,
        unit_price_sen: row.unit_price_sen,
        line_total_sen: Math.max(0, (qty * row.unit_price_sen) - discountSen),
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
        discount_sen: discountSen,
        delivery_date: effectiveDelivery(
          row.delivery_date,
          row.supplier_delivery_date_2,
          row.supplier_delivery_date_3,
          row.supplier_delivery_date_4,
        ),
      };
    });
    const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('grns').delete().eq('id', h.id);
      continue;
    }
    const over = await verifyGrnOverReceipt(sb, h.id, bucket.lines.map(({ row }) => row.id));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      overReceipt = over;
      continue;
    }
    await recomputeGrnTotals(sb, h.id);
    created.push({
      id: h.id,
      grnNumber: h.grn_number,
      companyId: h.company_id,
      primaryPoId: bucket.primaryPoId,
      poIds: bucket.poIds.size ? [...bucket.poIds] : (bucket.primaryPoId ? [bucket.primaryPoId] : []),
      poNumbers: [...bucket.poNumbers],
      lineCount: bucket.lines.length,
    });
  }

  return { ok: true, created, overReceipt };
}

export async function createDraftGrnFromPoItems(
  env: Env,
  opts: {
    userId: string;
    houzsUserId?: number | null;
    companyId?: number | null;
    allowedCompanyIds?: number[] | null;
    companyCode?: string | null;
    picks: Array<{ poItemId: string; qty: number }>;
    notes?: string | null;
    receivedDate?: string | null;
    allocationMethod?: unknown;
    deliveryNoteRef: string | null;
  },
): Promise<CreateDraftGrnsFromPoItemsResult> {
  const svc = getSupabaseService(env);
  const syntheticGet = (key: string): unknown => {
    if (key === 'supabase') return svc;
    if (key === 'user') return { id: opts.userId };
    if (key === 'companyId') return opts.companyId ?? undefined;
    if (key === 'allowedCompanyIds') return opts.allowedCompanyIds ?? undefined;
    if (key === 'companyCode') return typeof opts.companyCode === 'string' ? opts.companyCode : undefined;
    return undefined;
  };
  const res = await createDraftGrnsFromPoItemsCore({
    req: { json: async () => ({ picks: opts.picks, notes: opts.notes ?? undefined, receivedDate: opts.receivedDate ?? undefined, allocationMethod: opts.allocationMethod, deliveryNoteRef: opts.deliveryNoteRef ?? undefined }) },
    get: syntheticGet as unknown as GrnFromPoItemsContext['get'],
  });
  if (res.ok) {
    const actor = opts.houzsUserId != null ? ({ id: opts.houzsUserId } as unknown as Variables['houzsUser']) : undefined;
    for (const draft of res.created) {
      await recordGrnCreate(svc, actor, opts.companyId ?? null, draft.id, draft.lineCount, `Received from ${draft.poNumbers.join(', ')}`);
    }
  }
  return res;
}
